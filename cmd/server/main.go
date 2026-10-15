// Command server runs the Secure Authentication Service.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/engineeringos/authservice/internal/auth"
	"github.com/engineeringos/authservice/internal/db"
	"github.com/engineeringos/authservice/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	cost, err := strconv.Atoi(env("BCRYPT_COST", strconv.Itoa(auth.DefaultBcryptCost)))
	if err != nil {
		return err
	}
	ttl, err := time.ParseDuration(env("SESSION_TTL", "24h"))
	if err != nil {
		return err
	}
	secure := env("COOKIE_SECURE", "true") != "false"

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	srv := auth.NewServer(store.NewPostgres(pool), auth.Config{
		BcryptCost: cost, SessionTTL: ttl, CookieSecure: secure,
	})
	httpSrv := &http.Server{
		Addr:              env("ADDR", ":8080"),
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		httpSrv.Shutdown(shutdownCtx) //nolint:errcheck
	}()
	slog.Info("listening", "addr", httpSrv.Addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
