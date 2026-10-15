// Package store is the auth-db component (CMP-003): persistence for users
// and sessions. Postgres is the production implementation; Memory is an
// in-process implementation with the same constraint semantics, used by
// handler tests.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrNotFound is returned when no row matches the lookup.
	ErrNotFound = errors.New("store: not found")
	// ErrEmailTaken is returned when inserting a user whose email already exists.
	ErrEmailTaken = errors.New("store: email already exists")
	// ErrTokenTaken is returned when inserting a session whose token_hash already exists.
	ErrTokenTaken = errors.New("store: token hash already exists")
	// ErrUserMissing is returned when inserting a session for a user that does not exist.
	ErrUserMissing = errors.New("store: user does not exist")
)

// User is ENT-001, table users.
type User struct {
	ID           uuid.UUID `json:"id"`
	Name         string    `json:"name"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"` // never serialised to clients
	CreatedAt    time.Time `json:"created_at"`
}

// Session is ENT-002, table sessions.
type Session struct {
	ID        uuid.UUID `json:"id"`
	UserID    uuid.UUID `json:"user_id"`
	TokenHash string    `json:"token_hash"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// Store is the query surface auth-api needs from auth-db.
type Store interface {
	CreateUser(ctx context.Context, u *User) error
	GetUserByEmail(ctx context.Context, email string) (*User, error)
	GetUserByID(ctx context.Context, id uuid.UUID) (*User, error)
	CreateSession(ctx context.Context, s *Session) error
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (*Session, error)
	DeleteSessionByTokenHash(ctx context.Context, tokenHash string) error
}
