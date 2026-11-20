package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	strictjson "encoding/json/v2"
	"net/http"

	"pi-cloud/sandbox-controller/internal/lifecycle"
)

type Handler interface {
	Act(context.Context, lifecycle.Request) (lifecycle.Response, error)
}

func New(service Handler, key string) http.Handler {
	expected := []byte("Bearer " + key)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost || r.URL.Path != "/v1/lifecycle" {
			w.WriteHeader(404)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), expected) != 1 {
			w.WriteHeader(403)
			return
		}
		var req lifecycle.Request
		if strictjson.UnmarshalRead(http.MaxBytesReader(w, r.Body, 4096), &req, strictjson.RejectUnknownMembers(true)) != nil || !req.Valid() {
			w.WriteHeader(400)
			return
		}
		result, err := service.Act(r.Context(), req)
		if err != nil {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
}
