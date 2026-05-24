/**
 * IMPLEMENTATION_PLAN T19 — E2E test against the cubejs/cube image
 * extended with our driver.
 *
 * This is the "real" integration test: a running Cube server, our
 * driver loaded as a community driver via `cube.js`'s `driverFactory`
 * + `dialectFactory` overrides (see `examples/docker/cube/cube.js`),
 * a sample model (`examples/docker/cube/model/orders.js`) over the
 * seeded `orders` collection, and HTTP queries through Cube's public
 * API.
 *
 * The compose stack (atlas-local + cube) is brought up and torn down
 * by `tests/cube-e2e/setup.ts`. By the time this file runs:
 *   * atlas-local is healthy,
 *   * `__sql_schemas` has the orders/users/accounts entries seeded,
 *   * Cube's /readyz returns 200, meaning the schema compiled and the
 *     driver loaded.
 *
 * Asserted contracts:
 *   * Cube successfully resolves our driver via the `driverFactory` +
 *     `dialectFactory` + alias-install workaround documented in
 *     `examples/docker/cube/cube.js` and `examples/docker/Dockerfile`.
 *   * Response shape matches Cube's documented Load API
 *     ({ data, query, lastRefreshTime, dbType: 'mongosql', ... } per
 *      https://cube.dev/docs/rest-api).
 *   * `orders.count` measure aggregates correctly across all 5 seeded
 *     rows (=5).
 *   * `orders.totalAmount` (a SUM over Decimal128 amounts) preserves
 *     the input scale per critic v2 issue 3 — STRING-form decimal,
 *     never a JS float. Total = 150+200.50+99.99+320+75.25 = 845.74.
 *
 * T19a follow-up (RESOLVED): mongosql v1.8.5's algebrizer rejected
 * qualified `<alias>.<col>` refs in single-cube projections (Error 3008).
 * MongoSqlQuery now overrides `autoPrefixWithCubeName` to drop the alias
 * prefix when `this.join.joins.length === 0`, so `dimensions: [...]`
 * queries on single-cube models now work. Covered below by the
 * "dimension query" test, which would have failed pre-fix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

const CUBE_URL = process.env.CUBE_E2E_URL ?? 'http://localhost:4000';
const LOAD_ENDPOINT = `${CUBE_URL}/cubejs-api/v1/load`;
const META_ENDPOINT = `${CUBE_URL}/cubejs-api/v1/meta`;
// Dev mode disables JWT verification, but Cube still expects the header.
// The literal value below matches CUBEJS_API_SECRET in docker-compose.yaml.
const AUTH_HEADER = 'e2e-test-secret-not-for-prod';

interface CubeLoadResponse {
  data: Array<Record<string, unknown>>;
  query?: unknown;
  lastRefreshTime?: string;
  dbType?: string;
  // Top-level `usedPreAggregations` is emitted whenever Cube routes
  // the query through a materialized rollup. Asserting it is non-empty
  // in the partitioned-rollup tests guards against a silent fallback
  // to direct query — see those tests for the regression rationale.
  usedPreAggregations?: Record<string, unknown>;
  // Cube returns more fields (annotation, slowQuery, etc.); we only
  // assert what we depend on.
}

interface CubeMetaResponse {
  cubes: Array<{ name: string; measures: unknown[]; dimensions: unknown[] }>;
}

async function loadQuery(body: object, attempt = 1): Promise<CubeLoadResponse> {
  const res = await fetch(LOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: AUTH_HEADER,
    },
    body: JSON.stringify(body),
  });

  // Cube returns 200 with `{ error: 'Continue wait' }` while a query
  // is being computed; clients are expected to poll until the result
  // is ready. Mirror that here so the test isn't flaky on cold cache.
  if (res.ok) {
    const json = (await res.json()) as CubeLoadResponse | { error: string };
    if ('error' in json && typeof json.error === 'string' && /continue wait/i.test(json.error)) {
      if (attempt > 30) {
        throw new Error(`Cube returned "Continue wait" 30 times — aborting`);
      }
      await new Promise((r) => setTimeout(r, 1000));
      return loadQuery(body, attempt + 1);
    }
    return json as CubeLoadResponse;
  }

  const text = await res.text();
  throw new Error(`Cube load failed: HTTP ${res.status} — ${text}`);
}

describe('Cube E2E — mongosql-cubejs-driver via cubejs/cube image', () => {
  beforeAll(async () => {
    // /readyz is checked in setup.ts; an additional /meta call here
    // confirms the schema/cube are visible to the API gateway, not just
    // that the worker is up. Failing here means the model file mounted
    // but the cube didn't compile — typically a sign that the driver's
    // `tablesSchema()` failed (e.g. missing __sql_schemas row).
    const res = await fetch(META_ENDPOINT, {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(res.ok, `Cube /meta returned ${res.status}`).toBe(true);
    const meta = (await res.json()) as CubeMetaResponse;
    expect(meta.cubes.map((c) => c.name)).toContain('orders');
    // revenue_events cube was added for the multi-partition rollup test
    // (Critic v3 — Issue #2). Failing here means the model didn't compile
    // — typically a missing __sql_schemas row or a Cube model syntax error.
    expect(meta.cubes.map((c) => c.name)).toContain('revenue_events');
  }, 60_000);

  afterAll(() => {
    // Compose teardown is handled by globalSetup return value. Nothing
    // to do here — leaving the hook present so the suite has a
    // consistent shape and any test-specific resources can be released
    // here in future without restructuring.
  });

  it('CUBEJS_MONGOSQL_APP_NAME reaches MongoDB (env → URI → server)', async () => {
    // The docker-compose under examples/docker sets
    // `CUBEJS_MONGOSQL_APP_NAME=cube-e2e-driver`. The driver's
    // src/config.ts maps that to `appName=cube-e2e-driver` on the URI,
    // and the mongodb crate forwards it as the client `appName` on every
    // connection. MongoDB surfaces it via `$currentOp.appName` and
    // `db.serverStatus().connections`-adjacent reflections.
    //
    // We trigger an active op (a real query through Cube), then poll
    // `$currentOp` from atlas-local for an op whose `appName` matches.
    // Polling rather than a single check, because Mongo retires the op
    // entry as soon as the query completes.
    const appName = 'cube-e2e-driver';

    // Issue a query so a client connection is live.
    await loadQuery({ query: { measures: ['orders.count'] } });

    // execSync wraps the command in `/bin/sh -c '<cmd>'`. Feed the
    // script to mongosh on stdin so the outer shell never sees the
    // `$` characters used by mongo aggregation operators (`$currentOp`,
    // `$match`, ...). Wrap with `print(...)` so the REPL emits a
    // single-line marker we can match against. `--norc` skips
    // ~/.mongoshrc on the container.
    const compose = (script: string): string =>
      execSync(
        `docker compose -f examples/docker/docker-compose.yaml exec -T atlas-local mongosh --quiet --norc -u admin -p admin --authenticationDatabase admin`,
        { encoding: 'utf-8', input: `print(${script})\n` },
      ).trim();

    // idleConnections:true so the appName tag on a recently-served-then-
    // pooled connection is still visible after the query returned.
    const out = compose(
      `JSON.stringify(db.getSiblingDB('admin').aggregate([{$currentOp:{allUsers:true,idleConnections:true}},{$match:{appName:${JSON.stringify(appName)}}},{$limit:1},{$project:{appName:1,_id:0}}]).toArray())`,
    );
    expect(out).toContain(appName);
  }, 30_000);

  it('count measure — basic load returns the documented Cube load shape', async () => {
    const body = await loadQuery({
      query: {
        measures: ['orders.count'],
      },
    });

    // Cube's Load API contract — `data` is the row array, `query` is
    // the normalized query, `lastRefreshTime` is the cache marker.
    // `dbType` echoes the driver type Cube routed to — confirming the
    // factory wired up correctly.
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body).toHaveProperty('query');
    expect(body).toHaveProperty('lastRefreshTime');
    expect(body.dbType).toBe('mongosql');

    // Single aggregate row. Per fixture: 5 orders total.
    expect(body.data.length).toBe(1);
    const count = Number(body.data[0]?.['orders.count']);
    expect(count).toBe(5);
  });

  it('totalAmount measure — Decimal128 SUM preserves precision (critic v2 issue 3)', async () => {
    const body = await loadQuery({
      query: {
        measures: ['orders.totalAmount'],
      },
    });

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.dbType).toBe('mongosql');

    const raw = body.data[0]?.['orders.totalAmount'];
    // The driver returns Decimal128 SUM as a STRING to preserve scale
    // (T14 discovery: trailing-zero preservation + 30-digit round-trip
    // pinned in tests/integration/basic-queries.test.ts). The HTTP
    // path round-trips through JSON; Cube's serialiser does NOT coerce
    // it to a number for `type: sum` over a string-shaped value.
    expect(typeof raw).toBe('string');

    // Numeric value: 150.00 + 200.50 + 99.99 + 320.00 + 75.25 = 845.74.
    expect(Number(raw)).toBeCloseTo(845.74, 2);
    // Scale preserved: the string contains exactly two decimal places.
    expect(String(raw)).toBe('845.74');
  });

  it('multi-measure query — count + totalAmount combine in one row', async () => {
    const body = await loadQuery({
      query: {
        measures: ['orders.count', 'orders.totalAmount'],
      },
    });

    expect(body.data.length).toBe(1);
    const row = body.data[0];
    expect(Number(row?.['orders.count'])).toBe(5);
    // String-typed sum survives composition with int-typed count.
    expect(typeof row?.['orders.totalAmount']).toBe('string');
    expect(row?.['orders.totalAmount']).toBe('845.74');

    // Annotation block is emitted alongside the data — Cube clients
    // depend on it for column-titles / formatting metadata.
    expect(body).toHaveProperty('query');
    expect(body).toHaveProperty('lastRefreshTime');
  });

  it('meta endpoint — orders cube exposes the configured measures', async () => {
    const res = await fetch(META_ENDPOINT, {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(res.ok).toBe(true);
    const meta = (await res.json()) as CubeMetaResponse;
    const orders = meta.cubes.find((c) => c.name === 'orders');
    expect(orders).toBeDefined();
    // The model declares `count` + `totalAmount` measures.
    const measureNames = (orders?.measures as Array<{ name: string }>).map((m) => m.name);
    expect(measureNames).toContain('orders.count');
    expect(measureNames).toContain('orders.totalAmount');
    // T19a fix: dimensions are now usable via /load (the qualified-ref
    // override in MongoSqlQuery.autoPrefixWithCubeName suppresses the
    // alias prefix on single-cube projections).
    const dimNames = (orders?.dimensions as Array<{ name: string }>).map((d) => d.name);
    expect(dimNames).toContain('orders.accountId');
    expect(dimNames).toContain('orders.status');
    expect(dimNames).toContain('orders.createdAt');
  });

  // ---------------------------------------------------------------------------
  // Multi-partition rollup — Critic v3 — Issue #2.
  //
  // The `revenue_events` cube declares a monthly-partitioned
  // pre-aggregation over `occurred_at`. The seed data spans Jan/Feb/Mar
  // 2026, so a query covering the full range forces Cube Store to
  // materialize and UNION three partitions. Pre-fix, the UNION failed
  // with `type_coercion ... Timestamp vs Int64` because the driver's
  // `downloadQueryResults` typed every aggregate column as `text`
  // (mongosql emits `any_of: [Decimal, Null]` / `[Int, Long]` for
  // SUM/COUNT and the old code couldn't see past `bson_type: None`).
  //
  // Asserts:
  //   - measures come back as numeric-compatible values (the JSON
  //     wire form may stringify the decimal SUM per the BSON-marshal
  //     contract; `Number(...)` must still produce the expected total).
  //   - count = 7 rows total across all three months.
  //   - totalAmount = 350.50 + 200.25 + 399.99 = 950.74.
  // ---------------------------------------------------------------------------
  it('partitioned rollup — query spanning 3 months UNIONs partitions correctly', async () => {
    const body = await loadQuery({
      query: {
        measures: ['revenue_events.count', 'revenue_events.totalAmount'],
        // Time dimension with date range forces Cube to expand the
        // partitions and UNION them. Per the seed, the data is
        // 2026-01-05..2026-03-28; we request a slightly wider window
        // so all three partitions definitely participate.
        timeDimensions: [
          {
            dimension: 'revenue_events.occurredAt',
            dateRange: ['2026-01-01', '2026-03-31'],
          },
        ],
      },
    });

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.dbType).toBe('mongosql');

    // Prove the rollup was actually used. The whole point of this test
    // is to exercise the multi-partition UNION codepath; a future
    // regression that silently disables pre-aggregations (e.g. a
    // schema-compile race) could let the numeric totals still pass by
    // falling back to direct query — silently weakening the regression
    // harness. The top-level `usedPreAggregations` field is emitted
    // only when Cube routes through a materialized rollup.
    expect(body.usedPreAggregations).toBeDefined();
    expect(typeof body.usedPreAggregations).toBe('object');
    expect(Object.keys(body.usedPreAggregations ?? {}).length).toBeGreaterThan(0);

    // The query has no dimension groupings, so it collapses to one
    // row per time bucket emitted by Cube's `granularity` default.
    // Sum across all returned buckets — the totals must match the seed
    // exactly regardless of how Cube rolls them up.
    const totalCount = body.data.reduce((acc, r) => acc + Number(r['revenue_events.count'] ?? 0), 0);
    expect(totalCount).toBe(7);

    const totalAmountSum = body.data.reduce((acc, r) => acc + Number(r['revenue_events.totalAmount'] ?? 0), 0);
    expect(totalAmountSum).toBeCloseTo(950.74, 2);
  });

  it('partitioned rollup — count by category preserves numeric type across partitions', async () => {
    // Group by `category` AND time. With monthly partitioning, the
    // multi-month UNION exercises the exact `account_id-style + Int+Long`
    // shape the regression test pins at the Rust level.
    const body = await loadQuery({
      query: {
        measures: ['revenue_events.count', 'revenue_events.totalAmount'],
        dimensions: ['revenue_events.category'],
        timeDimensions: [
          {
            dimension: 'revenue_events.occurredAt',
            dateRange: ['2026-01-01', '2026-03-31'],
          },
        ],
      },
    });

    expect(body).toHaveProperty('data');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.dbType).toBe('mongosql');

    // Same rollup-usage assertion as the previous test — the multi-
    // partition UNION codepath only fires when the rollup is
    // materialized, so a silently-disabled pre-aggregation would
    // weaken the regression harness without failing the numeric
    // assertions below.
    expect(body.usedPreAggregations).toBeDefined();
    expect(typeof body.usedPreAggregations).toBe('object');
    expect(Object.keys(body.usedPreAggregations ?? {}).length).toBeGreaterThan(0);

    // The seed has two categories: `subscription` (4 events, 100+200+125.25+300 = 725.25)
    // and `usage` (3 events, 50.50+75+99.99 = 225.49). Sum across buckets
    // (Cube may split each category by month).
    const byCategory: Record<string, { count: number; total: number }> = {};
    for (const row of body.data) {
      const cat = String(row['revenue_events.category']);
      const c = Number(row['revenue_events.count'] ?? 0);
      const t = Number(row['revenue_events.totalAmount'] ?? 0);
      if (!byCategory[cat]) byCategory[cat] = { count: 0, total: 0 };
      byCategory[cat].count += c;
      byCategory[cat].total += t;
    }
    expect(byCategory.subscription).toBeDefined();
    expect(byCategory.usage).toBeDefined();
    expect(byCategory.subscription.count).toBe(4);
    expect(byCategory.subscription.total).toBeCloseTo(725.25, 2);
    expect(byCategory.usage.count).toBe(3);
    expect(byCategory.usage.total).toBeCloseTo(225.49, 2);
  });

  // ---------------------------------------------------------------------------
  // Large-IN-list workaround — Cube /load with 200 `equals` values.
  //
  // Pre-fix: a Cube query whose `filter: { equals: [v1..vN] }` translates
  // to SQL `IN (v1..vN)` would bust MongoDB's max BSON nested-object
  // depth (100) for N ≥ ~100 — the Atlas SQL endpoint emitted a
  // right-leaning binary-`$or` chain, and the server rejected the
  // aggregate with `Error code 15 (Overflow)`. Post-fix the driver's
  // pipeline_rewrite pass flattens the chain and collapses to `$in`, so
  // the server accepts the query.
  //
  // The atlas-local image happens to emit a flat `$or` already at
  // v1.8.5, so the cube-e2e (which runs against atlas-local) pins the
  // end-to-end correctness path: the rewrite must NOT corrupt a valid
  // query, and the server must accept the (now `$in`-collapsed) form.
  // ---------------------------------------------------------------------------
  it('large IN list — Cube /load with 200 equals values returns rows, not BSON depth overflow', async () => {
    const values: string[] = [];
    for (let i = 0; i < 200; i++) values.push(`synthetic_v${i}`);
    // Append a real seeded `acct_a` value so the query has both
    // a non-trivial IN size AND a non-empty result set.
    values.push('acct_a');

    const body = await loadQuery({
      query: {
        measures: ['orders.count'],
        dimensions: ['orders.accountId'],
        filters: [
          {
            member: 'orders.accountId',
            operator: 'equals',
            values,
          },
        ],
      },
    });

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.dbType).toBe('mongosql');
    // The seed has 3 acct_a orders, so the count must be 3 when grouped
    // by accountId. Synthetic values match nothing. The important
    // assertion is that the query SUCCEEDED — pre-fix it would have
    // failed with the server-side BSON depth overflow.
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.['orders.accountId']).toBe('acct_a');
    expect(Number(body.data[0]?.['orders.count'])).toBe(3);
  });

  it('dimension query — count grouped by status (T19a regression test)', async () => {
    // Pre-T19a fix: this query failed with mongosql Error 3008 because
    // BaseQuery emitted `\`orders\`.status` in the SELECT projection.
    // Post-fix: the dialect drops the alias prefix on single-cube
    // projections and the query returns one row per distinct status.
    const body = await loadQuery({
      query: {
        measures: ['orders.count'],
        dimensions: ['orders.status'],
      },
    });
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    // Seed has 3 paid + 1 pending + 1 refunded = 3 distinct statuses.
    expect(body.data.length).toBe(3);
    const byStatus = Object.fromEntries(body.data.map((r) => [r['orders.status'], Number(r['orders.count'])]));
    expect(byStatus.paid).toBe(3);
    expect(byStatus.pending).toBe(1);
    expect(byStatus.refunded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Atlas SQL endpoint — separate cube container, overlay compose.
//
// Gated on `ATLAS_SQL_URI` + `ATLAS_SQL_DB`. The overlay compose file
// (`examples/docker/docker-compose.atlas-sql.yaml`) starts a SECOND
// cube container on port 4001 pointed at the real Atlas SQL endpoint
// (`*.a.query.mongodb.net`) with `CUBEJS_MONGOSQL_SCHEMA_SOURCE=atlas-sql`.
//
// The test brings the overlay up and tears it down itself (the global
// setup already built the cube docker image we reuse here). Cube model:
// `examples/docker/cube/model-atlas-sql/calllogs.js` over the real
// `calllogs` collection on `dev-convo-hub` — chosen because its schema
// is verified-populated on the Atlas SQL endpoint (see
// `crates/native/src/schema.rs` module docs for the canonical
// `sqlGetSchema` spec).
//
// Without `ATLAS_SQL_URI` the whole block skips — useful for local CI
// runs that don't have network egress to the Atlas cloud.
// ---------------------------------------------------------------------------
const ATLAS_SQL_URI = process.env.ATLAS_SQL_URI;
const ATLAS_SQL_DB = process.env.ATLAS_SQL_DB ?? 'dev-convo-hub';
const ATLAS_SQL_CUBE_URL = 'http://localhost:4001';
const ATLAS_SQL_META_ENDPOINT = `${ATLAS_SQL_CUBE_URL}/cubejs-api/v1/meta`;
const ATLAS_SQL_LOAD_ENDPOINT = `${ATLAS_SQL_CUBE_URL}/cubejs-api/v1/load`;
const ATLAS_SQL_COMPOSE_FILE = 'examples/docker/docker-compose.atlas-sql.yaml';

async function waitForOverlayReadyz(maxSeconds = 180): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ATLAS_SQL_CUBE_URL}/readyz`);
      if (res.ok) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`atlas-sql cube /readyz did not return 200 within ${maxSeconds}s`);
}

async function atlasSqlLoadQuery(body: object, attempt = 1): Promise<CubeLoadResponse> {
  const res = await fetch(ATLAS_SQL_LOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: AUTH_HEADER,
    },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const json = (await res.json()) as CubeLoadResponse | { error: string };
    if ('error' in json && typeof json.error === 'string' && /continue wait/i.test(json.error)) {
      if (attempt > 30) {
        throw new Error(`atlas-sql cube returned "Continue wait" 30 times — aborting`);
      }
      await new Promise((r) => setTimeout(r, 1000));
      return atlasSqlLoadQuery(body, attempt + 1);
    }
    return json as CubeLoadResponse;
  }
  const text = await res.text();
  throw new Error(`atlas-sql cube load failed: HTTP ${res.status} — ${text}`);
}

describe.runIf(!!ATLAS_SQL_URI)('Cube E2E — atlas-sql schema source against real endpoint', () => {
  beforeAll(async () => {
    // Bring up the overlay cube container. Image already built by the
    // outer global setup (the overlay reuses
    // `mongosql-cubejs-driver-e2e:latest`).
    execSync(`docker compose -f ${ATLAS_SQL_COMPOSE_FILE} up -d`, {
      stdio: 'inherit',
      env: { ...process.env, ATLAS_SQL_URI: ATLAS_SQL_URI!, ATLAS_SQL_DB },
    });
    await waitForOverlayReadyz();
  }, 240_000);

  afterAll(() => {
    try {
      execSync(`docker compose -f ${ATLAS_SQL_COMPOSE_FILE} down`, {
        stdio: 'inherit',
        env: { ...process.env, ATLAS_SQL_URI: ATLAS_SQL_URI!, ATLAS_SQL_DB },
      });
    } catch (err) {
      console.error('atlas-sql cube teardown error (ignored):', err);
    }
  });

  it('/meta lists the calllogs cube discovered via atlas-sql schema source', async () => {
    const res = await fetch(ATLAS_SQL_META_ENDPOINT, {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(res.ok, `cube /meta returned ${res.status}`).toBe(true);
    const meta = (await res.json()) as CubeMetaResponse;
    const names = meta.cubes.map((c) => c.name);
    // The cube model (model-atlas-sql/calllogs.js) defines a single
    // `calllogs` cube. Cube can only compile it if `tablesSchema()`
    // produces an entry for `calllogs` — which exclusively happens via
    // the atlas-sql code path on this endpoint (no `__sql_schemas`
    // collection exists).
    expect(names).toContain('calllogs');
  });

  it('count query — calllogs.count runs end-to-end through Cube + atlas-sql', async () => {
    const body = await atlasSqlLoadQuery({
      query: { measures: ['calllogs.count'] },
    });
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.dbType).toBe('mongosql');
    expect(body.data.length).toBe(1);
    const count = Number(body.data[0]?.['calllogs.count']);
    // Endpoint has live data; we don't pin the exact count, only that
    // a real bigint > 0 surfaced through the atlas-sql column-type path.
    expect(Number.isFinite(count)).toBe(true);
    expect(count).toBeGreaterThan(0);
  });
});
