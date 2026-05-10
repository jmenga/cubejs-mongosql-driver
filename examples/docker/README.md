# Docker example — Cube + atlas-local + the driver

End-to-end working setup that spins up `mongodb-atlas-local` and a Cube image with `mongosql-cubejs-driver` installed. Used by `tests/integration/cube-e2e.test.ts` and is the recommended starting point for trying the driver.

## What it demonstrates

- The driver loaded into the official `cubejs/cube` image (built via the `Dockerfile` here).
- Cube auto-resolving `CUBEJS_DB_TYPE=mongosql` to our package via the `${type}-cubejs-driver` convention (T19b).
- Schema sourced from the seeded `__sql_schemas` collection (collection mode).
- A working `cube('orders', ...)` model querying real data, served from the playground at `http://localhost:4000`.

## Prerequisites

- Docker 25+ with Buildx (default in Desktop 4.x and Engine 25+).
- `pnpm` and Rust toolchain are NOT required — the Dockerfile builds the native binary in-image.
- ~2.5 GB free disk for the build cache and base images (cube + node + mongodb-atlas-local).

## Layout

```
examples/docker/
├── Dockerfile             # Two-stage: Rust builder → cubejs/cube + driver
├── docker-compose.yaml    # atlas-local + cube services on a shared network
├── build-driver.sh        # Builds dist/ + npm pack tarball into pkg/
├── pkg/                   # Output of build-driver.sh (committed for offline runs)
└── cube/
    ├── cube.js            # driverFactory + dialectFactory wiring
    └── model/
        └── orders.js      # Sample Cube model against the seeded `orders`
```

## How to run

```bash
# 1. From the repo root, build a tarball of the driver into pkg/
./examples/docker/build-driver.sh

# 2. Build the Cube image (this also compiles the Rust .node binary)
docker compose -f examples/docker/docker-compose.yaml build

# 3. Start atlas-local + cube
docker compose -f examples/docker/docker-compose.yaml up -d

# 4. Wait for both services to report healthy (~ 30–60 s)
docker compose -f examples/docker/docker-compose.yaml ps

# 5. Open the Cube playground
open http://localhost:4000
```

The playground will let you:

- Browse the `Orders` cube on the left.
- Pick the `count` and `totalAmount` measures, group by `accountId`, and run a query.
- Inspect the generated SQL (which goes through `MongoSqlQuery`'s dialect overrides).

## Expected behaviour

- **`docker compose up -d`** brings both services up, with `cube` healthy after `atlas-local` is healthy. First run takes ~3–5 minutes (Rust compile + image layers); subsequent runs are warm-cache.
- **Cube playground** at `http://localhost:4000` shows one cube (`Orders`) with three dimensions (`accountId`, `status`, `createdAt`) and two measures (`count`, `totalAmount`).
- **Sample query**: `count` measure grouped by `accountId` returns `acct_a → 3`, `acct_b → 2` (matches `tests/integration/fixtures/seed-data.js`).
- **`totalAmount`** is returned as a string (Decimal128 round-trip — see [README → Type handling](../../README.md#decimal128-returns-as-strings--by-design)).

## Common issues

- **`Unable to acquire security key[s]` on first boot of atlas-local** — race condition in atlas-local's keyfile bootstrap. Fix: `docker compose down -v` then `up -d` again.
- **Cube logs `Unsupported db type: mongosql`** — usually means the driver wasn't installed at the right name. Confirm `node_modules/mongosql-cubejs-driver/package.json` exists in the running container.
- **`MONGOSQL_SCHEMA_NOT_FOUND`** — the `seed-schemas.js` init script didn't run. Force a clean boot: `docker compose down -v && docker compose up -d`.

## Teardown

```bash
docker compose -f examples/docker/docker-compose.yaml down -v
```

The `-v` removes the atlas-local volume so the next run starts from clean fixtures.

## Extending

To point Cube at a different database, edit `docker-compose.yaml`:

- **Real Atlas cluster**: replace `CUBEJS_DB_URI` with your `mongodb+srv://...` string and remove the `atlas-local` service / `depends_on`.
- **Different schema source**: set `CUBEJS_MONGOSQL_SCHEMA_SOURCE=file` and mount a YAML schema at a known path; set `CUBEJS_MONGOSQL_SCHEMA_FILE` accordingly. See [`examples/local-dev/`](../local-dev/) for a worked example.
- **Custom Cube model**: edit `cube/model/orders.js` (live-mounted via `COPY` at build time, but you can volume-mount it for hot-reload during development).
