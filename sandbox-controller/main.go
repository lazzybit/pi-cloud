package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func transport(base string, client *http.Client, token func() (string, error)) kube {
	return func(ctx context.Context, method, path string, in any) (*object, error) {
		var body io.Reader
		if in != nil {
			b, e := json.Marshal(in)
			if e != nil {
				return nil, e
			}
			body = bytes.NewReader(b)
		}
		q, e := http.NewRequestWithContext(ctx, method, base+path, body)
		if e != nil {
			return nil, e
		}
		t, e := token()
		if e != nil {
			return nil, e
		}
		q.Header.Set("Authorization", "Bearer "+t)
		ct := "application/json"
		if method == "PATCH" {
			ct = "application/merge-patch+json"
		}
		q.Header.Set("Content-Type", ct)
		r, e := client.Do(q)
		if e != nil {
			return nil, e
		}
		defer r.Body.Close()
		if r.StatusCode == 404 && method == "GET" {
			return nil, nil
		}
		if r.StatusCode/100 != 2 {
			return nil, fmt.Errorf("kubernetes %d", r.StatusCode)
		}
		var out object
		e = json.NewDecoder(r.Body).Decode(&out)
		return &out, e
	}
}
func handler(c *controller, key string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != "POST" || r.URL.Path != "/v1/lifecycle" {
			w.WriteHeader(404)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+key)) != 1 {
			w.WriteHeader(403)
			return
		}
		var req request
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		d.DisallowUnknownFields()
		if d.Decode(&req) != nil || d.Decode(new(any)) != io.EOF || !req.valid() {
			w.WriteHeader(400)
			return
		}
		v, e := c.act(r.Context(), req)
		if e != nil {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	})
}
func setting(name, def string) string {
	if s := os.Getenv(name); s != "" {
		return s
	}
	return def
}
func main() {
	const sa = "/var/run/secrets/kubernetes.io/serviceaccount/"
	ca, e := os.ReadFile(sa + "ca.crt")
	if e != nil {
		log.Fatal(e)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		log.Fatal("invalid CA")
	}
	ns, e := os.ReadFile(sa + "namespace")
	if e != nil {
		log.Fatal(e)
	}
	httpClient := &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	k := transport("https://kubernetes.default.svc/api/v1/namespaces/"+strings.TrimSpace(string(ns))+"/", httpClient, func() (string, error) { b, e := os.ReadFile(sa + "token"); return strings.TrimSpace(string(b)), e })
	key := os.Getenv("CONTROLLER_KEY")
	cfg := config{os.Getenv("SANDBOX_IMAGE"), os.Getenv("RUNTIME_CLASS"), setting("PROFILE_REVISION", "1"), os.Getenv("STORAGE_CLASS"), setting("VOLUME_SIZE", "2Gi")}
	idle, e := strconv.Atoi(setting("IDLE_SECONDS", "600"))
	if e != nil || idle < 1 || idle > 31536000 || len(key) < 32 || !imagePattern.MatchString(cfg.Image) {
		log.Fatal("invalid controller configuration")
	}
	c := &controller{k: k, c: cfg, idle: time.Duration(idle) * time.Second}
	go func() {
		for range time.Tick(5 * time.Second) {
			if c.sweep(context.Background()) != nil {
				log.Print("reconcile unavailable")
			}
		}
	}()
	log.Fatal((&http.Server{Addr: ":8081", Handler: handler(c, key), ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: time.Minute}).ListenAndServe())
}
