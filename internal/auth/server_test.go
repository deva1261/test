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

// ---- WI-002: signup ----

func signupForm(name, email, password, confirm string) url.Values {
	return url.Values{"name": {name}, "email": {email}, "password": {password}, "confirm_password": {confirm}}
}

// WI-002 AC1-4: each invalid field gets a 400 naming that field and its message.
func TestSignupValidationErrorsNameTheField(t *testing.T) {
	_, mem, h := newTestServer(t)
	cases := []struct {
		name        string
		body        map[string]string
		field, want string
	}{
		{"empty name", map[string]string{"name": "   ", "email": "a@example.com", "password": "correct-horse"}, "name", SignupNameRequired},
		{"invalid email", map[string]string{"name": "A", "email": "a@b", "password": "correct-horse"}, "email", SignupInvalidEmail},
		{"email with display name", map[string]string{"name": "A", "email": "A <a@example.com>", "password": "correct-horse"}, "email", SignupInvalidEmail},
		{"7-char password", map[string]string{"name": "A", "email": "a@example.com", "password": "1234567"}, "password", SignupPasswordLength},
		{"73-byte password", map[string]string{"name": "A", "email": "a@example.com", "password": strings.Repeat("x", 73)}, "password", SignupPasswordLength},
		{"mismatch", map[string]string{"name": "A", "email": "a@example.com", "password": "correct-horse", "confirm_password": "correct-horsf"}, "confirm_password", SignupPasswordMismatch},
		{"camelCase mismatch", map[string]string{"name": "A", "email": "a@example.com", "password": "correct-horse", "confirmPassword": "nope-nope-nope"}, "confirm_password", SignupPasswordMismatch},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := doJSON(t, h, "POST", "/api/auth/signup", c.body)
			var got map[string]string
			json.Unmarshal(rec.Body.Bytes(), &got) //nolint:errcheck
			if rec.Code != http.StatusBadRequest || got["field"] != c.field || got["error"] != c.want {
				t.Fatalf("got %d %v, want 400 %s %q", rec.Code, got, c.field, c.want)
			}
		})
	}
	if _, err := mem.GetUserByEmail(context.Background(), "a@example.com"); err == nil {
		t.Fatal("invalid signup created a user")
	}
	// Exactly 8 characters is accepted, and confirmPassword works as an alias.
	rec := doJSON(t, h, "POST", "/api/auth/signup", map[string]string{"name": "A", "email": "a@example.com", "password": "12345678", "confirmPassword": "12345678"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("8-char password: %d %s", rec.Code, rec.Body)
	}
}

// WI-002 AC1-4: the signup page shows the server's validation error and keeps
// the entered name/email (never the password).
func TestSignupFormShowsValidationError(t *testing.T) {
	_, _, h := newTestServer(t)
	page := doJSON(t, h, "GET", "/signup", nil)
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), `action="/api/auth/signup"`) ||
		!strings.Contains(page.Body.String(), `name="confirm_password"`) || strings.Contains(page.Body.String(), `role="alert"`) {
		t.Fatalf("signup page: %d %s", page.Code, page.Body)
	}
	cases := map[string]struct {
		form url.Values
		want string
	}{
		"empty name":     {signupForm("", "a@example.com", "correct-horse", "correct-horse"), SignupNameRequired},
		"invalid email":  {signupForm("Ada", "not-an-email", "correct-horse", "correct-horse"), SignupInvalidEmail},
		"short password": {signupForm("Ada", "a@example.com", "short", "short"), SignupPasswordLength},
		"mismatch":       {signupForm("Ada", "a@example.com", "correct-horse", "other-horse"), SignupPasswordMismatch},
		// A form always carries the confirmation, so leaving it blank is a mismatch.
		"blank confirm": {signupForm("Ada", "a@example.com", "correct-horse", ""), SignupPasswordMismatch},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			rec := postForm(h, "/api/auth/signup", c.form)
			body := rec.Body.String()
			if rec.Code != http.StatusBadRequest || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
				t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Content-Type"))
			}
			if !strings.Contains(body, `<p role="alert">`+c.want+`</p>`) {
				t.Fatalf("alert %q missing: %s", c.want, body)
			}
			if strings.Contains(body, "correct-horse") {
				t.Fatal("password echoed back into the page")
			}
		})
	}
	rec := postForm(h, "/api/auth/signup", signupForm("Ada <b>", "not-an-email", "correct-horse", "correct-horse"))
	if !strings.Contains(rec.Body.String(), `value="Ada &lt;b&gt;"`) {
		t.Fatalf("name not kept (escaped) in form: %s", rec.Body)
	}
}

// WI-002 AC5, AC6: browser signup redirects to /login, a repeat shows 409.
func TestSignupFormSuccessAndDuplicate(t *testing.T) {
	_, mem, h := newTestServer(t)
	rec := postForm(h, "/api/auth/signup", signupForm("Ada", "ada@example.com", "correct-horse", "correct-horse"))
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/login" {
		t.Fatalf("got %d Location=%q", rec.Code, rec.Header().Get("Location"))
	}
	if _, err := mem.GetUserByEmail(context.Background(), "ada@example.com"); err != nil {
		t.Fatalf("user not created: %v", err)
	}
	login(t, h, "ada@example.com")

	rec = postForm(h, "/api/auth/signup", signupForm("Ada", "ADA@example.com", "correct-horse", "correct-horse"))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), SignupEmailTaken) {
		t.Fatalf("duplicate: %d %s", rec.Code, rec.Body)
	}
	var got map[string]string
	jrec := doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	json.Unmarshal(jrec.Body.Bytes(), &got) //nolint:errcheck
	if jrec.Code != http.StatusConflict || got["error"] != SignupEmailTaken || got["field"] != "email" {
		t.Fatalf("JSON duplicate: %d %v", jrec.Code, got)
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

// WI-002 AC7, AC8: with the deployed default (DEC-002) the stored hash is cost 12.
func TestSignupUsesConfiguredBcryptCost(t *testing.T) {
	mem := store.NewMemory()
	h := NewServer(mem, Config{BcryptCost: DefaultBcryptCost}).Routes()
	if rec := doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com")); rec.Code != http.StatusCreated {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	u, _ := mem.GetUserByEmail(context.Background(), "ada@example.com")
	if cost, err := bcrypt.Cost([]byte(u.PasswordHash)); err != nil || cost != DefaultBcryptCost {
		t.Fatalf("cost %d err %v", cost, err)
	}
	if !CheckPassword(u.PasswordHash, "correct-horse") {
		t.Fatal("stored hash does not verify the raw password")
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

// ---- WI-003: login ----

func postForm(h http.Handler, path string, form url.Values) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// WI-003 AC1: valid credentials match the stored user and create a session row.
func TestLoginCreatesSessionForMatchedUser(t *testing.T) {
	srv, mem, h := newTestServer(t)
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	srv.now = func() time.Time { return now }
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	u, _ := mem.GetUserByEmail(context.Background(), "ada@example.com")

	// Email lookup is case/whitespace-insensitive, like signup.
	rec := doJSON(t, h, "POST", "/api/auth/login", map[string]string{"email": " ADA@Example.com ", "password": "correct-horse"})
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control %q", cc)
	}
	var body store.Session
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	c := sessionCookie(t, rec)
	sess, err := mem.GetSessionByTokenHash(context.Background(), HashToken(c.Value))
	if err != nil {
		t.Fatalf("session not stored: %v", err)
	}
	if sess.UserID != u.ID || body.UserID != u.ID || body.ID != sess.ID || body.TokenHash != sess.TokenHash {
		t.Fatalf("session %+v body %+v user %s", sess, body, u.ID)
	}
	if !sess.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("expires_at %s, want now+TTL", sess.ExpiresAt)
	}
	// The raw token only travels in the HttpOnly cookie.
	if strings.Contains(rec.Body.String(), c.Value) {
		t.Fatal("raw token leaked in response body")
	}
	// Each login issues a fresh token.
	if c2 := login(t, h, "ada@example.com"); c2.Value == c.Value {
		t.Fatal("token reused across logins")
	}
}

// WI-003 AC2, AC3: wrong password and unknown email are indistinguishable 401s.
func TestLoginFailuresAreGeneric401(t *testing.T) {
	_, mem, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	var bodies []string
	for _, body := range []map[string]string{
		{"email": "ada@example.com", "password": "wrong-password"},
		{"email": "nobody@example.com", "password": "correct-horse"},
		{"email": "ada@example.com", "password": ""},
		{"email": "", "password": ""},
	} {
		rec := doJSON(t, h, "POST", "/api/auth/login", body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%v: got %d, want 401", body, rec.Code)
		}
		bodies = append(bodies, rec.Body.String())
	}
	for _, b := range bodies {
		if b != bodies[0] {
			t.Fatalf("error bodies differ: %q vs %q", b, bodies[0])
		}
	}
	if !strings.Contains(bodies[0], LoginFailedMessage) {
		t.Fatalf("body %q", bodies[0])
	}
	if mem.SessionCount() != 0 {
		t.Fatal("session created on failed login")
	}
}

// WI-003 AC2, AC3: a failed browser login shows the generic message with 401.
func TestBrowserLoginFailureShowsGenericError(t *testing.T) {
	_, _, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	var pages []string
	for _, form := range []url.Values{
		{"email": {"ada@example.com"}, "password": {"wrong-password"}},
		{"email": {"nobody@example.com"}, "password": {"correct-horse"}},
	} {
		rec := postForm(h, "/api/auth/login", form)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("got %d, want 401", rec.Code)
		}
		if rec.Header().Get("Set-Cookie") != "" {
			t.Fatal("cookie set on failed login")
		}
		if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") ||
			!strings.Contains(rec.Body.String(), "Invalid email or password.") {
			t.Fatalf("page: %q %s", rec.Header().Get("Content-Type"), rec.Body)
		}
		pages = append(pages, rec.Body.String())
	}
	if pages[0] != pages[1] {
		t.Fatal("failure page reveals whether the email exists")
	}
}

// WI-003 AC4: the session cookie carries HttpOnly, Secure, SameSite and a lifetime.
func TestLoginCookieAttributes(t *testing.T) {
	_, _, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"json": doJSON(t, h, "POST", "/api/auth/login", map[string]string{"email": "ada@example.com", "password": "correct-horse"}),
		"form": postForm(h, "/api/auth/login", url.Values{"email": {"ada@example.com"}, "password": {"correct-horse"}}),
	} {
		c := sessionCookie(t, rec)
		if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/" {
			t.Fatalf("%s: cookie %+v", name, c)
		}
		if c.MaxAge != int(time.Hour.Seconds()) || len(c.Value) < 43 {
			t.Fatalf("%s: MaxAge %d len %d", name, c.MaxAge, len(c.Value))
		}
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

// ---- WI-005: logout ----

func postLogout(h http.Handler, contentType, bearer string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/auth/logout", strings.NewReader(""))
	req.Header.Set("Content-Type", contentType)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// assertCookieCleared checks the response expires the session cookie with
// the same scope/attributes as the login cookie, so the browser drops it.
func assertCookieCleared(t *testing.T, name string, rec *httptest.ResponseRecorder) {
	t.Helper()
	c := sessionCookie(t, rec)
	if c.Value != "" || c.MaxAge >= 0 || c.Path != "/" || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("%s: cookie not cleared: %+v", name, c)
	}
	if !strings.Contains(rec.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("%s: Set-Cookie %q lacks Max-Age=0", name, rec.Header().Get("Set-Cookie"))
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("%s: Cache-Control %q", name, cc)
	}
}

// WI-005 AC1 + AC2 for each way a client can log out.
func TestLogoutVariants(t *testing.T) {
	cases := map[string]struct {
		do           func(h http.Handler, c *http.Cookie) *httptest.ResponseRecorder
		wantStatus   int
		wantLocation string
	}{
		"json cookie": {func(h http.Handler, c *http.Cookie) *httptest.ResponseRecorder {
			return postLogout(h, "application/json", "", c)
		}, http.StatusOK, ""},
		"bearer header": {func(h http.Handler, c *http.Cookie) *httptest.ResponseRecorder {
			return postLogout(h, "application/json", c.Value)
		}, http.StatusOK, ""},
		"dashboard form": {func(h http.Handler, c *http.Cookie) *httptest.ResponseRecorder {
			return postLogout(h, "application/x-www-form-urlencoded", "", c)
		}, http.StatusSeeOther, "/login"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, mem, h := newTestServer(t)
			doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
			c := login(t, h, "ada@example.com")

			rec := tc.do(h, c)
			if rec.Code != tc.wantStatus || rec.Header().Get("Location") != tc.wantLocation {
				t.Fatalf("got %d Location %q, want %d %q", rec.Code, rec.Header().Get("Location"), tc.wantStatus, tc.wantLocation)
			}
			assertCookieCleared(t, name, rec)
			if mem.SessionCount() != 0 {
				t.Fatalf("session row kept: %d", mem.SessionCount())
			}
			if rec := getMe(h, "Bearer "+c.Value); rec.Code != http.StatusUnauthorized {
				t.Fatalf("me after logout: got %d, want 401", rec.Code)
			}
			if rec := doJSON(t, h, "GET", DashboardPath, nil, c); rec.Code != http.StatusUnauthorized {
				t.Fatalf("dashboard after logout: got %d, want 401", rec.Code)
			}
		})
	}
}

// Logout ends only the presented session; other devices stay signed in.
func TestLogoutKeepsOtherSessions(t *testing.T) {
	_, mem, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	laptop := login(t, h, "ada@example.com")
	phone := login(t, h, "ada@example.com")

	if rec := postLogout(h, "application/json", "", laptop); rec.Code != http.StatusOK {
		t.Fatalf("logout: got %d", rec.Code)
	}
	if mem.SessionCount() != 1 {
		t.Fatalf("got %d sessions, want 1", mem.SessionCount())
	}
	if rec := doJSON(t, h, "GET", "/api/auth/me", nil, phone); rec.Code != http.StatusOK {
		t.Fatalf("other session: got %d, want 200", rec.Code)
	}
}

// Logout without a live session is 401, but a stale cookie is still cleared.
func TestLogoutUnauthenticated(t *testing.T) {
	srv, mem, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	c := login(t, h, "ada@example.com")

	cases := map[string]*httptest.ResponseRecorder{
		"no credentials": postLogout(h, "application/json", ""),
		"forged cookie":  postLogout(h, "application/json", "", &http.Cookie{Name: CookieName, Value: "forged"}),
		"forged bearer":  postLogout(h, "application/json", "forged"),
	}
	srv.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	cases["expired cookie"] = postLogout(h, "application/json", "", c)

	for name, rec := range cases {
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: got %d, want 401", name, rec.Code)
		}
		if !strings.HasPrefix(rec.Header().Get("WWW-Authenticate"), "Bearer") {
			t.Fatalf("%s: WWW-Authenticate %q", name, rec.Header().Get("WWW-Authenticate"))
		}
		assertCookieCleared(t, name, rec)
	}
	if mem.SessionCount() != 0 {
		t.Fatalf("expired session kept: %d rows", mem.SessionCount())
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

// ---- WI-004: current user ----

func getMe(h http.Handler, header string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	if header != "" {
		req.Header.Set("Authorization", header)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// WI-004 AC1: the profile is the session's user with no password hash field.
func TestMeProfileOmitsPasswordHash(t *testing.T) {
	_, mem, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	doJSON(t, h, "POST", "/api/auth/signup", map[string]string{"name": "Bob", "email": "bob@example.com", "password": "correct-horse"})
	u, _ := mem.GetUserByEmail(context.Background(), "ada@example.com")
	c := login(t, h, "ada@example.com")

	for name, rec := range map[string]*httptest.ResponseRecorder{
		"cookie": doJSON(t, h, "GET", "/api/auth/me", nil, c),
		"bearer": getMe(h, "Bearer "+c.Value),
		"BEARER": getMe(h, "bearer "+c.Value),
	} {
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: got %d %s", name, rec.Code, rec.Body)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Fatalf("%s: content-type %q", name, ct)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Fatalf("%s: Cache-Control %q", name, cc)
		}
		var got map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got) != 4 || got["id"] != u.ID.String() || got["name"] != "Ada" ||
			got["email"] != "ada@example.com" || got["created_at"] == nil {
			t.Fatalf("%s: unexpected body %v", name, got)
		}
		for _, k := range []string{"password_hash", "passwordHash", "PasswordHash"} {
			if _, leaked := got[k]; leaked {
				t.Fatalf("%s: %s returned", name, k)
			}
		}
		if strings.Contains(rec.Body.String(), u.PasswordHash) {
			t.Fatalf("%s: hash value leaked", name)
		}
	}
}

// WI-004 AC2: missing, unknown, malformed or expired tokens all get 401.
func TestMeUnauthenticatedReturns401(t *testing.T) {
	srv, mem, h := newTestServer(t)
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	c := login(t, h, "ada@example.com")

	cases := map[string]*httptest.ResponseRecorder{
		"no credentials": getMe(h, ""),
		"unknown cookie": doJSON(t, h, "GET", "/api/auth/me", nil, &http.Cookie{Name: CookieName, Value: "forged"}),
		"unknown bearer": getMe(h, "Bearer forged"),
		"empty bearer":   getMe(h, "Bearer "),
		"basic auth":     getMe(h, "Basic "+c.Value),
		"hash as token":  getMe(h, "Bearer "+HashToken(c.Value)),
	}
	srv.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	cases["expired"] = getMe(h, "Bearer "+c.Value)

	for name, rec := range cases {
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: got %d, want 401", name, rec.Code)
		}
		if !strings.HasPrefix(rec.Header().Get("WWW-Authenticate"), "Bearer") {
			t.Fatalf("%s: WWW-Authenticate %q", name, rec.Header().Get("WWW-Authenticate"))
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] == "" {
			t.Fatalf("%s: body %s", name, rec.Body)
		}
		if strings.Contains(rec.Body.String(), "ada@example.com") {
			t.Fatalf("%s: profile leaked", name)
		}
	}
	// The expired session row is purged.
	if mem.SessionCount() != 0 {
		t.Fatalf("expired session kept: %d rows", mem.SessionCount())
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
