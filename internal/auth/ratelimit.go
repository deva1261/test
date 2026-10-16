package auth

import (
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RateLimitedMessage is the error body of a 429 from the login rate limiter.
const RateLimitedMessage = "too many login attempts, try again later"

// RateLimiter decides whether one more request for key is allowed now. When it
// is not, retryAfter says how long until the next one will be.
type RateLimiter interface {
	Allow(key string) (ok bool, retryAfter time.Duration)
}

// MemoryLimiter allows `limit` requests per `window` per key, as a smooth rate
// with a burst of `limit` (GCRA: one timestamp per key). State is per process,
// so with N replicas a client can make up to N*limit requests per window.
type MemoryLimiter struct {
	interval time.Duration // window / limit: the cost of one request
	burst    time.Duration // window - interval: how far ahead a key may run
	now      func() time.Time

	mu        sync.Mutex
	tat       map[string]time.Time // theoretical arrival time per key
	nextSweep time.Time
	window    time.Duration
}

// NewMemoryLimiter returns a limiter for limit requests per window (limit >= 1).
func NewMemoryLimiter(limit int, window time.Duration) *MemoryLimiter {
	if limit < 1 {
		limit = 1
	}
	interval := window / time.Duration(limit)
	return &MemoryLimiter{
		interval: interval,
		burst:    window - interval,
		window:   window,
		now:      time.Now,
		tat:      make(map[string]time.Time),
	}
}

func (l *MemoryLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweep(now)
	tat := l.tat[key]
	if tat.Before(now) {
		tat = now
	}
	if wait := tat.Sub(now) - l.burst; wait > 0 {
		return false, wait
	}
	l.tat[key] = tat.Add(l.interval)
	return true, 0
}

// sweep drops keys that are back to a full burst, at most once per window,
// so memory stays bounded by the clients seen in the last window.
func (l *MemoryLimiter) sweep(now time.Time) {
	if now.Before(l.nextSweep) {
		return
	}
	for k, t := range l.tat {
		if !t.After(now) {
			delete(l.tat, k)
		}
	}
	l.nextSweep = now.Add(l.window)
}

// Len reports the number of tracked keys (for tests).
func (l *MemoryLimiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.tat)
}

// ClientIP resolves the address a request came from. The TCP peer is used
// unless it is one of the trusted proxies, in which case X-Forwarded-For is
// walked right to left and the first address that is not a trusted proxy wins
// (entries left of it are client-controlled and ignored).
type ClientIP struct {
	Trusted []netip.Prefix
}

func (c ClientIP) trusted(a netip.Addr) bool {
	for _, p := range c.Trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func (c ClientIP) Of(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	peer = peer.Unmap()
	if !c.trusted(peer) {
		return peer
	}
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break // garbage: stop at the last address we could trust
		}
		a = a.Unmap()
		if !c.trusted(a) {
			return a
		}
		peer = a
	}
	return peer
}

// rateKey buckets IPv4 per address and IPv6 per /64, the smallest block a
// single client is usually handed.
func rateKey(a netip.Addr) string {
	if !a.IsValid() {
		return "unknown"
	}
	if a.Is6() {
		p, _ := a.Prefix(64)
		return p.String()
	}
	return a.String()
}

// rateLimit rejects requests over the limit with 429 and Retry-After before
// next runs, so throttled logins never reach bcrypt.
func (s *Server) rateLimit(next http.HandlerFunc) http.HandlerFunc {
	if s.cfg.LoginLimiter == nil {
		return next
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ok, retry := s.cfg.LoginLimiter.Allow(rateKey(s.cfg.ClientIP.Of(r)))
		if ok {
			next(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retry.Seconds()))))
		if isForm(r) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusTooManyRequests)
			loginTmpl.Execute(w, "Too many sign-in attempts. Please wait a minute and try again.") //nolint:errcheck
			return
		}
		writeError(w, http.StatusTooManyRequests, RateLimitedMessage)
	}
}
