package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pi-cloud/sandbox/internal/calls"
	"pi-cloud/sandbox/internal/process"
	"pi-cloud/sandbox/internal/ticket"
)

func TestCallContract(t *testing.T) {
	var starts atomic.Int32
	svc := calls.New("boot", func(ctx context.Context, cmd string, stdout, stderr *process.Stream) process.Result {
		starts.Add(1)
		stdout.Write([]byte("out"))
		stderr.Write([]byte("err"))
		<-ctx.Done()
		return process.Result{Output: process.Output{Stdout: "out", Stderr: "err"}, ExitCode: 130}
	})
	defer svc.Close()
	h := New(svc, "secret", "pod-a")
	manage := ticket.ManagementKey("secret")
	startBody := func(id, command string) map[string]any {
		digest := sha256.Sum256([]byte(command))
		expiry := strconv.FormatInt(time.Now().Add(5*time.Second).UnixMilli(), 10)
		mac := hmac.New(sha256.New, []byte("secret"))
		mac.Write([]byte(strings.Join([]string{"pi-sandbox:start:v1", "pod-a", "boot", id, hex.EncodeToString(digest[:]), expiry}, "\n")))
		return map[string]any{"id": id, "boot": "boot", "command": command, "ticket": expiry + "." + hex.EncodeToString(mac.Sum(nil))}
	}
	ask := func(path, key string, body any, status int) map[string]any {
		t.Helper()
		data, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(data)))
		req.Header.Set("Authorization", "Bearer "+key)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("%s: %d, want %d (%s)", path, w.Code, status, w.Body)
		}
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	id := strings.Repeat("a", 64)
	req := startBody(id, "fixed command")
	ask("/cmd", manage, map[string]any{"id": id, "boot": "boot", "command": "fixed command"}, 403)
	changed := startBody(id, "fixed command")
	changed["command"] = "changed"
	ask("/cmd", manage, changed, 403)
	ask("/cmd", "bad", req, 403)
	ask("/cmd", manage, req, 200)
	ask("/cmd", manage, req, 200)
	ask("/cmd", manage, startBody(id, "different"), 409)
	ask("/cmd", manage, startBody(strings.Repeat("b", 64), "fixed"), 409)
	stale := map[string]any{"id": id, "boot": "old"}
	ask("/get", manage, stale, 409)
	ask("/cancel", manage, stale, 409)
	current := map[string]any{"id": id, "boot": "boot"}
	ask("/cancel", manage, current, 200)
	for stop := time.Now().Add(time.Second); ; {
		r := ask("/get", manage, current, 200)
		if r["state"] == "done" {
			if r["result"].(map[string]any)["stderr"] != "err" {
				t.Fatal(r)
			}
			break
		}
		if time.Now().After(stop) {
			t.Fatal("call not cancelled")
		}
		time.Sleep(time.Millisecond)
	}
	if starts.Load() != 1 {
		t.Fatal("repeated execution")
	}
	ask("/cmd", manage, map[string]any{"id": id, "boot": "boot", "command": "bad\x00input"}, 400)
}
