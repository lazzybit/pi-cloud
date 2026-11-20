package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/client-go/rest"
	"pi-cloud/sandbox-controller/internal/httpapi"
	"pi-cloud/sandbox-controller/internal/kube"
	"pi-cloud/sandbox-controller/internal/lifecycle"
)

func TestServeFixture(t *testing.T) {
	key := os.Getenv("PI_E2E_CONTROLLER_KEY")
	if key == "" {
		t.Skip("external browser fixture only")
	}
	cfg := kube.Config{Image: "fixture@sha256:" + strings.Repeat("a", 64), Size: resource.MustParse("1Gi")}
	// The lightweight fixture implements Kubernetes JSON, not its protobuf wire format.
	restConfig := &rest.Config{
		Host: "http://localhost:35326", BearerToken: key, Timeout: 8 * time.Second,
		ContentConfig: rest.ContentConfig{ContentType: "application/json"},
	}
	store, err := kube.Connect(restConfig, "fixture", cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Fatal(http.ListenAndServe("127.0.0.1:35325", httpapi.New(lifecycle.New(store, cfg.ID(), time.Minute), key)))
}

func TestRequestBoundary(t *testing.T) {
	h := httpapi.New(nil, "fixture")
	for _, tc := range []struct {
		body, key string
		code      int
	}{
		{`{}`, "bad", 403},
		{`{"action":"acquire","owner":"bad"}`, "fixture", 400},
		{`{"action":"warm","owner":"` + strings.Repeat("a", 64) + `","id":"x","grants":{}}`, "fixture", 400},
	} {
		r := httptest.NewRequest("POST", "/v1/lifecycle", strings.NewReader(tc.body))
		r.Header.Set("Authorization", "Bearer "+tc.key)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatal(w.Code, tc.code)
		}
	}
}
