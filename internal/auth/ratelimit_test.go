package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/engineeringos/authservice/internal/store"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newLimiter(limit int, window time.Duration) (*MemoryLimiter, *fakeClock) {
	clk := &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	l := NewMemoryLimiter(limit, window)
	l.now = clk.now
	return l, clk
}

func TestMemoryLimiterAllowsBurstThenThrottles(t *testing.T) {
	l, clk := newLimiter(5, time.Minute)
	for i := range 5 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("request %d denied within the limit", i+1)
		}
	}
	ok, retry := l.Allow("a")
	if ok {
		t.Fatal("6th request in a minute allowed")
	}
	if retry != 12*time.Second { // one slot frees every window/limit
		t.Fatalf("retryAfter %v, want 12s", retry)
	}
	// Denied requests do not push the window further out.
	if _, again := l.Allow("a"); again != retry {
		t.Fatalf("denied request changed retryAfter: %v", again)
	}
	// Other clients are unaffected.
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("independent key throttled")
	}
	clk.advance(12 * time.Second)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("not allowed after retryAfter elapsed")
	}
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("refill granted more than one slot")
	}
	// After a full idle window the full burst is back.
	clk.advance(time.Minute)
	for i := range 5 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("burst not restored, request %d denied", i+1)
		}
	}
}

func TestMemoryLimiterSweepsIdleKeys(t *testing.T) {
	l, clk := newLimiter(5, time.Minute)
	for _, k := range []string{"a", "b", "c"} {
		l.Allow(k)
	}
	if l.Len() != 3 {
		t.Fatalf("tracking %d keys", l.Len())
	}
	clk.advance(2 * time.Minute)
	l.Allow("d")
	if l.Len() != 1 {
		t.Fatalf("idle keys not swept: %d left", l.Len())
	}
}

func reqFrom(remote string, xff ...string) *http.Request {
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestClientIP(t *testing.T) {
	proxies := ClientIP{Trusted: []netip.Prefix{
		netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8"),
	}}
	cases := []struct {
		name string
		c    ClientIP
		r    *http.Request
		want string
	}{
		{"no proxies: peer wins", ClientIP{}, reqFrom("203.0.113.9:5000", "198.51.100.1"), "203.0.113.9"},
		{"untrusted peer: XFF ignored", proxies, reqFrom("203.0.113.9:5000", "198.51.100.1"), "203.0.113.9"},
		{"trusted peer: XFF client", proxies, reqFrom("127.0.0.1:5000", "198.51.100.1"), "198.51.100.1"},
		{"spoofed left entries ignored", proxies, reqFrom("127.0.0.1:5000", "1.2.3.4, 198.51.100.1, 10.0.0.7"), "198.51.100.1"},
		{"multiple headers", proxies, reqFrom("127.0.0.1:5000", "1.2.3.4", "198.51.100.1"), "198.51.100.1"},
		{"garbage stops the walk", proxies, reqFrom("127.0.0.1:5000", "198.51.100.1, junk, 10.0.0.7"), "10.0.0.7"},
		{"trusted peer, no XFF", proxies, reqFrom("127.0.0.1:5000"), "127.0.0.1"},
		{"ipv4-mapped peer", ClientIP{}, reqFrom("[::ffff:203.0.113.9]:5000"), "203.0.113.9"},
		{"ipv6 peer", ClientIP{}, reqFrom("[2001:db8::1]:5000"), "2001:db8::1"},
	}
	for _, tc := range cases {
		if got := tc.c.Of(tc.r).String(); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestRateKeyGroupsIPv6By64(t *testing.T) {
	a := rateKey(netip.MustParseAddr("2001:db8:1:2::1"))
	b := rateKey(netip.MustParseAddr("2001:db8:1:2:ffff::9"))
	c := rateKey(netip.MustParseAddr("2001:db8:1:3::1"))
	if a != b || a == c {
		t.Fatalf("keys: %s %s %s", a, b, c)
	}
	if k := rateKey(netip.MustParseAddr("192.0.2.1")); k != "192.0.2.1" {
		t.Fatalf("ipv4 key %s", k)
	}
}

func newLimitedServer(t *testing.T, limit int) (*store.Memory, http.Handler) {
	t.Helper()
	mem := store.NewMemory()
	srv := NewServer(mem, Config{
		BcryptCost: MinBcryptCost, SessionTTL: time.Hour, CookieSecure: true,
		LoginLimiter: NewMemoryLimiter(limit, time.Minute),
		ClientIP:     ClientIP{Trusted: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}},
	})
	h := srv.Routes()
	doJSON(t, h, "POST", "/api/auth/signup", signupBody("ada@example.com"))
	return mem, h
}

func loginFrom(h http.Handler, remote, xff, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"email": "ada@example.com", "password": password})
	req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = remote
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// WI-010 AC1, AC2: the 6th login attempt in a minute from one IP gets 429
// with Retry-After and never reaches credential checks, even with the right
// password.
func TestLoginRateLimitPerIP(t *testing.T) {
	mem, h := newLimitedServer(t, 5)
	const ip = "203.0.113.9:4000"
	for i := range 5 {
		if rec := loginFrom(h, ip, "", "wrong-password"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d, want 401", i+1, rec.Code)
		}
	}
	rec := loginFrom(h, ip, "", "correct-horse")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("6th attempt: got %d %s, want 429", rec.Code, rec.Body)
	}
	// Real clock here: up to 12s, less whatever the five bcrypt compares took.
	if ra, _ := strconv.Atoi(rec.Header().Get("Retry-After")); ra < 1 || ra > 12 {
		t.Fatalf("Retry-After %q, want 1..12", rec.Header().Get("Retry-After"))
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control %q", cc)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] != RateLimitedMessage {
		t.Fatalf("body %s (%v)", rec.Body, err)
	}
	if len(rec.Result().Cookies()) != 0 || mem.SessionCount() != 0 {
		t.Fatal("throttled login issued a session")
	}
	// AC3: another client is not affected.
	if rec := loginFrom(h, "198.51.100.7:4000", "", "correct-horse"); rec.Code != http.StatusOK {
		t.Fatalf("other IP: got %d", rec.Code)
	}
}

// WI-010 AC4: behind a trusted proxy, clients are told apart by
// X-Forwarded-For, and a client cannot escape its bucket by spoofing it.
func TestLoginRateLimitBehindProxy(t *testing.T) {
	_, h := newLimitedServer(t, 2)
	const proxy = "127.0.0.1:9000"
	for range 2 {
		loginFrom(h, proxy, "198.51.100.1", "wrong-password")
	}
	if rec := loginFrom(h, proxy, "6.6.6.6, 198.51.100.1", "wrong-password"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("spoofed XFF escaped the limit: %d", rec.Code)
	}
	if rec := loginFrom(h, proxy, "198.51.100.2", "correct-horse"); rec.Code != http.StatusOK {
		t.Fatalf("second client behind proxy: got %d", rec.Code)
	}
	// An untrusted peer cannot pick its bucket with X-Forwarded-For.
	for range 2 {
		loginFrom(h, "203.0.113.50:1", "", "wrong-password")
	}
	if rec := loginFrom(h, "203.0.113.50:1", "198.51.100.99", "wrong-password"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("untrusted XFF honoured: %d", rec.Code)
	}
}

// WI-010 AC2: a throttled browser gets the login page with a 429 alert.
func TestLoginRateLimitForm(t *testing.T) {
	_, h := newLimitedServer(t, 1)
	form := url.Values{"email": {"ada@example.com"}, "password": {"wrong-password"}}
	postForm(h, "/api/auth/login", form)
	rec := postForm(h, "/api/auth/login", form)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "Too many sign-in attempts") || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("missing alert or Retry-After: %s", rec.Body)
	}
}

// Only login is limited: signup, /login and health checks stay reachable.
func TestRateLimitOnlyOnLogin(t *testing.T) {
	_, h := newLimitedServer(t, 1)
	loginFrom(h, "192.0.2.1:1234", "", "wrong-password")
	loginFrom(h, "192.0.2.1:1234", "", "wrong-password")
	for _, path := range []string{"/healthz", "/login"} {
		if rec := doJSON(t, h, "GET", path, nil); rec.Code != http.StatusOK {
			t.Errorf("GET %s: %d", path, rec.Code)
		}
	}
	if rec := doJSON(t, h, "POST", "/api/auth/signup", signupBody("bob@example.com")); rec.Code != http.StatusCreated {
		t.Errorf("signup: %d", rec.Code)
	}
}
