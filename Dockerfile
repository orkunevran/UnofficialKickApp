# syntax=docker/dockerfile:1

# ── Stage 1: Build ────────────────────────────────────────────────────────
# Run the compiler on the build host architecture and cross-compile for the
# requested target platform. Docker/BuildKit supplies these values for plain
# builds and for --platform/buildx builds.
FROM --platform=$BUILDPLATFORM golang:1.26.6-bookworm AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# TARGETOS/TARGETARCH are supplied by BuildKit/buildx. A plain build targets the
# current Docker platform; --platform selects another target. Pi production is
# still deployed as a systemd binary via scripts/deploy-pi.sh.
# CGO_ENABLED=0 produces a fully static binary; assets are embedded via //go:embed.
ARG TARGETOS
ARG TARGETARCH
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
