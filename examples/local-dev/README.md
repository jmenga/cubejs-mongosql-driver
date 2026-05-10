# Local development with file-mode schema

Iteration loop for hacking on Cube models against `mongodb-atlas-local`, using a **YAML file** as the schema source instead of Atlas's `__sql_schemas` collection.

## What it demonstrates

- File-mode schema (`CUBEJS_MONGOSQL_SCHEMA_SOURCE=file`) — schema-as-code, version-controlled with the cube model.
- No Atlas SQL Interface dependency — works against any MongoDB cluster (atlas-local, vanilla CE, EA without Schema Builder).
- Snappy refresh interval (`30 s`) so schema edits are picked up quickly.
- Bind-mounted `cube.js` + model files for hot-reload without rebuilding the image.

## Why file mode for local dev

- atlas-local doesn't run the Atlas-managed SQL sampler — `__sql_schemas` would always be empty without manual seeding.
- You want one source of truth (`schema.yaml` next to your cube model) and don't want to keep re-seeding a collection.
- It's the path EA users without Schema Builder CLI access also take.

## Files

```
examples/local-dev/
├── README.md             (this file)
├── docker-compose.yaml   (atlas-local + cube, file-mode schema)
├── schema.yaml           (file-mode schema document)
├── seed-data.js          (sample data — orders, users, accounts)
└── cube/
    ├── cube.js
    └── model/
        └── orders.js
```

## Prerequisites

- Docker 25+ with Compose v2.
- The driver tarball built into `examples/docker/pkg/` (this example reuses the Docker example's image — see step 1).

## How to run

```bash
# 1. Build the driver tarball (one-time per code change to the driver itself)
./examples/docker/build-driver.sh

# 2. Build the Cube image with the driver baked in (also one-time per
#    code change; reuses the Dockerfile from examples/docker/)
docker compose -f examples/docker/docker-compose.yaml build

# 3. Start atlas-local + cube in file-mode
docker compose -f examples/local-dev/docker-compose.yaml up -d

# 4. Open the playground
open http://localhost:4000
```

Iterate on `examples/local-dev/cube/model/*.js` — Cube hot-reloads model changes. Iterate on `schema.yaml` — the driver picks up changes within 30 s (the configured `CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC`).

## Expected behaviour

- The `cube` container starts immediately once `atlas-local` is healthy — no waiting for an Atlas SQL sampler.
- `schema.yaml` declares `orders`, `users`, and `accounts`; all three are queryable as SQL tables.
- Adding a field to `schema.yaml` and saving makes that field queryable within 30 s — no container restart.

## Editing the schema

`schema.yaml` is a single-document YAML envelope:

```yaml
schema:
  version: 1
  jsonSchema:
    bsonType: object
    properties:
      <collection_name>:
        bsonType: object
        properties:
          <field>: { bsonType: <bson_type> }
          ...
```

Valid `bsonType` values: `objectId`, `string`, `int`, `long`, `double`, `decimal`, `bool`, `date`, `array`, `object`, `binData`, `null`. See [`tests/integration/fixtures/mongo-schema.yaml`](../../tests/integration/fixtures/mongo-schema.yaml) for a worked example.

## Switching to collection mode

To compare with Atlas's collection-mode behaviour:

1. Set `CUBEJS_MONGOSQL_SCHEMA_SOURCE=collection` in `docker-compose.yaml`.
2. Remove the `CUBEJS_MONGOSQL_SCHEMA_FILE` env var (and the bind mount).
3. Make sure `seed-schemas.js` is bind-mounted into atlas-local's `docker-entrypoint-initdb.d/` (mirror the pattern in [`examples/docker/docker-compose.yaml`](../docker/docker-compose.yaml)).

## Common issues

- **`MONGOSQL_SCHEMA_FILE_NOT_FOUND`** — the bind mount didn't land. Check `docker compose exec cube ls /cube/conf/schema.yaml`.
- **`MONGOSQL_SCHEMA_INVALID`** — YAML parsed but doesn't match the JSON-Schema-shaped envelope. Compare against the example file or the integration fixture.
- **Schema edits not picked up** — refresh hasn't fired yet. Either wait 30 s or restart cube (`docker compose -f examples/local-dev/docker-compose.yaml restart cube`).

## Teardown

```bash
docker compose -f examples/local-dev/docker-compose.yaml down -v
```
