# ── Stage 1: Build ────────────────────────────────────────────────────────
FROM golang:1.24-bookworm AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# TARGETOS/TARGETARCH are supplied by BuildKit/buildx (one per --platform) and
# default to linux/amd64 for a plain `docker build`, so the image is runnable on
# the build host (incl. CI). The Pi production binary is built separately by
# scripts/deploy-pi.sh (arm64) and run under systemd — not from this image.
# CGO_ENABLED=0 produces a fully static binary; assets are embedded via //go:embed.
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /kick-api ./cmd/server

# ── Stage 2: Runtime ──────────────────────────────────────────────────────
# distroless/static has no shell, no package manager, and nothing else —
# just the binary and its embedded assets.
FROM gcr.io/distroless/static-debian12:nonroot

LABEL org.opencontainers.image.title="Unofficial Kick App (Go)" \
      org.opencontainers.image.description="Self-hosted Go proxy for Kick.com streams" \
      org.opencontainers.image.version="4.0.0"

COPY --from=builder /kick-api /kick-api

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/kick-api", "-healthcheck"]

ENTRYPOINT ["/kick-api"]
