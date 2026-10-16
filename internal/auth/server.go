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
	// LoginLimiter throttles POST /api/auth/login per client IP (RSK-001);
	// nil disables it. ClientIP says which proxies' X-Forwarded-For to trust.
	LoginLimiter RateLimiter
	ClientIP     ClientIP
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
	mux.HandleFunc("POST /api/auth/login", s.rateLimit(s.login))
	mux.Handle("GET /api/auth/me", s.requireSession(http.HandlerFunc(s.me)))
	mux.Handle("POST /api/auth/logout", s.clearSession(s.requireSession(http.HandlerFunc(s.logout))))
	mux.HandleFunc("GET /signup", s.signupForm)
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
	// The auth scheme is case-insensitive (RFC 9110 §11.1).
	if scheme, tok, ok := strings.Cut(r.Header.Get("Authorization"), " "); ok && strings.EqualFold(scheme, "Bearer") {
		return strings.TrimSpace(tok)
	}
	return ""
}

// unauthorized answers 401 with the challenge RFC 9110 requires.
func unauthorized(w http.ResponseWriter, msg string) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="auth"`)
	writeError(w, http.StatusUnauthorized, msg)
}

// requireSession rejects requests without a live session with 401
// (REQ-006 steps: select session by token hash, then select user by id).
func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := sessionToken(r)
		if tok == "" {
			unauthorized(w, "not authenticated")
			return
		}
		hash := HashToken(tok)
		sess, err := s.store.GetSessionByTokenHash(r.Context(), hash)
		if errors.Is(err, store.ErrNotFound) {
			unauthorized(w, "not authenticated")
			return
		}
		if err != nil {
			s.internal(w, err)
			return
		}
		if !s.now().Before(sess.ExpiresAt) {
			s.store.DeleteSessionByTokenHash(r.Context(), hash) //nolint:errcheck
			unauthorized(w, "session expired")
			return
		}
		user, err := s.store.GetUserByID(r.Context(), sess.UserID)
		if errors.Is(err, store.ErrNotFound) {
			unauthorized(w, "not authenticated")
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

// Signup error messages (REQ-001). JSON 400/409 bodies are
// {"error": msg, "field": name}; form posts re-render the signup page with msg.
const (
	SignupNameRequired     = "name is required"
	SignupInvalidEmail     = "invalid email"
	SignupPasswordLength   = "password must be 8-72 characters"
	SignupPasswordMismatch = "passwords do not match"
	SignupEmailTaken       = "email already registered"
)

// OP-001 (REQ-001..003): validate, check email uniqueness, bcrypt, insert.
func (s *Server) signup(w http.ResponseWriter, r *http.Request) {
	form := isForm(r)
	var name, email, password, confirm, confirmCamel string
	if err := decode(r, map[string]*string{
		"name": &name, "email": &email, "password": &password,
		"confirm_password": &confirm, "confirmPassword": &confirmCamel,
	}); err != nil {
		s.signupFailed(w, form, http.StatusBadRequest, "", "invalid request body", signupPage{})
		return
	}
	if confirm == "" {
		confirm = confirmCamel
	}
	name = strings.TrimSpace(name)
	email = normalizeEmail(email)
	page := signupPage{Name: name, Email: email}
	fail := func(status int, field, msg string) { s.signupFailed(w, form, status, field, msg, page) }
	switch {
	case name == "":
		fail(http.StatusBadRequest, "name", SignupNameRequired)
		return
	case !validEmail(email):
		fail(http.StatusBadRequest, "email", SignupInvalidEmail)
		return
	case len(password) < 8 || len(password) > 72: // bcrypt only uses 72 bytes
		fail(http.StatusBadRequest, "password", SignupPasswordLength)
		return
	// The signup form always sends the confirmation; JSON clients may omit it.
	case (form || confirm != "") && confirm != password:
		fail(http.StatusBadRequest, "confirm_password", SignupPasswordMismatch)
		return
	}

	// REQ-002: check for an existing email first; the unique index still
	// guards the race between this check and the insert.
	if _, err := s.store.GetUserByEmail(r.Context(), email); err == nil {
		fail(http.StatusConflict, "email", SignupEmailTaken)
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
		fail(http.StatusConflict, "email", SignupEmailTaken)
		return
	} else if err != nil {
		s.internal(w, err)
		return
	}
	if form {
		// Browser form submission: the new account signs in next.
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

// signupFailed answers a rejected signup: JSON with the offending field for
// API clients, the signup page with an alert (and the entered name/email,
// never the password) for browsers.
func (s *Server) signupFailed(w http.ResponseWriter, form bool, status int, field, msg string, page signupPage) {
	if form {
		page.Alert = msg
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(status)
		signupTmpl.Execute(w, page) //nolint:errcheck
		return
	}
	body := map[string]string{"error": msg}
	if field != "" {
		body["field"] = field
	}
	writeJSON(w, status, body)
}

func validEmail(e string) bool {
	a, err := mail.ParseAddress(e)
	return err == nil && a.Address == e && strings.Contains(e[strings.LastIndex(e, "@"):], ".")
}

// LoginFailedMessage is the single, generic error for every failed login, so
// responses never reveal whether the email exists (REQ-004).
const LoginFailedMessage = "invalid email or password"

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	form := isForm(r)
	// Neither the session cookie nor the Session body may be cached.
	w.Header().Set("Cache-Control", "no-store")
	var email, password string
	if err := decode(r, map[string]*string{"email": &email, "password": &password}); err != nil {
		if form {
			s.loginFailed(w, r, form)
			return
		}
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

// loginFailed answers every failed login with 401 and the same generic
// message: JSON for API clients, the login page with an alert for browsers.
func (s *Server) loginFailed(w http.ResponseWriter, _ *http.Request, form bool) {
	if form {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		loginTmpl.Execute(w, loginFailedAlert) //nolint:errcheck
		return
	}
	writeError(w, http.StatusUnauthorized, LoginFailedMessage)
}

// me is OP-003 (REQ-006): the session's user, serialised without
// password_hash (store.User tags it json:"-").
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(ctxKey{}).(authed)
	// Per-user data: shared caches must not store or replay it.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, a.user)
}

// clearSession expires the client's session cookie on every logout response,
// including the 401 for a stale or unknown token, so the browser never keeps
// a dead cookie. The attributes match the login cookie so it is replaced.
func (s *Server) clearSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
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
		next.ServeHTTP(w, r)
	})
}

// logout is OP-004 (REQ-007): deletes only the presented session's row;
// the user's other sessions stay valid. The cookie is cleared by clearSession.
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(ctxKey{}).(authed)
	if err := s.store.DeleteSessionByTokenHash(r.Context(), a.tokenHash); err != nil &&
		!errors.Is(err, store.ErrNotFound) {
		s.internal(w, err)
		return
	}
	if isForm(r) {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
}

// ---- minimal pages (stand-in for auth-frontend) ----

// loginFailedAlert is the login page's alert after a failed sign-in.
const loginFailedAlert = "Invalid email or password."

// loginTmpl takes the alert text to show, or "" for none.
var loginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<h1>Sign in</h1>
{{if .}}<p role="alert">{{.}}</p>{{end}}
<form method="post" action="/api/auth/login">
<label>Email <input type="email" name="email" required></label>
<label>Password <input type="password" name="password" required></label>
<button type="submit">Sign in</button>
</form>
<p><a href="/signup">Create an account</a></p>
</body></html>`))

// signupPage is signupTmpl's data: the alert ("" = none) and the values to
// keep in the form after a rejected submission.
type signupPage struct{ Alert, Name, Email string }

// signupTmpl mirrors the server rules with HTML constraints (REQ-001); the
// server re-checks everything and renders its message in the alert.
var signupTmpl = template.Must(template.New("signup").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Create account</title></head><body>
<h1>Create account</h1>
{{if .Alert}}<p role="alert">{{.Alert}}</p>{{end}}
<form method="post" action="/api/auth/signup">
<label>Name <input type="text" name="name" value="{{.Name}}" required></label>
<label>Email <input type="email" name="email" value="{{.Email}}" required></label>
<label>Password <input type="password" name="password" minlength="8" maxlength="72" required></label>
<label>Confirm password <input type="password" name="confirm_password" minlength="8" maxlength="72" required></label>
<button type="submit">Sign up</button>
</form>
<p><a href="/login">Already have an account? Sign in</a></p>
</body></html>`))

var dashboardTmpl = template.Must(template.New("dashboard").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Dashboard</title></head><body>
<h1>Welcome, {{.Name}}</h1>
<p>Signed in as {{.Email}}</p>
<form method="post" action="/api/auth/logout"><button type="submit">Sign out</button></form>
</body></html>`))

func (s *Server) loginPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	alert := ""
	if r.URL.Query().Get("error") != "" {
		alert = loginFailedAlert
	}
	loginTmpl.Execute(w, alert) //nolint:errcheck
}

func (s *Server) signupForm(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	signupTmpl.Execute(w, signupPage{}) //nolint:errcheck
}

func (s *Server) dashboardPage(w http.ResponseWriter, r *http.Request) {
	a := r.Context().Value(ctxKey{}).(authed)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	dashboardTmpl.Execute(w, a.user) //nolint:errcheck
}
