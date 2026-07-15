BINARY := kick-api
PKG := ./...

.PHONY: help run build test race vet fmt lint docker deploy clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}'

run: ## Run the server locally (go run ./cmd/server)
	go run ./cmd/server

build: ## Build a stripped binary
	go build -trimpath -ldflags="-s -w" -o $(BINARY) ./cmd/server

test: ## Run the test suite
	go test $(PKG)

race: ## Run tests with the race detector
	go test -race $(PKG)

vet: ## Run go vet
	go vet $(PKG)

fmt: ## Format all Go code
	gofmt -w .

lint: vet ## CI gate: gofmt check + go vet
	@test -z "$$(gofmt -l .)" || { echo "gofmt needed:"; gofmt -l .; exit 1; }

docker: ## Build the Docker image
	docker build -t $(BINARY):latest .

deploy: ## Test, cross-compile, and atomically deploy to the Pi (override PI_HOST)
	./scripts/deploy-pi.sh

clean: ## Remove local build artifacts
	rm -f $(BINARY) kick-api-arm64 kick-api-amd64
