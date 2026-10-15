package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres implements Store on a pgx connection pool.
type Postgres struct {
	Pool *pgxpool.Pool
}

func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{Pool: pool} }

// mapConstraint translates Postgres constraint violations into store errors.
func mapConstraint(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.ConstraintName {
	case "users_email_key":
		return ErrEmailTaken
	case "sessions_token_hash_key":
		return ErrTokenTaken
	case "sessions_user_id_fkey":
		return ErrUserMissing
	}
	return err
}

func (p *Postgres) CreateUser(ctx context.Context, u *User) error {
	err := p.Pool.QueryRow(ctx,
		`insert into users (id, name, email, password_hash) values ($1, $2, $3, $4)
		 returning created_at`,
		u.ID, u.Name, u.Email, u.PasswordHash).Scan(&u.CreatedAt)
	return mapConstraint(err)
}

func (p *Postgres) getUser(ctx context.Context, where string, arg any) (*User, error) {
	u := &User{}
	err := p.Pool.QueryRow(ctx,
		`select id, name, email, password_hash, created_at from users where `+where, arg).
		Scan(&u.ID, &u.Name, &u.Email, &u.PasswordHash, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (p *Postgres) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	return p.getUser(ctx, "email = $1", email)
}

func (p *Postgres) GetUserByID(ctx context.Context, id uuid.UUID) (*User, error) {
	return p.getUser(ctx, "id = $1", id)
}

func (p *Postgres) CreateSession(ctx context.Context, s *Session) error {
	err := p.Pool.QueryRow(ctx,
		`insert into sessions (id, user_id, token_hash, expires_at) values ($1, $2, $3, $4)
		 returning created_at`,
		s.ID, s.UserID, s.TokenHash, s.ExpiresAt).Scan(&s.CreatedAt)
	return mapConstraint(err)
}

func (p *Postgres) GetSessionByTokenHash(ctx context.Context, tokenHash string) (*Session, error) {
	s := &Session{}
	err := p.Pool.QueryRow(ctx,
		`select id, user_id, token_hash, expires_at, created_at from sessions where token_hash = $1`,
		tokenHash).Scan(&s.ID, &s.UserID, &s.TokenHash, &s.ExpiresAt, &s.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (p *Postgres) DeleteSessionByTokenHash(ctx context.Context, tokenHash string) error {
	tag, err := p.Pool.Exec(ctx, `delete from sessions where token_hash = $1`, tokenHash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
