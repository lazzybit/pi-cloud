package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestBoundary(t *testing.T) {
	for _, body := range []string{`{"action":"acquire","owner":"bad"}`, `{"action":"warm","owner":"` + strings.Repeat("a", 64) + `","id":"x","grants":{"volume":false}}`} {
		var r request
		_ = json.Unmarshal([]byte(body), &r)
		if r.valid() {
			t.Fatal("invalid input accepted")
		}
	}
}
func TestAuthBeforeKube(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/lifecycle", strings.NewReader("{}"))
	w := httptest.NewRecorder()
	handler(nil, "secret").ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
