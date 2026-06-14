// Command server is the entrypoint for the Go port of the Kick Stream Proxy
// API. Phase 0: serves the index, languages, health, liveness, and metrics
// endpoints plus static assets, with graceful shutdown.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"kickapi"
	"kickapi/internal/config"
	"kickapi/internal/httpapi"
	"kickapi/internal/logging"
)

func main() {
	// In the distroless Docker image there's no curl/wget, so the healthcheck
	// calls the binary itself with -healthcheck. It makes a quick GET to the
	// liveness endpoint and exits 0/1.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8081"
		}
		resp, err := http.Get("http://localhost:" + port + "/health/live")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := config.Load()
	log := logging.Setup(cfg.LogLevel, cfg.LogFormatJSON)

	app, err := httpapi.New(cfg, log, kickapi.Assets)
	if err != nil {
		return fmt.Errorf("init app: %w", err)
	}

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Cancel the root context on SIGINT/SIGTERM to trigger graceful shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Background: sweep abandoned in-flight dedup markers until shutdown.
	go app.RunSweeper(ctx)
	// Background: pre-warm featured and avatar caches for all languages.
	go app.RunWarmup(ctx)
	// Background: Chromecast status poller, periodic scan, and auto-reconnect.
	go app.RunChromecastTasks(ctx)

	errCh := make(chan error, 1)
	go func() {
		log.Info("server listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
		log.Info("shutdown signal received, draining connections")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("graceful shutdown: %w", err)
		}
		log.Info("shutdown complete")
		return nil
	}
}
