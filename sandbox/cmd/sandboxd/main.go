package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pi-cloud/sandbox/internal/calls"
	"pi-cloud/sandbox/internal/httpapi"
	"pi-cloud/sandbox/internal/process"
)

func setting(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
func main() {
	if err := serve(); err != nil {
		log.Fatal(err)
	}
}
func serve() error {
	key := os.Getenv("RUNTIME_KEY")
	uid := os.Getenv("SANDBOX_POD_UID")
	if len(key) < 32 || uid == "" {
		return errors.New("credential required")
	}
	runner := process.Runner{Guard: setting("GUARD", "/opt/terminal/guard"), Workspace: setting("WORKSPACE", "/workspace"), Limit: 30 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runner.Check(ctx); err != nil {
		return err
	}
	var random [16]byte
	rand.Read(random[:])
	svc := calls.New(hex.EncodeToString(random[:]), runner.Run)
	defer svc.Close()
	listener, err := net.Listen("tcp", net.JoinHostPort(setting("BIND", "0.0.0.0"), setting("PORT", "8282")))
	if err != nil {
		return err
	}
	server := &http.Server{Handler: httpapi.New(svc, key, uid), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 6 * time.Second, WriteTimeout: 8 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	go func() { <-ctx.Done(); _ = server.Close() }()
	// Fixture readiness listens on stdout; serve only after the guard self-check.
	os.Stdout.WriteString("ready\n")
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
