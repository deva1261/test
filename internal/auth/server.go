// Package auth is the auth-api component (CMP-002): signup, login, current
// user and logout over stateful, database-backed sessions.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"html/template"
	"log/slog"
	"mime"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/engineeringos/authservice/internal/store"
)

// CookieName is the session cookie set on login and cleared on logout.
const CookieName = "session"

// DashboardPath is where a browser is sent after a successful login.
const DashboardPath = "/dashboard"

// Config tunes the auth server.
type Config struct {
	BcryptCost   int           // clamped to >= MinBcryptCost
	SessionTTL   time.Duration // absolute session lifetime
	CookieSecure bool          // Secure attribute on the session cookie
}

// Server serves the /api/auth/* endpoints and the minimal login/dashboard pages.
type Server struct {
	store store.Store
	cfg   Config
	now   func() time.Time
	// dummyHash is compared against when the email is unknown, so login
	// timing does not reveal whether an account exists.
	dummyHash string
}

func NewServer(s store.Store, cfg Config) *Server {
	if cfg.BcryptCost < MinBcryptCost {
		cfg.BcryptCost = MinBcryptCost
	}
	if cfg.SessionTTL <= 0 {
		cfg.SessionTTL = 24 * time.Hour
	}
	dummy, _ := HashPassword("dummy-password-for-timing", cfg.BcryptCost)
	return &Server{store: s, cfg: cfg, now: time.Now, dummyHash: dummy}
}

// Routes returns the HTTP handler for the service.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/signup", s.signup)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.Handle("GET /api/auth/me", s.requireSession(http.HandlerFunc(s.me)))
	mux.Handle("POST /api/auth/logout", s.requireSession(http.HandlerFunc(s.logout)))
	mux.HandleFunc("GET /login", s.loginPage)
	mux.Handle("GET "+DashboardPath, s.requireSession(http.HandlerFunc(s.dashboardPage)))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// isForm reports whether the request body is an HTML form submission.
func isForm(r *http.Request) bool {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return mt == "application/x-www-form-urlencoded" || mt == "multipart/form-data"
}

// decode reads a JSON or form body into dst (keys are the json tag names).
func decode(r *http.Request, dst map[string]*string) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	if isForm(r) {
		if err := r.ParseForm(); err != nil {
			return err
		}
		for k, p := range dst {
			*p = r.PostForm.Get(k)
		}
		return nil
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return err
	}
	for k, p := range dst {
		if v, ok := body[k].(string); ok {
			*p = v
		}
	}
	return nil
}

func normalizeEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

// ---- handlers ----

type ctxKey struct{}

type authed struct {
	user      *store.User
	tokenHash string
}

// sessionToken extracts the token from the session cookie or a Bearer header.
func sessionToken(r *http.Request) string {
	if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
		return c.Value
	}
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	return ""
}

// requireSession rejects requests without a live session with 401.
func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := sessionToken(r)
		if tok == "" {
			writeError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		hash := HashToken(tok)
		sess, err := s.store.GetSessionByTokenHash(r.Context(), hash)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		if err != nil {
			s.internal(w, err)
			return
		}
		if !s.now().Before(sess.ExpiresAt) {
			s.store.DeleteSessionByTokenHash(r.Context(), hash) //nolint:errcheck
			writeError(w, http.StatusUnauthorized, "session expired")
			return
		}
		user, err := s.store.GetUserByID(r.Context(), sess.UserID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		if err != nil {
			s.internal(w, err)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKey{}, authed{user: user, tokenHash: hash})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) internal(w http.ResponseWriter, err error) {
	slog.Error("internal error", "err", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}

func (s *Server) signup(w http.ResponseWriter, r *http.Request) {
	var name, email, password, confirm string
	if err := decode(r, map[string]*string{
		"name": &name, "email": &email, "password": &password, "confirm_password": &confirm,
	}); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name = strings.TrimSpace(name)
	email = normalizeEmail(email)
	switch {
	case name == "":
		writeError(w, http.StatusBadRequest, "name is required")
		return
	case !validEmail(email):
		writeError(w, http.StatusBadRequest, "invalid email")
		return
	case len(password) < 8 || len(password) > 72: // bcrypt only uses 72 bytes
		writeError(w, http.StatusBadRequest, "password must be 8-72 characters")
		return
	case confirm != "" && confirm != password:
		writeError(w, http.StatusBadRequest, "passwords do not match")
		return
	}

	// REQ-002: check for an existing email first; the unique index still
	// guards the race between this check and the insert.
	if _, err := s.store.GetUserByEmail(r.Context(), email); err == nil {
		writeError(w, http.StatusConflict, "email already registered")
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		s.internal(w, err)
		return
	}

	hash, err := HashPassword(password, s.cfg.BcryptCost)
	if err != nil {
		s.internal(w, err)
		return
	}
	u := &store.User{ID: uuid.New(), Name: name, Email: email, PasswordHash: hash}
	if err := s.store.CreateUser(r.Context(), u); errors.Is(err, store.ErrEmailTaken) {
		writeError(w, http.StatusConflict, "email already registered")
		return
	} else if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func validEmail(e string) bool {
	a, err := mail.ParseAddress(e)
	return err == nil && a.Address == e && strings.Contains(e[strings.LastIndex(e, "@"):], ".")
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	form := isForm(r)
	var email, password string
	if err := decode(r, map[string]*string{"email": &email, "password": &password}); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	email = normalizeEmail(email)

	user, err := s.store.GetUserByEmail(r.Context(), email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.internal(w, err)
		return
	}
	if user == nil {
		CheckPassword(s.dummyHash, password)
		s.loginFailed(w, r, form)
		return
	}
	if !CheckPassword(user.PasswordHash, password) {
		s.loginFailed(w, r, form)
		return
	}

	token, tokenHash, err := NewToken()
	if err != nil {
		s.internal(w, err)
		return
	}
	sess := &store.Session{
		ID:        uuid.New(),
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: s.now().Add(s.cfg.SessionTTL).UTC(),
	}
	if err := s.store.CreateSession(r.Context(), sess); err != nil {
		s.internal(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		Expires:  sess.ExpiresAt,
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	if form {
		// Browser form submission: send the window to the dashboard.
		http.Redirect(w, r, DashboardPath, http.StatusSeeOther)
		return
	}
	writeJSON(w, http.StatusOK, sess)
}

func (s *Server) loginFailed(w http.ResponseWriter, r *http.Request, form bool) {
	if form {
		http.Redirect(w, r, "/login?error=1", http.StatusSeeOther)
		return
	}
	writeError(w, http.StatusUnauthorized, "invalid email or password")
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(ctxKey{}).(authed)
	writeJSON(w, http.StatusOK, a.user)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(ctxKey{}).(authed)
	if err := s.store.DeleteSessionByTokenHash(r.Context(), a.tokenHash); err != nil &&
		!errors.Is(err, store.ErrNotFound) {
		s.internal(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	if isForm(r) {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
}

// ---- minimal pages (stand-in for auth-frontend) ----

var loginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<h1>Sign in</h1>
{{if .}}<p role="alert">Invalid email or password.</p>{{end}}
<form method="post" action="/api/auth/login">
<label>Email <input type="email" name="email" required></label>
<label>Password <input type="password" name="password" required></label>
<button type="submit">Sign in</button>
</form></body></html>`))

var dashboardTmpl = template.Must(template.New("dashboard").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Dashboard</title></head><body>
<h1>Welcome, {{.Name}}</h1>
<p>Signed in as {{.Email}}</p>
<form method="post" action="/api/auth/logout"><button type="submit">Sign out</button></form>
</body></html>`))

func (s *Server) loginPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	loginTmpl.Execute(w, r.URL.Query().Get("error") != "") //nolint:errcheck
}

func (s *Server) dashboardPage(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(ctxKey{}).(authed)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	dashboardTmpl.Execute(w, a.user) //nolint:errcheck
}
