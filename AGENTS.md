# AGENTS.md

This file defines the default operating rules for AI coding agents in this repository.

## Scope

- Applies to coding, debugging, refactoring, testing, and deployment-support tasks in this repo.
- Keep responses and plans concise by default unless the user asks for depth.
- Prefer direct implementation over long planning when requirements are clear.

## Project Identity

- Project: **Unofficial Kick App** (`v4.0.0`)
- Stack: **Go backend (stdlib `net/http`) + vanilla JS SPA frontend**
- Module: `kickapi` — entrypoint `cmd/server`, packages under `internal/`
- Primary runtime port: `8081`
- Runs locally, in Docker, and on Raspberry Pi (binary under systemd in production).
- The old Python/FastAPI backend is frozen on the `legacy/python-backend` branch.

## Performance-First Agent Behavior

- Minimize token usage: short output, low repetition, no generic re-explanations.
- Read only files needed for the current task.
- Prefer `rg` / targeted reads over broad scans.
- Avoid loading large docs unless the task explicitly requires them.
- Use existing project patterns; avoid introducing new abstractions unless justified.

## Core Engineering Rules

- Keep route-layer and service-layer responsibilities separated.
- Preserve API response envelope conventions (`status`, `message`, `data`).
- Preserve slug validation (`slugRe` in `internal/httpapi`) and error mapping behavior.
- Maintain cache-key and TTL intent when changing stream/search/viewer endpoints.
- Favor backward-compatible changes unless user requests otherwise.

## Working Rules

- Never revert unrelated user changes.
- Make surgical edits; avoid broad churn.
- Update tests when behavior changes.
- Run targeted tests first, then broader tests if needed.
- Call out unknowns explicitly instead of guessing.

## Kilo Command Permission Compatibility

- Shell commands must be permission-safe in strict sessions.
- Do not use shell metachar patterns commonly denied by policy:
  - pipes (`|`)
  - command chaining (`&&`, `;`)
  - redirection (`>`, `>>`, `2>`)
  - command substitution (`` `...` `` or `$()`)
- Prefer single, plain commands per tool call (for example `ls ...`, `cat ...`, `rg ...`, `git status ...`).
- If a command would normally require a denied pattern, split it into multiple safe commands instead of using one compound command.

## Kilo Tool-Call Stability

- In plan mode, prefer plain text once enough context is gathered.
- In plan mode, inspect with at most 4 tool calls before producing a plan unless a concrete blocker remains.
- In ask mode, answer from existing context when possible and inspect with at most 3 tool calls.
- Use one tool call per assistant step; avoid parallel or nested tool calls in Kilo sessions.
- Do not invent or emit tool-call metadata such as `id` values.
- If a tool schema explicitly requires an `id`, provide it as a plain string only.
- Keep tool arguments minimal and exactly shaped to the target schema.
- Prefer read, grep, glob, and list tools over bash for repository inspection.
- Do not use the question tool unless user input is required to avoid unsafe or destructive action.

## Fast Dev Commands

```bash
# local run
go run ./cmd/server

# tests / static analysis
go test -race ./...
go vet ./...

# health/config quick checks
curl http://localhost:8081/health/live
curl http://localhost:8081/config/languages
```

## Deployment Guardrails (Pi)

- Production on the Pi runs the binary under systemd (`kick-api.service`, `Restart=always`), not Docker.
- Standard cycle: `./scripts/deploy-pi.sh` (cross-compile arm64 -> rsync into the service dir -> `systemctl restart` -> health-check with auto-rollback).
- Logs: `journalctl -u kick-api -f`.
- Do not store credentials in repo; use external env/SSH config.

## Where To Read Extra Detail (On Demand)

- Product/API deep details: `KICK_PUBLIC_API.md`
- Python→Go migration plan: `docs/MIGRATION_GO.md`
- Human-oriented project overview: `README.md`

Use these only when the task needs them.
