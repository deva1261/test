package store

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Memory is an in-process Store that enforces the same unique and foreign
// key constraints as the Postgres schema. Intended for tests.
type Memory struct {
	mu       sync.Mutex
	users    map[uuid.UUID]User
	sessions map[string]Session // keyed by token hash
}

func NewMemory() *Memory {
	return &Memory{users: map[uuid.UUID]User{}, sessions: map[string]Session{}}
}

func (m *Memory) CreateUser(_ context.Context, u *User) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.users {
		if existing.Email == u.Email {
			return ErrEmailTaken
		}
	}
	u.CreatedAt = time.Now().UTC()
	m.users[u.ID] = *u
	return nil
}

func (m *Memory) GetUserByEmail(_ context.Context, email string) (*User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.users {
		if u.Email == email {
			return &u, nil
		}
	}
	return nil, ErrNotFound
}

func (m *Memory) GetUserByID(_ context.Context, id uuid.UUID) (*User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[id]
	if !ok {
		return nil, ErrNotFound
	}
	return &u, nil
}

func (m *Memory) CreateSession(_ context.Context, s *Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.users[s.UserID]; !ok {
		return ErrUserMissing
	}
	if _, ok := m.sessions[s.TokenHash]; ok {
		return ErrTokenTaken
	}
	s.CreatedAt = time.Now().UTC()
	m.sessions[s.TokenHash] = *s
	return nil
}

func (m *Memory) GetSessionByTokenHash(_ context.Context, tokenHash string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[tokenHash]
	if !ok {
		return nil, ErrNotFound
	}
	return &s, nil
}

// SessionCount returns the number of stored sessions (test helper; not part of Store).
func (m *Memory) SessionCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

func (m *Memory) DeleteSessionByTokenHash(_ context.Context, tokenHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sessions[tokenHash]; !ok {
		return ErrNotFound
	}
	delete(m.sessions, tokenHash)
	return nil
}
