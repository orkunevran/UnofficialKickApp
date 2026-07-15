# Contributing

Thanks for your interest in improving Unofficial Kick App! This is a single Go
binary that proxies Kick.com and serves a vanilla-JS SPA. No build step for the
frontend, no database, no codegen.

## Getting started

```bash
git clone https://github.com/orkunevran/UnofficialKickApp.git
cd UnofficialKickApp
make run            # or: go run ./cmd/server  →  http://localhost:8081
```

Requires **Go 1.25+**. Production and CI use Go 1.26.5. Copy `.env.example` to `.env` to document overrides (the Go binary reads process environment variables directly).

## Before you open a PR

```bash
make lint           # gofmt check + go vet
make race           # go test -race ./...
```

CI runs the same checks (`gofmt`, `go vet`, `go test -race`, `docker build`) and
must be green. Keep `gofmt` clean — formatting is enforced.

## Conventions

- **Layout:** entrypoint in `cmd/server`; everything else under `internal/`.
  Keep the route layer (`internal/httpapi`) separate from the service layers
  (`internal/kick`, `internal/chromecast`).
- **API contract:** preserve the `{status, message, data}` JSON envelope, slug
  validation, and the cache-key / TTL intent. Contract changes need updated
  tests in `internal/httpapi/parity_test.go`.
- **Tests:** add or adjust tests when behavior changes; concurrency-sensitive
  code must pass `-race`.
- **Frontend:** vanilla JS ES modules, no build step; render via the string
  templates in `static/js/ui.js`. Keep it keyboard-accessible (ARIA + focus).
- **Commits/PRs:** small, focused changes with a clear description.

## Project docs

- [`docs/architecture.md`](docs/architecture.md) — modules and data-flow
- [`docs/KICK_PUBLIC_API.md`](docs/KICK_PUBLIC_API.md) — upstream Kick API reference
- [`docs/MIGRATION_GO.md`](docs/MIGRATION_GO.md) — history of the Python→Go rewrite

By contributing you agree your work is licensed under the project's [MIT License](LICENSE).
