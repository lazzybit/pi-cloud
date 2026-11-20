package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"k8s.io/apimachinery/pkg/api/resource"

	"pi-cloud/sandbox-controller/internal/httpapi"
	"pi-cloud/sandbox-controller/internal/kube"
	"pi-cloud/sandbox-controller/internal/lifecycle"
)

var imagePattern = regexp.MustCompile(`@sha256:[a-f0-9]{64}$`)

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
	key := os.Getenv("CONTROLLER_KEY")
	idle, err := strconv.Atoi(setting("IDLE_SECONDS", "600"))
	if err != nil || idle < 1 || idle > 31536000 || len(key) < 32 || !imagePattern.MatchString(os.Getenv("SANDBOX_IMAGE")) {
		return errors.New("invalid controller configuration")
	}
	size, err := resource.ParseQuantity(setting("VOLUME_SIZE", "2Gi"))
	if err != nil || size.Sign() <= 0 {
		return errors.New("invalid volume size")
	}
	cfg := kube.Config{Image: os.Getenv("SANDBOX_IMAGE"), RuntimeClass: os.Getenv("RUNTIME_CLASS"), Revision: setting("PROFILE_REVISION", "1"), StorageClass: os.Getenv("STORAGE_CLASS"), Size: size}
	ns, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if err != nil {
		return err
	}
	store, err := kube.InCluster(strings.TrimSpace(string(ns)), cfg)
	if err != nil {
		return err
	}
	svc := lifecycle.New(store, cfg.ID(), time.Duration(idle)*time.Second)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if svc.Sweep(ctx) != nil {
					log.Print("sandbox cleanup unavailable")
				}
			}
		}
	}()
	srv := &http.Server{Addr: ":8081", Handler: httpapi.New(svc, key), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: time.Minute}
	go func() { <-ctx.Done(); _ = srv.Close() }()
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
