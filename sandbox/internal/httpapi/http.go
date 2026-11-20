package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	strictjson "encoding/json/v2"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"pi-cloud/sandbox/internal/calls"
	"pi-cloud/sandbox/internal/ticket"
)

var idFormat = regexp.MustCompile(`^[a-f0-9]{64}$`)

func New(svc *calls.Service, key, uid string) http.Handler {
	expected := []byte("Bearer " + ticket.ManagementKey(key))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), expected) != 1 {
			w.WriteHeader(403)
			return
		}
		if r.URL.Path == "/health" && (r.Method == http.MethodGet || r.Method == http.MethodPost) {
			boot, active := svc.Health()
			send(w, 200, map[string]any{"boot": boot, "active": active})
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(404)
			return
		}
		switch r.URL.Path {
		case "/cmd":
			var v struct {
				ID      string `json:"id"`
				Boot    string `json:"boot"`
				Command string `json:"command"`
				Ticket  string `json:"ticket"`
			}
			if !decode(w, r, &v) {
				return
			}
			if !idFormat.MatchString(v.ID) || v.Boot == "" || len(v.Command) == 0 || len(v.Command) > 8192 || strings.ContainsRune(v.Command, 0) {
				w.WriteHeader(400)
				return
			}
			if !ticket.Valid(key, uid, v.Boot, v.ID, v.Command, v.Ticket, time.Now()) {
				w.WriteHeader(403)
				return
			}
			respond(w, svc.Start(v.Boot, v.ID, v.Command))
		case "/get", "/cancel":
			var v struct {
				ID   string `json:"id"`
				Boot string `json:"boot"`
			}
			if !decode(w, r, &v) {
				return
			}
			if !idFormat.MatchString(v.ID) || v.Boot == "" {
				w.WriteHeader(400)
				return
			}
			if r.URL.Path == "/cancel" {
				respond(w, svc.Cancel(v.Boot, v.ID))
			} else {
				respond(w, svc.Observe(v.Boot, v.ID))
			}
		default:
			w.WriteHeader(404)
		}
	})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			w.WriteHeader(413)
		} else {
			w.WriteHeader(400)
		}
		return false
	}
	if strictjson.Unmarshal(body, v, strictjson.RejectUnknownMembers(true)) != nil {
		w.WriteHeader(400)
		return false
	}
	return true
}
func respond(w http.ResponseWriter, result calls.Observation) {
	status := 200
	switch result.State {
	case calls.Stale, calls.Conflict, calls.Busy:
		status = 409
	}
	send(w, status, result)
}
func send(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
