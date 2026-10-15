package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"

	"golang.org/x/crypto/bcrypt"
)

// MinBcryptCost is the floor enforced on any configured cost (REQ-003).
const MinBcryptCost = 10

// DefaultBcryptCost follows design decision DEC-002.
const DefaultBcryptCost = 12

// HashPassword bcrypt-hashes a raw password with at least MinBcryptCost.
func HashPassword(password string, cost int) (string, error) {
	if cost < MinBcryptCost {
		cost = MinBcryptCost
	}
	h, err := bcrypt.GenerateFromPassword([]byte(password), cost)
	return string(h), err
}

// CheckPassword reports whether password matches the bcrypt hash.
func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// NewToken returns a random opaque session token (sent to the client) and
// its SHA-256 hex hash (stored in sessions.token_hash).
func NewToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token), nil
}

// HashToken is the SHA-256 hex digest of a session token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
