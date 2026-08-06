# Shenasa — common dev/ops tasks.
# Usage: make <target>

SHELL := /bin/sh
COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose -f deploy/docker-compose.yml" || echo "docker-compose -f deploy/docker-compose.yml")
IDM_DOMAIN ?= idm.example.com
UI_DOMAIN ?=

.PHONY: help setup up down logs bootstrap seed lint test check start release integration image clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## One-command org setup (IDM_DOMAIN=… [UI_DOMAIN=…])
	@if [ -n "$(UI_DOMAIN)" ]; then \
		bash deploy/setup.sh $(IDM_DOMAIN) $(UI_DOMAIN); \
	else \
		bash deploy/setup.sh $(IDM_DOMAIN); \
	fi

up: ## Start the stack (docker compose)
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Follow container logs
	$(COMPOSE) logs -f

bootstrap: ## Recover idm_admin + create the OAuth2 client
	KANIDM_DOMAIN=$(IDM_DOMAIN) bash deploy/bootstrap.sh

seed: ## Optional operator provisioning (no fake data)
	KANIDM_DOMAIN=$(IDM_DOMAIN) bash deploy/seed.sh

lint: ## Syntax-check all JS + index.html references
	node scripts/check-syntax.js

test: ## Run the jsdom smoke tests
	npm test

check: ## lint + test
	npm run check

start: ## Serve the static UI locally for development (port 8080)
	node scripts/serve.js

image: ## Build the shenasa-ui container image
	docker build -f deploy/Dockerfile.ui -t shenasa-ui:latest .

integration: ## Real-Kanidm integration test (requires docker)
	bash test/integration.sh

release: check ## Build a versioned static bundle in dist/
	@version=$$(node -p "require('./package.json').version"); \
	mkdir -p dist/shenasa-ui-$$version; \
	cp index.html dist/shenasa-ui-$$version/; \
	cp -r css js dist/shenasa-ui-$$version/; \
	cd dist && tar -czf shenasa-ui-$$version.tar.gz shenasa-ui-$$version; \
	echo "dist/shenasa-ui-$$version.tar.gz"

clean: ## Remove generated artifacts (keeps deploy/, source, node_modules)
	rm -rf dist deploy/out deploy/ui
	rm -rf deploy/tls/ca-key.pem deploy/tls/ca.pem deploy/tls/chain.pem deploy/tls/key.pem deploy/tls/server.pem
