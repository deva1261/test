// Package config loads and validates the service configuration from the
// environment. Secrets may be supplied directly (DATABASE_URL) or as a path to
// a mounted secret file (DATABASE_URL_FILE), which is how Docker / Kubernetes
// secrets and CI-provisioned credentials reach the process.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/engineeringos/authservice/internal/auth"
)

// Environments the service knows about. Staging and production are "deployed"
// environments and get the strict checks in Validate.
const (
	EnvDevelopment = "development"
	EnvStaging     = "staging"
	EnvProduction  = "production"
)

// Config is the fully resolved runtime configuration.
type Config struct {
	Env             string
	Addr            string
	DatabaseURL     string // secret: never log it, use LogValue
	BcryptCost      int
	SessionTTL      time.Duration
	CookieSecure    bool
	DBAllowInsecure bool // permit sslmode=disable in deployed environments
	ShutdownTimeout time.Duration
}

// Deployed reports whether the environment is staging or production.
func (c Config) Deployed() bool {
	return c.Env == EnvStaging || c.Env == EnvProduction
}

// Load reads the configuration from the process environment.
func Load() (Config, error) {
	return LoadFrom(os.Getenv, os.ReadFile)
}

// LoadFrom reads the configuration through the given lookups (for tests).
func LoadFrom(getenv func(string) string, readFile func(string) ([]byte, error)) (Config, error) {
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	var errs []error
	c := Config{
		Env:  strings.ToLower(get("APP_ENV", EnvDevelopment)),
		Addr: get("ADDR", ":8080"),
	}

	dsn, err := secret(getenv, readFile, "DATABASE_URL")
	errs = append(errs, err)
	c.DatabaseURL = dsn

	c.BcryptCost, err = strconv.Atoi(get("BCRYPT_COST", strconv.Itoa(auth.DefaultBcryptCost)))
	if err != nil {
		errs = append(errs, fmt.Errorf("BCRYPT_COST: %w", err))
	}
	c.SessionTTL, err = time.ParseDuration(get("SESSION_TTL", "24h"))
	if err != nil {
		errs = append(errs, fmt.Errorf("SESSION_TTL: %w", err))
	}
	c.ShutdownTimeout, err = time.ParseDuration(get("SHUTDOWN_TIMEOUT", "10s"))
	if err != nil {
		errs = append(errs, fmt.Errorf("SHUTDOWN_TIMEOUT: %w", err))
	}
	c.CookieSecure, err = strconv.ParseBool(get("COOKIE_SECURE", "true"))
	if err != nil {
		errs = append(errs, fmt.Errorf("COOKIE_SECURE: %w", err))
	}
	c.DBAllowInsecure, err = strconv.ParseBool(get("DB_ALLOW_INSECURE", "false"))
	if err != nil {
		errs = append(errs, fmt.Errorf("DB_ALLOW_INSECURE: %w", err))
	}
	if err := errors.Join(errs...); err != nil {
		return Config{}, err
	}
	return c, c.Validate()
}

// Validate enforces invariants; staging and production are held to the
// security baseline (Secure cookies, bcrypt cost >= 12, TLS to Postgres).
func (c Config) Validate() error {
	var errs []error
	switch c.Env {
	case EnvDevelopment, EnvStaging, EnvProduction:
	default:
		errs = append(errs, fmt.Errorf("APP_ENV %q: want development, staging or production", c.Env))
	}
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL or DATABASE_URL_FILE is required"))
	} else if _, err := url.Parse(c.DatabaseURL); err != nil {
		errs = append(errs, errors.New("DATABASE_URL is not a valid URL"))
	}
	if c.BcryptCost < auth.MinBcryptCost || c.BcryptCost > 31 {
		errs = append(errs, fmt.Errorf("BCRYPT_COST %d: want %d..31", c.BcryptCost, auth.MinBcryptCost))
	}
	if c.SessionTTL <= 0 {
		errs = append(errs, errors.New("SESSION_TTL must be positive"))
	}
	if c.ShutdownTimeout <= 0 {
		errs = append(errs, errors.New("SHUTDOWN_TIMEOUT must be positive"))
	}
	if c.Deployed() {
		if !c.CookieSecure {
			errs = append(errs, fmt.Errorf("COOKIE_SECURE must be true in %s", c.Env))
		}
		if c.BcryptCost < auth.DefaultBcryptCost {
			errs = append(errs, fmt.Errorf("BCRYPT_COST must be >= %d in %s", auth.DefaultBcryptCost, c.Env))
		}
		if !c.DBAllowInsecure && sslDisabled(c.DatabaseURL) {
			errs = append(errs, fmt.Errorf("DATABASE_URL must use TLS (sslmode=require or stricter) in %s; set DB_ALLOW_INSECURE=true only for a private-network database", c.Env))
		}
	}
	return errors.Join(errs...)
}

// LogValue renders the config for logs with the database password redacted.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("env", c.Env),
		slog.String("addr", c.Addr),
		slog.String("database_url", Redact(c.DatabaseURL)),
		slog.Int("bcrypt_cost", c.BcryptCost),
		slog.Duration("session_ttl", c.SessionTTL),
		slog.Bool("cookie_secure", c.CookieSecure),
	)
}

// Redact hides the password of a postgres URL.
func Redact(dsn string) string {
	u, err := url.Parse(dsn)
	if err != nil {
		return "<invalid>"
	}
	return u.Redacted()
}

// secret reads KEY or the file named by KEY_FILE; setting both is an error so
// a stale plain value can never shadow the mounted secret silently.
func secret(getenv func(string) string, readFile func(string) ([]byte, error), key string) (string, error) {
	val, path := getenv(key), strings.TrimSpace(getenv(key+"_FILE"))
	if path == "" {
		return strings.TrimSpace(val), nil
	}
	if val != "" {
		return "", fmt.Errorf("set only one of %s and %s_FILE", key, key)
	}
	b, err := readFile(path)
	if err != nil {
		return "", fmt.Errorf("%s_FILE: %w", key, err)
	}
	return strings.TrimSpace(string(b)), nil
}

func sslDisabled(dsn string) bool {
	u, err := url.Parse(dsn)
	if err != nil {
		return true
	}
	mode := u.Query().Get("sslmode")
	return mode == "" || mode == "disable" || mode == "allow" || mode == "prefer"
}
