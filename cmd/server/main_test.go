package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReadyz(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	var pingErr error
	h := routes(api, func(context.Context) error { return pingErr })

	get := func(path string) int {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec.Code
	}
	if c := get("/readyz"); c != http.StatusOK {
		t.Fatalf("ready: %d", c)
	}
	pingErr = errors.New("down")
	if c := get("/readyz"); c != http.StatusServiceUnavailable {
		t.Fatalf("db down: %d", c)
	}
	if c := get("/api/auth/me"); c != http.StatusTeapot {
		t.Fatalf("api not delegated: %d", c)
	}
}

func TestProbe(t *testing.T) {
	status := http.StatusOK
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("path %s", r.URL.Path)
		}
		w.WriteHeader(status)
	}))
	defer ts.Close()
	_, port, _ := net.SplitHostPort(ts.Listener.Addr().String())

	if err := probe(":" + port); err != nil {
		t.Fatal(err)
	}
	status = http.StatusInternalServerError
	if err := probe(":" + port); err == nil {
		t.Fatal("want error on 500")
	}
}
