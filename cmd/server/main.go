// Command server runs the Secure Authentication Service.
//
// `server -healthcheck` probes a running instance's /healthz and exits 0/1; the
// distroless image has no shell or curl, so container healthchecks use it.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/engineeringos/authservice/internal/auth"
	"github.com/engineeringos/authservice/internal/config"
	"github.com/engineeringos/authservice/internal/db"
	"github.com/engineeringos/authservice/internal/store"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe /healthz of the local instance and exit")
	flag.Parse()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))

	if *healthcheck {
		if err := probe(os.Getenv("ADDR")); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	slog.Info("starting", "config", cfg)

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	srv := auth.NewServer(store.NewPostgres(pool), auth.Config{
		BcryptCost: cfg.BcryptCost, SessionTTL: cfg.SessionTTL, CookieSecure: cfg.CookieSecure,
	})
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           routes(srv.Routes(), pool.Ping),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		httpSrv.Shutdown(shutdownCtx) //nolint:errcheck
	}()
	slog.Info("listening", "addr", httpSrv.Addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// routes adds GET /readyz (database reachable) in front of the API handler.
// /healthz (process alive) is served by the API itself.
func routes(api http.Handler, ping func(context.Context) error) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := ping(ctx); err != nil {
			slog.Warn("readiness check failed", "err", err)
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("/", api)
	return mux
}

// probe GETs /healthz on the loopback interface for the given listen address.
func probe(addr string) error {
	if addr == "" {
		addr = ":8080"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/healthz")
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz: status %d", resp.StatusCode)
	}
	return nil
}
