package config

import (
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"
)

const devDSN = "postgres://auth:auth@localhost:5433/auth?sslmode=disable"
const tlsDSN = "postgres://auth:s3cret@db.internal:5432/auth?sslmode=verify-full"

func load(t *testing.T, env map[string]string, files map[string]string) (Config, error) {
	t.Helper()
	return LoadFrom(
		func(k string) string { return env[k] },
		func(p string) ([]byte, error) {
			if v, ok := files[p]; ok {
				return []byte(v), nil
			}
			return nil, fs.ErrNotExist
		},
	)
}

func TestDefaults(t *testing.T) {
	c, err := load(t, map[string]string{"DATABASE_URL": devDSN}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.Env != EnvDevelopment || c.Addr != ":8080" || c.BcryptCost != 12 ||
		c.SessionTTL != 24*time.Hour || !c.CookieSecure || c.ShutdownTimeout != 10*time.Second {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestDatabaseURLRequired(t *testing.T) {
	if _, err := load(t, nil, nil); err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("want DATABASE_URL error, got %v", err)
	}
}

func TestSecretFromFile(t *testing.T) {
	c, err := load(t,
		map[string]string{"DATABASE_URL_FILE": "/run/secrets/database_url"},
		map[string]string{"/run/secrets/database_url": devDSN + "\n"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if c.DatabaseURL != devDSN {
		t.Fatalf("got %q (trailing newline must be trimmed)", c.DatabaseURL)
	}
}

func TestSecretFileErrors(t *testing.T) {
	_, err := load(t, map[string]string{"DATABASE_URL_FILE": "/missing"}, nil)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing file: got %v", err)
	}
	_, err = load(t, map[string]string{"DATABASE_URL": devDSN, "DATABASE_URL_FILE": "/x"},
		map[string]string{"/x": devDSN})
	if err == nil || !strings.Contains(err.Error(), "only one") {
		t.Fatalf("both set: got %v", err)
	}
}

func TestInvalidValues(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"env":         {"APP_ENV": "qa"},
		"cost-low":    {"BCRYPT_COST": "4"},
		"cost-nan":    {"BCRYPT_COST": "x"},
		"ttl":         {"SESSION_TTL": "-1h"},
		"ttl-parse":   {"SESSION_TTL": "forever"},
		"cookie-bool": {"COOKIE_SECURE": "maybe"},
	} {
		env["DATABASE_URL"] = devDSN
		if _, err := load(t, env, nil); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestDeployedBaseline(t *testing.T) {
	base := func(env string) map[string]string {
		return map[string]string{"APP_ENV": env, "DATABASE_URL": tlsDSN}
	}
	for _, env := range []string{EnvStaging, EnvProduction} {
		if _, err := load(t, base(env), nil); err != nil {
			t.Fatalf("%s: secure config rejected: %v", env, err)
		}
		cases := map[string]map[string]string{
			"cookie": {"COOKIE_SECURE": "false"},
			"cost":   {"BCRYPT_COST": "10"},
			"tls":    {"DATABASE_URL": devDSN},
			"no-ssl": {"DATABASE_URL": "postgres://u:p@h/db"},
		}
		for name, over := range cases {
			e := base(env)
			for k, v := range over {
				e[k] = v
			}
			if _, err := load(t, e, nil); err == nil {
				t.Errorf("%s/%s: expected rejection", env, name)
			}
		}
		e := base(env)
		e["DATABASE_URL"], e["DB_ALLOW_INSECURE"] = devDSN, "true"
		if _, err := load(t, e, nil); err != nil {
			t.Errorf("%s: DB_ALLOW_INSECURE should permit sslmode=disable: %v", env, err)
		}
	}
	// development keeps the relaxed local defaults
	if _, err := load(t, map[string]string{"DATABASE_URL": devDSN, "COOKIE_SECURE": "false", "BCRYPT_COST": "10"}, nil); err != nil {
		t.Fatalf("development: %v", err)
	}
}

func TestRedact(t *testing.T) {
	c := Config{DatabaseURL: tlsDSN}
	if s := c.LogValue().String(); strings.Contains(s, "s3cret") {
		t.Fatalf("password leaked in log value: %s", s)
	}
}
