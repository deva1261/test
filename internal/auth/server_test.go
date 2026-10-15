package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/engineeringos/authservice/internal/store"
)

func newTestServer(t *testing.T) (*Server, *store.Memory, http.Handler) {
	t.Helper()
	mem := store.NewMemory()
	srv := NewServer(mem, Config{BcryptCost: MinBcryptCost, SessionTTL: time.Hour, CookieSecure: true})
	return srv, mem, srv.Routes()
}

func doJSON(t *testing.T, h http.Handler, method, path string, body any, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body) //nolint:errcheck
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func signupBody(email string) map[string]string {
	return map[string]string{"name": "Ada", "email": email, "password": "correct-horse", "confirm_password": "correct-horse"}
}

func sessionCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName {
			return c
		}
	}
	t.Fatalf("no %q cookie in response; headers=%v", CookieName, rec.Header())
	return nil
}

func login(t *testing.T, h http.Handler, email string) *http.Cookie {
	t.Helper()
	rec := doJSON(t, h, "POST", "/api/auth/login", map[string]string{"email": email, "password": "correct-horse"})
	if rec.Code != http.StatusOK {
		t.Fatalf("login: got %d %s", rec.Code, rec.Body)
	}
	return sessionCookie(t, rec)
}

// AC1
func TestSignupDuplicateEmailReturns409(t *testing.T) {
	_, _, h := newTestServer(t)
	if rec := doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com")); rec.Code != http.StatusCreated {
		t.Fatalf("first signup: got %d %s", rec.Code, rec.Body)
	}
	// Same email with different case/whitespace is still a duplicate.
	rec := doJSON(t, h, "POST", "/api/auth/signup", signupBody("  ADA@example.com "))
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate signup: got %d, want 409", rec.Code)
	}
}

// AC2
func TestSignupUniqueEmailReturnsJSON(t *testing.T) {
	_, _, h := newTestServer(t)
	rec := doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type %q", ct)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["email"] != "ada@example.com" || got["name"] != "Ada" || got["id"] == "" || got["created_at"] == nil {
		t.Fatalf("unexpected body %v", got)
	}
	if _, leaked := got["password_hash"]; leaked {
		t.Fatal("password hash must not be returned")
	}
}

func TestSignupValidation(t *testing.T) {
	_, _, h := newTestServer(t)
	cases := map[string]map[string]string{
		"missing name":   {"name": "", "email": "a@example.com", "password": "correct-horse"},
		"bad email":      {"name": "A", "email": "not-an-email", "password": "correct-horse"},
		"short password": {"name": "A", "email": "a@example.com", "password": "short"},
		"mismatch":       {"name": "A", "email": "a@example.com", "password": "correct-horse", "confirm_password": "other-horse"},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if rec := doJSON(t, h, "POST", "/api/auth/signup", body); rec.Code != http.StatusBadRequest {
				t.Fatalf("got %d, want 400", rec.Code)
			}
		})
	}
}

// AC3, AC4
func TestStoredPasswordIsBcryptWithMinCost(t *testing.T) {
	_, mem, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	u, err := mem.GetUserByEmail(context.Background(), "ada@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u.PasswordHash, "$2a$") && !strings.HasPrefix(u.PasswordHash, "$2b$") {
		t.Fatalf("password not bcrypt: %q", u.PasswordHash)
	}
	if strings.Contains(u.PasswordHash, "correct-horse") {
		t.Fatal("plain text stored")
	}
	cost, err := bcrypt.Cost([]byte(u.PasswordHash))
	if err != nil || cost < 10 {
		t.Fatalf("cost %d err %v", cost, err)
	}
}

func TestHashPasswordClampsCost(t *testing.T) {
	h, err := HashPassword("pw-12345678", 4)
	if err != nil {
		t.Fatal(err)
	}
	if cost, _ := bcrypt.Cost([]byte(h)); cost != MinBcryptCost {
		t.Fatalf("cost %d, want %d", cost, MinBcryptCost)
	}
	if NewServer(store.NewMemory(), Config{}).cfg.BcryptCost != MinBcryptCost {
		t.Fatal("server must clamp configured cost")
	}
}

// AC5
func TestLoginSetsHttpOnlySecureCookie(t *testing.T) {
	_, mem, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	rec := doJSON(t, h, "POST", "/api/auth/login", map[string]string{"email": "ada@example.com", "password": "correct-horse"})
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	raw := rec.Header().Get("Set-Cookie")
	for _, attr := range []string{"HttpOnly", "Secure", "SameSite=Lax"} {
		if !strings.Contains(raw, attr) {
			t.Fatalf("Set-Cookie %q missing %s", raw, attr)
		}
	}
	c := sessionCookie(t, rec)
	// Only the hash of the token is stored.
	if _, err := mem.GetSessionByTokenHash(context.Background(), c.Value); err == nil {
		t.Fatal("raw token stored in DB")
	}
	if _, err := mem.GetSessionByTokenHash(context.Background(), HashToken(c.Value)); err != nil {
		t.Fatalf("session not stored by hash: %v", err)
	}
}

func TestLoginInvalidCredentials(t *testing.T) {
	_, _, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	for _, body := range []map[string]string{
		{"email": "ada@example.com", "password": "wrong-password"},
		{"email": "nobody@example.com", "password": "correct-horse"},
	} {
		rec := doJSON(t, h, "POST", "/api/auth/login", body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("got %d, want 401", rec.Code)
		}
		if rec.Header().Get("Set-Cookie") != "" {
			t.Fatal("cookie set on failed login")
		}
	}
}

// AC6
func TestBrowserLoginRedirectsToDashboard(t *testing.T) {
	_, _, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	form := url.Values{"email": {"ada@example.com"}, "password": {"correct-horse"}}
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != DashboardPath {
		t.Fatalf("got %d Location=%q", rec.Code, rec.Header().Get("Location"))
	}
	c := sessionCookie(t, rec)
	if dash := doJSON(t, h, "GET", DashboardPath, nil, c); dash.Code != http.StatusOK || !strings.Contains(dash.Body.String(), "Ada") {
		t.Fatalf("dashboard: %d %s", dash.Code, dash.Body)
	}
}

func TestMeReturnsCurrentUser(t *testing.T) {
	_, _, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	c := login(t, h, "ada@example.com")
	rec := doJSON(t, h, "GET", "/api/auth/me", nil, c)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ada@example.com") {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "password") {
		t.Fatal("password hash leaked")
	}
	// Bearer header works too.
	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+c.Value)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer: got %d", rec.Code)
	}
}

// AC7, AC8
func TestLogoutClearsCookieAndInvalidatesSession(t *testing.T) {
	_, mem, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	c := login(t, h, "ada@example.com")

	rec := doJSON(t, h, "POST", "/api/auth/logout", nil, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("logout: got %d %s", rec.Code, rec.Body)
	}
	cleared := sessionCookie(t, rec)
	if cleared.Value != "" || cleared.MaxAge >= 0 {
		t.Fatalf("cookie not cleared: %+v", cleared)
	}
	if _, err := mem.GetSessionByTokenHash(context.Background(), HashToken(c.Value)); err != store.ErrNotFound {
		t.Fatalf("session row still present: %v", err)
	}
	// Replaying the old token is rejected on every protected route.
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/auth/me"}, {"POST", "/api/auth/logout"}, {"GET", DashboardPath},
	} {
		if rec := doJSON(t, h, r.method, r.path, nil, c); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s after logout: got %d, want 401", r.method, r.path, rec.Code)
		}
	}
}

func TestProtectedRoutesWithoutSession(t *testing.T) {
	_, _, h := newTestServer(t)
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/auth/me"}, {"POST", "/api/auth/logout"}, {"GET", DashboardPath},
	} {
		if rec := doJSON(t, h, r.method, r.path, nil); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: got %d, want 401", r.method, r.path, rec.Code)
		}
	}
}

func TestExpiredSessionRejected(t *testing.T) {
	srv, _, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	c := login(t, h, "ada@example.com")
	srv.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if rec := doJSON(t, h, "GET", "/api/auth/me", nil, c); rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", rec.Code)
	}
}
