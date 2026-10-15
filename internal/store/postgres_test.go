package store_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/engineeringos/authservice/internal/db"
	"github.com/engineeringos/authservice/internal/store"
)

// newPostgres connects to TEST_DATABASE_URL (skipping when unset), applies
// migrations and empties the tables. The database is used exclusively by tests.
func newPostgres(t *testing.T) *store.Postgres {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping Postgres integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	// Running twice must be a no-op.
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `truncate users, sessions`); err != nil {
		t.Fatal(err)
	}
	return store.NewPostgres(pool)
}

// Both implementations must enforce the same constraints.
func stores(t *testing.T) map[string]store.Store {
	return map[string]store.Store{"memory": store.NewMemory(), "postgres": newPostgresOrNil(t)}
}

func newPostgresOrNil(t *testing.T) store.Store {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		return nil
	}
	return newPostgres(t)
}

func TestStoreConstraints(t *testing.T) {
	for name, s := range stores(t) {
		t.Run(name, func(t *testing.T) {
			if s == nil {
				t.Skip("TEST_DATABASE_URL not set")
			}
			ctx := context.Background()
			u := &store.User{ID: uuid.New(), Name: "Ada", Email: "ada@example.com", PasswordHash: "$2a$12$x"}
			if err := s.CreateUser(ctx, u); err != nil {
				t.Fatal(err)
			}
			if u.CreatedAt.IsZero() {
				t.Fatal("created_at not set")
			}
			dup := &store.User{ID: uuid.New(), Name: "Other", Email: "ada@example.com", PasswordHash: "$2a$12$y"}
			if err := s.CreateUser(ctx, dup); !errors.Is(err, store.ErrEmailTaken) {
				t.Fatalf("duplicate email: got %v", err)
			}

			got, err := s.GetUserByEmail(ctx, "ada@example.com")
			if err != nil || got.ID != u.ID || got.PasswordHash != u.PasswordHash {
				t.Fatalf("GetUserByEmail: %+v %v", got, err)
			}
			if _, err := s.GetUserByID(ctx, uuid.New()); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("GetUserByID missing: %v", err)
			}

			sess := &store.Session{ID: uuid.New(), UserID: u.ID, TokenHash: "h1", ExpiresAt: time.Now().Add(time.Hour)}
			if err := s.CreateSession(ctx, sess); err != nil {
				t.Fatal(err)
			}
			dupTok := &store.Session{ID: uuid.New(), UserID: u.ID, TokenHash: "h1", ExpiresAt: time.Now().Add(time.Hour)}
			if err := s.CreateSession(ctx, dupTok); !errors.Is(err, store.ErrTokenTaken) {
				t.Fatalf("duplicate token hash: got %v", err)
			}
			orphan := &store.Session{ID: uuid.New(), UserID: uuid.New(), TokenHash: "h2", ExpiresAt: time.Now().Add(time.Hour)}
			if err := s.CreateSession(ctx, orphan); !errors.Is(err, store.ErrUserMissing) {
				t.Fatalf("FK violation: got %v", err)
			}

			gs, err := s.GetSessionByTokenHash(ctx, "h1")
			if err != nil || gs.UserID != u.ID {
				t.Fatalf("GetSessionByTokenHash: %+v %v", gs, err)
			}
			if err := s.DeleteSessionByTokenHash(ctx, "h1"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.GetSessionByTokenHash(ctx, "h1"); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("after delete: %v", err)
			}
			if err := s.DeleteSessionByTokenHash(ctx, "h1"); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("double delete: %v", err)
			}
		})
	}
}
