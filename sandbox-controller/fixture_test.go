package main

import (
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Only compiled into the disposable acceptance test binary.
func TestServeFixture(t *testing.T) {
	key := os.Getenv("PI_E2E_CONTROLLER_KEY")
	if key == "" {
		t.Skip("external browser fixture only")
	}
	c := &controller{k: transport("http://127.0.0.1:35326/", http.DefaultClient, func() (string, error) { return key, nil }), c: config{Image: "fixture@sha256:" + strings.Repeat("a", 64), Size: "1Gi"}, idle: time.Minute}
	t.Fatal(http.ListenAndServe("127.0.0.1:35325", handler(c, key)))
}
