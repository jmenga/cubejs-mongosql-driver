.PHONY: help install build build:rust build:ts test test:unit test:rust test:integration e2e e2e:up e2e:down e2e:reset lint lint:fix typecheck clean

COMPOSE := docker compose -f tests/integration/docker-compose.test.yml

help:
	@echo "Targets:"
	@echo "  install       pnpm install"
	@echo "  build         build Rust + TypeScript"
	@echo "  test          unit tests (TS + Rust)"
	@echo "  e2e           bring up compose + run integration suite + tear down"
	@echo "  e2e:up        bring up compose only"
	@echo "  e2e:down      tear down compose"
	@echo "  e2e:reset     down -v + up (fresh fixtures)"
	@echo "  lint          eslint + prettier check + cargo fmt check + clippy"
	@echo "  lint:fix      auto-fix"
	@echo "  typecheck     tsc --noEmit"
	@echo "  clean         remove build outputs"

install:
	pnpm install

build: build:rust build:ts

build\:rust:
	pnpm build:rust

build\:ts:
	pnpm build:ts

test: test:unit test:rust

test\:unit:
	pnpm test:unit

test\:rust:
	cargo test --workspace

test\:integration:
	pnpm test:integration

e2e: e2e\:up test\:integration e2e\:down

e2e\:up:
	$(COMPOSE) up -d
	@echo "Waiting for atlas-local to be healthy..."
	@for i in $$(seq 1 30); do \
		if $(COMPOSE) ps --format json atlas-local | grep -q '"Health":"healthy"'; then \
			echo "atlas-local is healthy"; break; \
		fi; \
		sleep 2; \
	done

e2e\:down:
	$(COMPOSE) down

e2e\:reset:
	$(COMPOSE) down -v
	$(MAKE) e2e:up

lint:
	pnpm lint

lint\:fix:
	pnpm lint:fix

typecheck:
	pnpm typecheck

clean:
	rm -rf node_modules dist target npm/*/cubejs-mongosql-driver-native.*.node coverage
