# Integration tests

End-to-end tests that exercise the driver against real MongoDB (and, in T19, real Cube). Driven by Docker Compose.

## Prerequisites

- Docker Desktop or Docker Engine + Compose v2
- `pnpm install` has been run

## Running

```
make e2e            # full integration suite
pnpm test:integration   # if you've already done `make e2e:up`
```

Sub-targets (defined in the Makefile):

```
make e2e:up         # docker-compose up; wait for healthy
make e2e:down       # tear down
make e2e:reset      # down -v + up — clean slate
```

## Layout

```
tests/integration/
├── docker-compose.test.yml      # mongodb-atlas-local on :27017 with init scripts mounted
├── fixtures/
│   ├── seed-data.js              # mongosh init: seeds orders/users/accounts
│   ├── seed-schemas.js           # mongosh init: writes __sql_schemas docs
│   └── mongo-schema.yaml         # file-mode schema fixture (mirrors above)
├── setup.ts                      # Vitest globalSetup: docker up + wait
├── sanity.test.ts                # asserts harness is healthy
└── (further .test.ts files added per IMPLEMENTATION_PLAN.md T14–T19)
```

## How fixtures load

`mongodb-atlas-local` mounts `/docker-entrypoint-initdb.d/*.js` on first start and runs them via mongosh. Subsequent starts skip init (data persisted in the named volume `atlas-data`). Use `make e2e:reset` to force re-seed.

## Adding a new integration test

1. Pick the relevant task in `IMPLEMENTATION_PLAN.md` (T14–T19).
2. Create `tests/integration/<name>.test.ts`.
3. Use the `MongoSqlDriver` public API — never internals.
4. Assert *both* response shape AND values.
5. If your test needs additional fixtures, extend `seed-data.js` and `seed-schemas.js` (idempotently).
6. Run: `make e2e <name>` (Vitest pattern matching).

## CI

Same Compose file runs in `.github/workflows/e2e.yaml`. The CI runner uses Docker Buildx; tests run in a long-lived `services:` container with port 27017 exposed to the test runner.
