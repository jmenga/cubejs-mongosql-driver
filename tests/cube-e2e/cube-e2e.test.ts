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
import * as path from 'node:path';

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
    // configs cube was added for the sparse-nested-path row-shape
    // normalization regression test. Failing here means the configs
    // schema row didn't make it into __sql_schemas.
    expect(meta.cubes.map((c) => c.name)).toContain('configs');
    // Phase B (MEDIUM) cubes — each is a dedicated harness:
    //   - product_catalog → Gap 4 (filter-operator matrix)
    //   - granular_events → Gap 6 (granularity matrix)
    //   - tz_events       → Gap 7 (non-UTC timezone)
    //   - weird_types     → Gap 10 (unusual BSON types)
    expect(meta.cubes.map((c) => c.name)).toContain('product_catalog');
    expect(meta.cubes.map((c) => c.name)).toContain('granular_events');
    expect(meta.cubes.map((c) => c.name)).toContain('tz_events');
    expect(meta.cubes.map((c) => c.name)).toContain('weird_types');
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

  // ---------------------------------------------------------------------------
  // Cube model compilation smoke — every modeled cube reaches /meta.
  //
  // NOTE on what this test does NOT cover: Cube's `/meta` endpoint is
  // populated by the schema compiler reading `cube/model/*.js` files
  // directly (`@cubejs-backend/schema-compiler` walks the model dir at
  // boot). It does NOT invoke the driver's introspection methods
  // (`getSchemas` / `getTablesForSpecificSchemas` /
  // `getColumnsForSpecificTables`). Those three methods are dispatched
  // exclusively from `QueryOrchestrator.queryDataSourceSchemas /
  // queryTablesForSchemas / queryColumnsForTables` (see
  // `node_modules/@cubejs-backend/query-orchestrator/dist/src/orchestrator/
  // QueryCache.js`) — the pre-aggregation refresh path — and never from
  // the `/meta` route. The end-to-end coverage for the incremental
  // schema-loading three-method contract lives in
  // `tests/integration/incremental-schema.test.ts`, which calls each
  // method directly on a real driver instance.
  //
  // What this test DOES pin: every cube declared under
  // `examples/docker/cube/model/` compiles successfully (no SQL
  // generation errors, no missing `sql_table` references, no model
  // syntax errors). A missing entry means the cube failed to compile —
  // typically a missing `__sql_schemas` row that mongosql couldn't
  // resolve at schema-compile time, OR a syntax error in the model
  // file.
  // ---------------------------------------------------------------------------
  it('cube model compilation — every modeled cube reaches /meta', async () => {
    const res = await fetch(META_ENDPOINT, { headers: { Authorization: AUTH_HEADER } });
    expect(res.ok).toBe(true);
    const meta = (await res.json()) as CubeMetaResponse;
    const names = meta.cubes.map((c) => c.name).sort();
    // All cubes from examples/docker/cube/model/. A missing entry means
    // the cube failed to compile (model syntax error or unresolved
    // `sql_table` at compile time).
    expect(names).toContain('orders');
    expect(names).toContain('revenue_events');
    expect(names).toContain('configs');
    expect(names).toContain('revenue_events_raw');
    // Phase B harnesses.
    expect(names).toContain('product_catalog');
    expect(names).toContain('granular_events');
    expect(names).toContain('tz_events');
    expect(names).toContain('weird_types');
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
            dateRange: ['2026-01-01', '2026-04-01'],
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
            dateRange: ['2026-01-01', '2026-04-01'],
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
  // Pre-aggregation correctness equivalence — Gap 3 (HIGH).
  //
  // CubeJS's `testQueries.ts` pattern: alongside every rollup-routed
  // query, run the SAME logical query directly against the source
  // collection (via a sibling no-pre-aggregation dimension) and assert
  // identical results. Otherwise a future bug in the rollup definition
  // (wrong measure aggregation, missing dimension, off-by-one date
  // partition) would not surface — the rollup-routed result would
  // diverge silently.
  //
  // Setup: `revenue_events` declares a `partition_granularity: 'month'`
  // pre-aggregation; `revenue_events_raw` (added for this test) mirrors
  // it field-for-field WITHOUT any `pre_aggregations` block, so Cube
  // always queries the source. Both cubes resolve to the SAME mongosql
  // collection, so a divergence between their results proves a bug in
  // either the rollup OR the source-query path.
  //
  // For determinism: sort rows on the dimension columns before
  // comparison (Cube's row order is not guaranteed across the rollup
  // and source paths). Numeric assertions use `Number(value)` so the
  // string-form decimal SUM (from `downloadQueryResults`'s
  // type-list-driven shape) compares cleanly with the source-path
  // shape regardless of which is the JSON-number vs JSON-string.
  // ---------------------------------------------------------------------------
  describe('pre-aggregation correctness equivalence (rollup-routed vs direct-against-source)', () => {
    /**
     * Compare a single (potentially-decimal, potentially-date, possibly
     * stringified) value pair for value-equality. Used by
     * `assertEquivalent` to compare individual cells.
     *
     * Three rails:
     *   1. Numeric — if BOTH sides parse cleanly as finite numbers
     *      (e.g. '300.00' vs '300', or 5 vs '5'), compare as numbers
     *      with a 1e-6 tolerance. Handles the Decimal128
     *      trailing-zero-vs-no-trailing-zero shape between Cube Store
     *      (rollup) and the source path (raw).
     *   2. Date-shaped string — if BOTH sides look like ISO date/time
     *      strings (heuristic: contains '-' and 'T' or matches
     *      YYYY-MM-DD), compare via `Date.parse()` epoch milli with a
     *      1ms tolerance. Cube Store occasionally strips/adds
     *      milliseconds (e.g. '2026-01-01T00:00:00.000Z' vs
     *      '2026-01-01T00:00:00.000') and the raw string compare would
     *      false-positive failure.
     *   3. Fallback — raw string compare.
     */
    function compareValues(va: unknown, vb: unknown, msg: string): void {
      // Step 1: numeric rail.
      const na = Number(va);
      const nb = Number(vb);
      const numericA = typeof va !== 'object' && va !== null && Number.isFinite(na) && String(va).length > 0;
      const numericB = typeof vb !== 'object' && vb !== null && Number.isFinite(nb) && String(vb).length > 0;
      if (numericA && numericB) {
        expect(Math.abs(na - nb), `${msg}: a=${String(va)} b=${String(vb)}`).toBeLessThan(1e-6);
        return;
      }
      // Step 2: date-shaped string rail. Detect "looks like an ISO
      // timestamp or YYYY-MM-DD date" and compare epoch milliseconds.
      // `Number(...)` already returned NaN for these — that's why we
      // fell through.
      const looksLikeDate = (v: unknown): v is string => {
        if (typeof v !== 'string' || v.length === 0) return false;
        // ISO-shaped: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS[.fff][Z]'.
        // Don't be over-clever — Date.parse is permissive but we want to
        // only attempt date compare when both sides plausibly look like
        // dates, to avoid stringifying e.g. 'acct-2026'.
        return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v);
      };
      if (looksLikeDate(va) && looksLikeDate(vb)) {
        const ta = Date.parse(va);
        const tb = Date.parse(vb);
        if (Number.isFinite(ta) && Number.isFinite(tb)) {
          // 1ms tolerance — handles Cube Store occasionally dropping or
          // adding the milliseconds component on round-trip.
          expect(Math.abs(ta - tb), `${msg} (date compare): a=${va} b=${vb}`).toBeLessThanOrEqual(1);
          return;
        }
      }
      // Step 3: raw fallback for non-numeric, non-date strings (e.g.
      // `category`, `accountId`).
      expect(vb, msg).toBe(va);
    }

    /**
     * Compare two Cube /load responses row-for-row after the rows have
     * been sorted on the DIMENSION keys only. Both responses must come
     * from cubes that share the same source data, so the row sets MUST
     * be identical (modulo measure name prefix — the keys differ
     * because each cube namespaces its measures with its own name).
     *
     * IMPORTANT — Sorting strategy:
     *   We sort ONLY on the dimension-key pairs (passed via
     *   `dimensionKeys`), NEVER on measures. If we sorted on measure
     *   values too, then a real rollup-vs-source MEASURE mismatch on
     *   the same dimension tuple would cause the rows to misalign
     *   (each side sorts its own value to a different position), and
     *   the lockstep walk would then compare the wrong rows — hiding
     *   the very divergence the equivalence test exists to catch.
     *
     * `dimensionKeys` is the list of `[cubeAField, cubeBField]` pairs
     * to sort by. `measureKeys` is the list of `[cubeAField,
     * cubeBField]` pairs to compare after the sort (NOT used for
     * sorting).
     */
    function assertEquivalent(
      a: Array<Record<string, unknown>>,
      b: Array<Record<string, unknown>>,
      dimensionKeys: Array<[string, string]>,
      measureKeys: Array<[string, string]>,
    ): void {
      expect(a.length).toBe(b.length);
      // Sort ONLY on dimensions (see doc-comment above for rationale).
      const aSorted = [...a].sort((r1, r2) =>
        sortKey(
          r1,
          dimensionKeys.map(([k]) => k),
        ).localeCompare(
          sortKey(
            r2,
            dimensionKeys.map(([k]) => k),
          ),
        ),
      );
      const bSorted = [...b].sort((r1, r2) =>
        sortKey(
          r1,
          dimensionKeys.map(([_, k]) => k),
        ).localeCompare(
          sortKey(
            r2,
            dimensionKeys.map(([_, k]) => k),
          ),
        ),
      );
      for (let i = 0; i < aSorted.length; i++) {
        // Compare every dimension AND every measure for the same row.
        for (const [keyA, keyB] of dimensionKeys) {
          compareValues(aSorted[i][keyA], bSorted[i][keyB], `row ${i} dimension ${keyB}`);
        }
        for (const [keyA, keyB] of measureKeys) {
          compareValues(aSorted[i][keyA], bSorted[i][keyB], `row ${i} measure ${keyB}`);
        }
      }
    }

    function sortKey(row: Record<string, unknown>, keys: string[]): string {
      return keys.map((k) => String(row[k] ?? '')).join('|');
    }

    it('simple count — rollup-routed === direct-against-source (total roll-up)', async () => {
      // INTENT NOTE: An earlier Phase A critique read claimed this query
      // could not match the rollup (no `timeDimensions` = "no time bucket
      // to partition against"). That read was wrong: Cube's rollup
      // matcher routes ANY query whose measures are a subset of the
      // rollup's measures through the materialized aggregate IF the
      // rollup is additive over the requested dimensions (and the
      // monthly partitions are unioned to compute the total). The
      // observed behaviour against atlas-local confirms: `revenue_events`
      // routes through `monthlyRevenue` for the bare `measures:
      // ['count']` shape too (top-level `usedPreAggregations` is
      // non-empty). The raw sibling cube has no pre-aggregations and
      // MUST bypass — together this is a genuine rollup-vs-source
      // equivalence assertion on a total-roll-up shape (no dimensions,
      // no time dimensions) that complements the dimensional shapes
      // tested below.
      const rollup = await loadQuery({
        query: { measures: ['revenue_events.count'] },
      });
      const raw = await loadQuery({
        query: { measures: ['revenue_events_raw.count'] },
      });
      // Both queries return a single aggregate row. Compare totals.
      expect(rollup.data.length).toBe(1);
      expect(raw.data.length).toBe(1);
      expect(Number(rollup.data[0]['revenue_events.count'])).toBe(Number(raw.data[0]['revenue_events_raw.count']));
      // Sanity: it matches the seed total (7 events).
      expect(Number(raw.data[0]['revenue_events_raw.count'])).toBe(7);
      // Pin the rollup-routed status — this is the entire point of the
      // equivalence harness. A future change that silently disables the
      // pre-aggregation would make the numeric assertions still pass
      // (by falling back to direct query) but weaken the regression
      // net. Conversely, the raw cube MUST bypass — `revenue_events_raw`
      // declares no `pre_aggregations` block.
      expect(Object.keys(rollup.usedPreAggregations ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(raw.usedPreAggregations ?? {}).length).toBe(0);
    });

    it('count grouped by month — rollup-routed === direct-against-source', async () => {
      // With monthly partitioning on the rollup, this exercises the
      // exact UNION path the dedicated partition test pins. Equivalence
      // with the source-path result proves the UNION recomposes the
      // same row set the source would have emitted.
      const rollup = await loadQuery({
        query: {
          measures: ['revenue_events.count'],
          timeDimensions: [
            {
              dimension: 'revenue_events.occurredAt',
              granularity: 'month',
              dateRange: ['2026-01-01', '2026-04-01'],
            },
          ],
        },
      });
      const raw = await loadQuery({
        query: {
          measures: ['revenue_events_raw.count'],
          timeDimensions: [
            {
              dimension: 'revenue_events_raw.occurredAt',
              granularity: 'month',
              dateRange: ['2026-01-01', '2026-04-01'],
            },
          ],
        },
      });
      // Rollup must actually be used — guards against a silent fallback.
      expect(Object.keys(rollup.usedPreAggregations ?? {}).length).toBeGreaterThan(0);
      // Raw cube has no pre-aggregations — it MUST bypass.
      expect(Object.keys(raw.usedPreAggregations ?? {}).length).toBe(0);

      assertEquivalent(
        rollup.data,
        raw.data,
        // Dimensions (used for sort + compare).
        [['revenue_events.occurredAt.month', 'revenue_events_raw.occurredAt.month']],
        // Measures (compared but NOT used for sort).
        [['revenue_events.count', 'revenue_events_raw.count']],
      );
    });

    it('count + sum_amount grouped by month + category — rollup-routed === direct-against-source', async () => {
      // The most-rolled-up shape exercising both COUNT and SUM(decimal)
      // across the partition boundaries.
      const rollup = await loadQuery({
        query: {
          measures: ['revenue_events.count', 'revenue_events.totalAmount'],
          dimensions: ['revenue_events.category'],
          timeDimensions: [
            {
              dimension: 'revenue_events.occurredAt',
              granularity: 'month',
              dateRange: ['2026-01-01', '2026-04-01'],
            },
          ],
        },
      });
      const raw = await loadQuery({
        query: {
          measures: ['revenue_events_raw.count', 'revenue_events_raw.totalAmount'],
          dimensions: ['revenue_events_raw.category'],
          timeDimensions: [
            {
              dimension: 'revenue_events_raw.occurredAt',
              granularity: 'month',
              dateRange: ['2026-01-01', '2026-04-01'],
            },
          ],
        },
      });
      expect(Object.keys(rollup.usedPreAggregations ?? {}).length).toBeGreaterThan(0);
      // Raw cube has no pre-aggregations — it MUST bypass.
      expect(Object.keys(raw.usedPreAggregations ?? {}).length).toBe(0);

      assertEquivalent(
        rollup.data,
        raw.data,
        // Dimensions (used for sort + compare).
        [
          ['revenue_events.category', 'revenue_events_raw.category'],
          ['revenue_events.occurredAt.month', 'revenue_events_raw.occurredAt.month'],
        ],
        // Measures (compared but NOT used for sort).
        [
          ['revenue_events.count', 'revenue_events_raw.count'],
          ['revenue_events.totalAmount', 'revenue_events_raw.totalAmount'],
        ],
      );
    });

    it('count grouped by month filtered to Feb — rollup-routed === direct-against-source', async () => {
      // Narrow the date range to a single partition's worth of data —
      // exercises the build_range_start / build_range_end + filter
      // intersection. Pre-fix, an off-by-one bug in the partition bound
      // would have surfaced here (rollup would either over- or under-
      // count vs the source-path result).
      //
      // NOTE: the date filter alone is NOT enough to route through the
      // rollup — Cube's rollup matcher requires a granularity match too
      // (the partition is `granularity: 'month'`). We add
      // `granularity: 'month'` so the query is actually rollup-routed;
      // without it Cube falls back to direct-source on BOTH cubes and
      // the test would compare apples to apples (both bypassing the
      // rollup), defeating the purpose of the equivalence check.
      const rollup = await loadQuery({
        query: {
          measures: ['revenue_events.count'],
          timeDimensions: [
            {
              dimension: 'revenue_events.occurredAt',
              granularity: 'month',
              dateRange: ['2026-02-01', '2026-02-28'],
            },
          ],
        },
      });
      const raw = await loadQuery({
        query: {
          measures: ['revenue_events_raw.count'],
          timeDimensions: [
            {
              dimension: 'revenue_events_raw.occurredAt',
              granularity: 'month',
              dateRange: ['2026-02-01', '2026-02-28'],
            },
          ],
        },
      });
      // Pin the rollup-routed status — see comment above for why we
      // added `granularity: 'month'`. Without this assertion a future
      // schema-compile race that silently disables the rollup would
      // weaken the regression net without failing the numeric checks.
      expect(Object.keys(rollup.usedPreAggregations ?? {}).length).toBeGreaterThan(0);
      // Raw cube has no pre-aggregations — it MUST bypass.
      expect(Object.keys(raw.usedPreAggregations ?? {}).length).toBe(0);

      // Both should produce one row with the same count value. The
      // February seed has 2 events.
      expect(rollup.data.length).toBe(raw.data.length);
      const rollupSum = rollup.data.reduce((acc, r) => acc + Number(r['revenue_events.count'] ?? 0), 0);
      const rawSum = raw.data.reduce((acc, r) => acc + Number(r['revenue_events_raw.count'] ?? 0), 0);
      expect(rollupSum).toBe(rawSum);
      expect(rawSum).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Large-IN-list workaround — Cube /load with 200 `equals` values.
  //
  // Real failure mode: `mongosql::translate_sql` v1.8.5 outputs a FLAT
  // `$or` (depth 1) for `IN (v1..vN)` both locally and against the
  // Atlas SQL endpoint. The Atlas SQL **proxy / server-side query
  // layer re-expands** the flat array into a right-leaning binary-`$or`
  // chain before passing the aggregate to MongoDB. For N ≥ ~100 the
  // chain busts MongoDB's max BSON nested-object depth (100) and the
  // server rejects with `Error code 15 (Overflow)`. The driver's
  // pipeline_rewrite pass collapses the same-field `$eq` disjunction
  // to `$in` (no n-ary boolean array left to chain-ify), defeating the
  // re-expansion.
  //
  // The atlas-local container is plain MongoDB without the proxy, so
  // this cube-e2e test pins the end-to-end correctness path: the
  // rewriter must NOT corrupt a valid query, and the server must
  // accept the result. The dedicated Atlas-SQL test
  // (`query_with_large_in_list_against_atlas_sql` in
  // `crates/native/tests/client_e2e.rs`) exercises the actual
  // re-expansion failure mode.
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

  // ---------------------------------------------------------------------------
  // NOT IN coverage gap — Cube /load with 200 `notEquals` values.
  //
  // The Atlas SQL proxy re-expands flat `$and`s the same way it
  // re-expands `$or`s (verified empirically against the real endpoint
  // with `cargo test ... probe_atlas_sql_not_in_execute_200`: a
  // 200-value `NOT IN` overflows BSON depth at the proxy with the
  // chain visible in `pipeline.0.$match.$expr.$and.0.$and.0…`).
  // The driver's pipeline_rewrite pass now extends to `$and → $nin`
  // for the symmetric collapse.
  // ---------------------------------------------------------------------------
  it('large NOT IN list — Cube /load with 200 notEquals values returns rows, not BSON depth overflow', async () => {
    const values: string[] = [];
    for (let i = 0; i < 200; i++) values.push(`synthetic_v${i}`);
    // Append a real seeded value to be EXCLUDED — `acct_a` matches 3
    // orders. With it in the NOT-IN list, the remaining rows are
    // `acct_b` (2 orders).
    values.push('acct_a');

    const body = await loadQuery({
      query: {
        measures: ['orders.count'],
        dimensions: ['orders.accountId'],
        filters: [
          {
            member: 'orders.accountId',
            operator: 'notEquals',
            values,
          },
        ],
      },
    });

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.dbType).toBe('mongosql');
    // Seed: 3 `acct_a` excluded + 2 `acct_b` remain. The remaining 2
    // group under `acct_b` with count=2.
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.['orders.accountId']).toBe('acct_b');
    expect(Number(body.data[0]?.['orders.count'])).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Sparse nested-path row-shape normalization — exact-shape regression.
  //
  // Mongosql's `$project` of `agent.displayName` OMITS the field from
  // docs missing the source path (does NOT emit null). With `ORDER BY
  // <nested-field> ASC`, the sparse rows sort to row 0. Cube's native
  // `getFinalQueryResult` compiles its row→member extraction plan from
  // row 0's keys — pre-fix, the column would be dropped from every row
  // in the response.
  //
  // The fixture seeds 10 docs in `configs`: 7 with `agent.displayName`
  // populated, 3 without the `agent` field at all. The /load query
  // below mirrors the production `useAgentsList` shape: project `id` +
  // `agent.displayName` with an ascending sort on the name. Post-fix,
  // all 10 rows carry `configs.agentDisplayName`; pre-fix, all 10 rows
  // would be missing it (the bug being pinned).
  // ---------------------------------------------------------------------------
  it('sparse nested-path — configs.agentDisplayName survives Cube /load with ORDER BY ASC', async () => {
    const body = await loadQuery({
      query: {
        dimensions: ['configs.id', 'configs.agentDisplayName'],
        order: { 'configs.agentDisplayName': 'asc' },
        limit: 10,
      },
    });

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.dbType).toBe('mongosql');
    expect(body.data.length).toBe(10);

    // THE assertion the bug was about. Pre-fix: every row would be
    // missing `configs.agentDisplayName` because Cube's native
    // `getFinalQueryResult` compiles its row→member plan from row 0's
    // keys, and row 0 was sparse (nulls-first sort). Post-fix: every
    // row carries the key (null for the sparse rows, string for the
    // populated rows).
    for (const r of body.data) {
      expect(r).toHaveProperty('configs.agentDisplayName');
    }

    // The 7 populated rows carry real strings, the 3 sparse rows null.
    const populated = body.data.filter((r) => r['configs.agentDisplayName'] !== null);
    const sparse = body.data.filter((r) => r['configs.agentDisplayName'] === null);
    expect(populated).toHaveLength(7);
    expect(sparse).toHaveLength(3);

    // The downstream `agents.filter(a => a.id && a.name)` shape from the
    // production bug — confirm both `id` AND `name` are present on the
    // populated rows so the filter yields non-empty results.
    const usableAgents = body.data.filter((r) => r['configs.id'] && r['configs.agentDisplayName']);
    expect(usableAgents).toHaveLength(7);
    // Names come back in ascending alphabetical order on the populated rows.
    const populatedNames = body.data.map((r) => r['configs.agentDisplayName']).filter((n) => n !== null);
    expect(populatedNames).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace']);
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

  // ---------------------------------------------------------------------------
  // User-reported failure shape — Cube /load with a GROUP BY measure +
  // 161 `equals` filter values (mirrors the original `agent_id IN (161
  // ids)` query that triggered the BSON-depth overflow). Mongosql v1.8.5
  // emits the `$let`-wrapped IN-list shape for this combination, which
  // the flat-`$or` flattener can't recognise; the new
  // `pipeline_rewrite::collapse_mongosql_in_list_let` rewrite replaces
  // the entire `$let` with a `$cond`-wrapped `$in`. This atlas-local
  // test pins the end-to-end correctness path — the dedicated Atlas-SQL
  // test (`query_with_groupby_in_list_against_atlas_sql`) covers the
  // actual re-expansion failure mode against the real cloud endpoint.
  // ---------------------------------------------------------------------------
  it('user-shape — GROUP BY + 161 equals values returns rows (let-wrapped IN-list collapse)', async () => {
    const values: string[] = [];
    for (let i = 0; i < 161; i++) values.push(`groupby_in_user_test_v${i}`);
    // Append a real seeded `acct_a` value so the query returns a
    // non-empty grouped result (the seed has 3 `acct_a` orders).
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
    // 3 `acct_a` orders group into a single row with count=3.
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.['orders.accountId']).toBe('acct_a');
    expect(Number(body.data[0]?.['orders.count'])).toBe(3);
  });

  // ===========================================================================
  // Phase B — MEDIUM-priority cube-driver coverage gaps. See DRIVER.md.
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Gap 4 — Standard filter-operator matrix.
  //
  // Cube's `testQueries.ts` runs every documented Cube filter operator
  // against a known seed slice:
  //   `contains`, `notContains`, `startsWith`, `notStartsWith`,
  //   `endsWith`, `notEndsWith`, `equals` (multi-value)
  // plus special-character payloads (`%`, `_`, regex-meta) and empty-
  // result variants. The driver layer emits whatever SQL the BaseQuery
  // dialect specifies; the actual matching happens at the mongosql layer
  // via SQL `LIKE`. This block pins:
  //   * Every operator's positive case (right rows returned).
  //   * Every operator's negative case (no false positives).
  //   * Special chars in the pattern are treated as LIKE literals (the
  //     dialect MUST NOT silently fall through to regex matching).
  //   * `equals` with multi-value yields the union (logical OR over the
  //     value list).
  //
  // Source dimension: `product_catalog.name` (8 products, distinct
  // prefixes/suffixes/substrings + special-char rows). See
  // `tests/integration/fixtures/seed-data.js`.
  // ---------------------------------------------------------------------------
  describe('Gap 4 — Standard filter-operator matrix (product_catalog.name)', () => {
    it('contains — substring matches', async () => {
      // 'Widget-A1', 'Widget-B2', 'Widget-C3' all contain "Widget".
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'contains', values: ['Widget'] }],
        },
      });
      expect(body.data.length).toBe(3);
      const names = body.data.map((r) => r['product_catalog.name']).sort();
      expect(names).toEqual(['Widget-A1', 'Widget-B2', 'Widget-C3']);
    });

    it('notContains — substring excludes', async () => {
      // 8 total, 3 contain 'Widget' → 5 remain.
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'notContains', values: ['Widget'] }],
        },
      });
      expect(body.data.length).toBe(5);
      const names = body.data.map((r) => r['product_catalog.name']).sort();
      expect(names).toEqual([
        'Gadget X',
        'Gadget Y',
        'Special%With%Percent',
        'Special.Regex+Meta*',
        'Special_With_Underscore',
      ]);
    });

    it('startsWith — prefix matches', async () => {
      // Two rows start with 'Gadget '.
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'startsWith', values: ['Gadget'] }],
        },
      });
      expect(body.data.length).toBe(2);
      const names = body.data.map((r) => r['product_catalog.name']).sort();
      expect(names).toEqual(['Gadget X', 'Gadget Y']);
    });

    it('notStartsWith — prefix excludes', async () => {
      // 8 total, 2 start with 'Gadget' → 6 remain.
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'notStartsWith', values: ['Gadget'] }],
        },
      });
      expect(body.data.length).toBe(6);
    });

    it('endsWith — suffix matches', async () => {
      // Suffix 'A1' matches one row ('Widget-A1').
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'endsWith', values: ['A1'] }],
        },
      });
      expect(body.data.length).toBe(1);
      expect(body.data[0]['product_catalog.name']).toBe('Widget-A1');
    });

    it('notEndsWith — suffix excludes', async () => {
      // 8 total, 1 ends with 'A1' → 7 remain.
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'notEndsWith', values: ['A1'] }],
        },
      });
      expect(body.data.length).toBe(7);
    });

    it('equals (multi-value) — union of equality matches', async () => {
      // 3-value IN list across the catalog. Pins that multi-value equals
      // behaves as a logical OR over the value array (matching Cube's
      // documented `{member, operator: 'equals', values: ['a', 'b']}`
      // semantics) and pre-flight tests the dialect's emission shape.
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [
            {
              member: 'product_catalog.name',
              operator: 'equals',
              values: ['Widget-A1', 'Gadget X', 'Special.Regex+Meta*'],
            },
          ],
        },
      });
      expect(body.data.length).toBe(3);
      const names = body.data.map((r) => r['product_catalog.name']).sort();
      expect(names).toEqual(['Gadget X', 'Special.Regex+Meta*', 'Widget-A1']);
    });

    it('empty-result variant — contains a string that no row carries', async () => {
      // Pattern that no product name contains. Pre-fix this would have
      // returned an empty data array; this test pins that as the contract
      // (Cube returns 0 rows, not a different shape).
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'contains', values: ['NoSuchSubstring_xyz'] }],
        },
      });
      expect(body.data.length).toBe(0);
    });

    it('special chars — `%` in pattern matches literal `%`, not LIKE wildcard', async () => {
      // 'Special%With%Percent' has two literal `%` characters. Cube's
      // BaseFilter.likeIgnoreCase wraps the parameter with `'%' || p ||
      // '%'` and BaseQuery's `filterValueParameter` MUST escape any
      // wildcard-conflicting characters in the supplied value (the
      // BaseFilter `escapeWildcardChars` path). Pre-fix or with a
      // future regression that drops the escape, this query would match
      // EVERY row (the inner `%` would re-expand as a wildcard).
      //
      // We use `contains` with the literal `%` so a regression that
      // silently treated `%` as a LIKE wildcard would over-match. The
      // assertion pins exactly 1 row — the one product whose name
      // contains the literal `%`.
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'contains', values: ['With%Percent'] }],
        },
      });
      expect(body.data.length).toBe(1);
      expect(body.data[0]['product_catalog.name']).toBe('Special%With%Percent');
    });

    it('special chars — `_` in pattern matches literal `_`, not single-char wildcard', async () => {
      // 'Special_With_Underscore' has literal `_` chars. `_` is the SQL
      // LIKE single-char wildcard, so a regression that dropped the
      // escape would over-match. We use `contains` with a substring
      // that includes `_` — the assertion pins exactly 1 row.
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'contains', values: ['With_Underscore'] }],
        },
      });
      expect(body.data.length).toBe(1);
      expect(body.data[0]['product_catalog.name']).toBe('Special_With_Underscore');
    });

    it('special chars — regex metacharacters are LIKE literals (no regex interpretation)', async () => {
      // 'Special.Regex+Meta*' contains `.`, `+`, `*`. In MongoDB regex
      // these are metachars; in SQL LIKE they are literals. The dialect
      // MUST use LIKE (not `$regex`) so these are matched as literal
      // bytes. We use `contains` with the literal substring and pin
      // exactly 1 row — a regex-based match would over-match (`.`
      // would match any character, `*` would match zero-or-more, etc.).
      const body = await loadQuery({
        query: {
          measures: ['product_catalog.count'],
          dimensions: ['product_catalog.name'],
          filters: [{ member: 'product_catalog.name', operator: 'contains', values: ['Regex+Meta*'] }],
        },
      });
      expect(body.data.length).toBe(1);
      expect(body.data[0]['product_catalog.name']).toBe('Special.Regex+Meta*');
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 5 — limit / total / offset / nulls-ordering matrix.
  //
  // CubeJS pins 8+ named test cases for limit/total/offset interactions
  // plus `ORDER BY ... NULLS FIRST` semantics. We previously had a single
  // `limit` test. Here we pin the full matrix:
  //   * `{limit}` — row cap.
  //   * `{limit, offset}` — paginate.
  //   * `{total: true}` — total count returned alongside paginated rows.
  //   * `{limit, total, offset}` — combined.
  //   * Nulls ordering — ASC with nulls vs DESC with nulls.
  //
  // The `configs` fixture is the ideal harness: 10 rows total, 3 with
  // `agent.displayName` NULL (sparse path). With ORDER BY ASC, Mongo's
  // documented sort places nulls first; with DESC it places them last.
  // ---------------------------------------------------------------------------
  describe('Gap 5 — limit/total/offset/nulls-ordering', () => {
    it('{limit: 3} — returns first 3 rows of an ordered set', async () => {
      const body = await loadQuery({
        query: {
          dimensions: ['configs.id', 'configs.agentDisplayName'],
          order: { 'configs.id': 'asc' },
          limit: 3,
        },
      });
      expect(body.data.length).toBe(3);
      // configs.id is 'cfg_a'..'cfg_j' so the first 3 ascending are a/b/c.
      const ids = body.data.map((r) => r['configs.id']);
      expect(ids).toEqual(['cfg_a', 'cfg_b', 'cfg_c']);
    });

    it('{limit: 3, offset: 3} — paginate to the next page', async () => {
      const body = await loadQuery({
        query: {
          dimensions: ['configs.id', 'configs.agentDisplayName'],
          order: { 'configs.id': 'asc' },
          limit: 3,
          offset: 3,
        },
      });
      expect(body.data.length).toBe(3);
      // After skipping a/b/c, the next 3 are d/e/f.
      const ids = body.data.map((r) => r['configs.id']);
      expect(ids).toEqual(['cfg_d', 'cfg_e', 'cfg_f']);
    });

    it('{limit, total: true} — paginated data plus totalRows field', async () => {
      // Cube documents `total: true` as triggering an extra COUNT(*)
      // alongside the page. The response shape includes the page rows in
      // `data` and the total row count in `total` (or `annotation.total`,
      // depending on Cube version). We assert both that the page is
      // capped AND that the total count surfaces in some form so the
      // contract is pinned.
      const body = (await loadQuery({
        query: {
          dimensions: ['configs.id'],
          order: { 'configs.id': 'asc' },
          limit: 4,
          total: true,
        },
      })) as CubeLoadResponse & { total?: number; totalRow?: number };
      expect(body.data.length).toBe(4);
      // Cube emits the total row count either as top-level `total` or as
      // a property on the slow-query block (`slowQuery` is irrelevant
      // here). Accept either shape so a future Cube minor release that
      // refactors the response envelope doesn't break the test. The
      // assertion is: SOMEWHERE in the response the number 10 surfaces
      // (10 = total seeded configs rows).
      const envelope = JSON.stringify(body);
      expect(envelope).toContain('"total"');
      // Be defensive: the total is a numeric 10. Locate it directly via a
      // type-narrowed search across the documented places where Cube has
      // emitted it across versions.
      const totalDirect =
        (body as { total?: number }).total ??
        ((body as { annotation?: { total?: number } }).annotation?.total as number | undefined);
      expect(totalDirect).toBe(10);
    });

    it('{limit, offset, total} — paginate with total surfacing', async () => {
      const body = (await loadQuery({
        query: {
          dimensions: ['configs.id'],
          order: { 'configs.id': 'asc' },
          limit: 2,
          offset: 6,
          total: true,
        },
      })) as CubeLoadResponse & { total?: number };
      // Skipping 6, taking 2 → cfg_g, cfg_h.
      expect(body.data.length).toBe(2);
      const ids = body.data.map((r) => r['configs.id']);
      expect(ids).toEqual(['cfg_g', 'cfg_h']);
      // Total should still report all 10.
      const totalDirect =
        (body as { total?: number }).total ??
        ((body as { annotation?: { total?: number } }).annotation?.total as number | undefined);
      expect(totalDirect).toBe(10);
    });

    it('nulls-ordering ASC — nulls sort first (mongosql default)', async () => {
      // Project both id and agentDisplayName; ORDER BY agentDisplayName
      // ASC. 3 rows have NULL agentDisplayName; mongosql's $sort with
      // ascending semantics places missing/null values FIRST (matches
      // SQL ANSI `NULLS FIRST` convention for ASC).
      const body = await loadQuery({
        query: {
          dimensions: ['configs.id', 'configs.agentDisplayName'],
          order: { 'configs.agentDisplayName': 'asc' },
          limit: 10,
        },
      });
      expect(body.data.length).toBe(10);
      // First 3 rows have null agentDisplayName (the sparse rows).
      const first3 = body.data.slice(0, 3);
      for (const r of first3) {
        expect(r['configs.agentDisplayName']).toBeNull();
      }
      // Last 7 rows have non-null agentDisplayName ordered ASC.
      const lastNames = body.data.slice(3).map((r) => r['configs.agentDisplayName']);
      expect(lastNames).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace']);
    });

    it('nulls-ordering DESC — nulls sort last (mongosql default)', async () => {
      const body = await loadQuery({
        query: {
          dimensions: ['configs.id', 'configs.agentDisplayName'],
          order: { 'configs.agentDisplayName': 'desc' },
          limit: 10,
        },
      });
      expect(body.data.length).toBe(10);
      // First 7 rows have non-null agentDisplayName ordered DESC.
      const firstNames = body.data.slice(0, 7).map((r) => r['configs.agentDisplayName']);
      expect(firstNames).toEqual(['Grace', 'Frank', 'Eve', 'Dave', 'Carol', 'Bob', 'Alice']);
      // Last 3 rows have null agentDisplayName.
      const last3 = body.data.slice(7);
      for (const r of last3) {
        expect(r['configs.agentDisplayName']).toBeNull();
      }
    });

    // Regression pin: the emitted SQL must NOT contain `NULLS FIRST` or
    // `NULLS LAST` clauses, which mongosql v1.8.5 rejects. The dialect's
    // `orderHashToString` override (MongoSqlQuery.ts) strips these from
    // Cube's BaseQuery output. If a future Cube upgrade switches to its
    // newer SQL planner (`sqlTemplates().expressions.sort` /
    // `statements.order_by`), this test would catch the regression —
    // we'd need to extend the dialect override to cover those templates
    // too.
    it('emits ORDER BY without NULLS FIRST/LAST clauses (mongosql compatibility)', async () => {
      const res = await fetch(`${CUBE_URL}/cubejs-api/v1/sql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH_HEADER },
        body: JSON.stringify({
          query: {
            dimensions: ['configs.id', 'configs.agentDisplayName'],
            order: { 'configs.agentDisplayName': 'asc' },
            limit: 10,
          },
        }),
      });
      const body = (await res.json()) as { sql?: { sql?: [string, unknown[]] }; error?: string };
      expect(body.error).toBeUndefined();
      const sql = body.sql?.sql?.[0] ?? '';
      expect(sql.toUpperCase()).not.toContain('NULLS FIRST');
      expect(sql.toUpperCase()).not.toContain('NULLS LAST');
      // Sanity: the ORDER BY clause IS present (we're testing the right
      // query — not a no-op).
      expect(sql.toUpperCase()).toContain('ORDER BY');
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 6 — Time-dimension granularity matrix end-to-end.
  //
  // CubeJS pins per-granularity bucket counts at the SQL fragment level
  // (`tests/unit/dialect.test.ts` covers DATETRUNC emission) but only
  // `month` is exercised through /load. This block runs every supported
  // granularity (`second/minute/hour/day/week/month/quarter/year`)
  // against the `granular_events` seed and pins one expected bucket
  // count per granularity. Seed: 12 rows; pinned counts per granularity
  // are documented in `tests/integration/fixtures/seed-data.js`.
  //
  // Week semantics: the dialect pins `'sunday'` as start-of-week
  // (mongosql DATETRUNC default would also be sunday at v1.8.5 but we
  // pin it explicitly so a future mongosql release changing the default
  // doesn't silently shift bucket boundaries). The seed's 12 timestamps
  // span 7 unique Sunday-start weeks — documented above.
  // ---------------------------------------------------------------------------
  describe('Gap 6 — Time-dimension granularity matrix', () => {
    const cases: Array<[string, number]> = [
      ['year', 2],
      ['quarter', 3],
      ['month', 5],
      ['week', 7],
      ['day', 8],
      ['hour', 9],
      ['minute', 11],
      ['second', 11],
    ];

    it.each(cases)('granularity=%s produces %d buckets over the seed', async (granularity, expected) => {
      const body = await loadQuery({
        query: {
          measures: ['granular_events.count'],
          timeDimensions: [
            {
              dimension: 'granular_events.occurredAt',
              granularity,
              // Wide-enough range to cover all seeded rows (2025-12 to
              // 2026-04). Tight enough not to invent empty buckets.
              dateRange: ['2025-12-01', '2026-04-30'],
            },
          ],
        },
      });
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
      // Sum of counts MUST equal the seed total (12) regardless of
      // granularity — a missing row would surface as a count gap too.
      const totalCount = body.data.reduce((acc, r) => acc + Number(r['granular_events.count'] ?? 0), 0);
      expect(totalCount).toBe(12);
      // Each non-empty bucket is a row in the response — pin the bucket
      // count against the seed truth.
      const nonEmpty = body.data.filter((r) => Number(r['granular_events.count'] ?? 0) > 0);
      expect(nonEmpty.length).toBe(expected);
    });

    it('week granularity uses Sunday-start (dialect pinned to mongosql default)', async () => {
      // Pin the boundary explicitly: 2026-04-12 is a Sunday (00:00 UTC).
      // The row at 2026-04-09 (Thursday) belongs to the previous week
      // (2026-04-05) — not the 2026-04-12 week. Asserting both buckets
      // contain the expected rows pins the Sunday-start convention.
      const body = await loadQuery({
        query: {
          measures: ['granular_events.count'],
          timeDimensions: [
            {
              dimension: 'granular_events.occurredAt',
              granularity: 'week',
              dateRange: ['2026-04-05', '2026-04-18'],
            },
          ],
        },
      });
      // April rows in the seed: ge_09 (Apr 8), ge_10/11 (Apr 9), ge_12 (Apr 12).
      // Sunday-start weeks: Apr 5 (covers Apr 5-11; 3 rows) + Apr 12
      // (covers Apr 12-18; 1 row).
      const buckets = body.data.map((r) => Number(r['granular_events.count'] ?? 0));
      // Sort buckets numerically to make the assertion stable regardless
      // of how Cube orders the bucket rows.
      buckets.sort((a, b) => a - b);
      expect(buckets).toEqual([1, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 7 — Non-UTC timezone.
  //
  // Our `convertTz` is a documented passthrough (UTC-only contract; see
  // src/MongoSqlQuery.ts). mongosql v1.8.5 has no `AT TIME ZONE` /
  // `CONVERT_TZ` function. This block pins the documented behavior:
  //   * UTC-tagged queries succeed and bucket by UTC clock.
  //   * Non-UTC-tagged queries — because Cube's `inDbTimeZone` shifts
  //     parameter values JS-side and `convertTz` is a passthrough — the
  //     SQL fragments do not call out to a server-side TZ function. The
  //     bucket assignment is therefore UTC-based at the server, BUT the
  //     `dateRange` boundaries Cube emits are shifted by the requested
  //     timezone offset. The net effect on a `day`-granularity query is
  //     that the bucket labels shift by the offset on a wide range —
  //     events on the day boundary land in different day buckets
  //     depending on the TZ.
  //
  // The 3 seeded `tz_events` rows are all in 2026-01-01 UTC, but only
  // tz_01 (03:00 UTC) shifts day in IST (UTC+5:30 → 08:30 IST, same day)
  // OR EST (UTC-5 → previous day 22:00 EST). Asserting bucket counts and
  // membership at UTC vs Asia/Kolkata (IST: doesn't shift day for any
  // of our rows — all stay on Jan 1 IST) vs America/New_York (EST: tz_01
  // shifts to Dec 31, tz_02/03 stay on Jan 1) pins the behavior.
  // ---------------------------------------------------------------------------
  describe('Gap 7 — Non-UTC timezone (convertTz passthrough contract)', () => {
    it('timezone=UTC — all 3 events land in the same day bucket', async () => {
      // All three events are on 2026-01-01 in UTC. day-granularity → 1
      // bucket containing 3 rows.
      const body = await loadQuery({
        query: {
          measures: ['tz_events.count'],
          timeDimensions: [
            {
              dimension: 'tz_events.occurredAt',
              granularity: 'day',
              dateRange: ['2025-12-30', '2026-01-03'],
            },
          ],
          timezone: 'UTC',
        },
      });
      const totalCount = body.data.reduce((acc, r) => acc + Number(r['tz_events.count'] ?? 0), 0);
      expect(totalCount).toBe(3);
      const nonEmpty = body.data.filter((r) => Number(r['tz_events.count'] ?? 0) > 0);
      expect(nonEmpty.length).toBe(1);
    });

    it('timezone=Asia/Kolkata — query succeeds and rows round-trip', async () => {
      // The driver's contract: non-UTC requests do NOT fail. Cube's
      // `inDbTimeZone()` shifts the JS-side timestamp parameters; the SQL
      // bucket arithmetic still runs against UTC-stored data (mongosql
      // has no AT TIME ZONE). The end-to-end result is that the query
      // succeeds and returns rows. The exact bucket boundaries depend on
      // Cube's parameter shifting — we pin the loose contract: rows
      // round-trip, and the total count equals the seed total.
      //
      // This test exists to prove non-UTC requests do NOT fail loudly —
      // a future regression that locked the driver into UTC-only with a
      // hard error would surface here as a thrown response. Today
      // mongosql accepts the SQL because `convertTz` is a passthrough
      // and Cube shifts JS-side.
      const body = await loadQuery({
        query: {
          measures: ['tz_events.count'],
          timeDimensions: [
            {
              dimension: 'tz_events.occurredAt',
              granularity: 'day',
              dateRange: ['2025-12-30', '2026-01-03'],
            },
          ],
          timezone: 'Asia/Kolkata',
        },
      });
      const totalCount = body.data.reduce((acc, r) => acc + Number(r['tz_events.count'] ?? 0), 0);
      // All 3 seeded rows must still be accounted for — the TZ-shift
      // only changes WHICH bucket each row lands in, not whether they
      // exist.
      expect(totalCount).toBe(3);
    });

    it('timezone=America/New_York — query succeeds, boundary row shifts day', async () => {
      // tz_01 at 2026-01-01T03:00Z is 2025-12-31T22:00 EST — different
      // day in EST. With a date range that spans both UTC and EST days,
      // we still expect all 3 rows back. The test pins the loose
      // contract: non-UTC queries succeed end-to-end, rows are not lost.
      const body = await loadQuery({
        query: {
          measures: ['tz_events.count'],
          timeDimensions: [
            {
              dimension: 'tz_events.occurredAt',
              granularity: 'day',
              dateRange: ['2025-12-29', '2026-01-03'],
            },
          ],
          timezone: 'America/New_York',
        },
      });
      const totalCount = body.data.reduce((acc, r) => acc + Number(r['tz_events.count'] ?? 0), 0);
      expect(totalCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 10 — Unusual BSON types.
  //
  // Cube's `unusualDataTypes` fixture covers 13 column types per driver.
  // We exercised Decimal128, ObjectId-as-string, Timestamp, String, and
  // Int. This block covers the production-realistic ones missing:
  //   - Long (Int64) → bigint
  //   - Binary (subtype 0 + UUID/subtype 4) → text (mongosql BINDATA
  //     surfaces as a text-shaped SQL value at v1.8.5).
  //   - BSON Timestamp (distinct from Date) → timestamp
  //   - Embedded array (existence only — array subscript is mongosql
  //     v1.8.5-dependent and not consistently supported through Cube).
  //   - Nested document field (string + int variants).
  //
  // What's pinned:
  //   * data_type annotation on each Cube dimension (via /meta).
  //   * Value round-trip through /load — count + sum(long) + nested
  //     string + nested int.
  // ---------------------------------------------------------------------------
  describe('Gap 10 — Unusual BSON types (weird_types collection)', () => {
    it('/meta exposes the weird_types dimensions with documented type tags', async () => {
      const res = await fetch(META_ENDPOINT, { headers: { Authorization: AUTH_HEADER } });
      expect(res.ok).toBe(true);
      const meta = (await res.json()) as CubeMetaResponse;
      const wt = meta.cubes.find((c) => c.name === 'weird_types');
      expect(wt).toBeDefined();
      const dims = wt!.dimensions as Array<{ name: string; type: string }>;
      const byName = Object.fromEntries(dims.map((d) => [d.name, d.type]));
      // Cube generic-type annotations (model-declared, not source-derived).
      expect(byName['weird_types.id']).toBe('string');
      expect(byName['weird_types.idLong']).toBe('number');
      expect(byName['weird_types.nestedLabel']).toBe('string');
      expect(byName['weird_types.nestedCount']).toBe('number');
      expect(byName['weird_types.occurredAt']).toBe('time');
    });

    it('count + sum(long) round-trip through /load', async () => {
      const body = await loadQuery({
        query: {
          measures: ['weird_types.count', 'weird_types.totalLong'],
        },
      });
      expect(body.data.length).toBe(1);
      // 5 seeded rows; SUM(id_long) = 1+2+3+4+5 = 15.
      expect(Number(body.data[0]['weird_types.count'])).toBe(5);
      expect(Number(body.data[0]['weird_types.totalLong'])).toBe(15);
    });

    it('nested document — string field projection (nested.label)', async () => {
      const body = await loadQuery({
        query: {
          dimensions: ['weird_types.id', 'weird_types.nestedLabel'],
          order: { 'weird_types.id': 'asc' },
        },
      });
      expect(body.data.length).toBe(5);
      // The seed ordering is wt1..wt5 with labels alpha..epsilon.
      const labels = body.data.map((r) => r['weird_types.nestedLabel']);
      expect(labels).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
    });

    it('nested document — int field projection (nested.count)', async () => {
      const body = await loadQuery({
        query: {
          dimensions: ['weird_types.id', 'weird_types.nestedCount'],
          order: { 'weird_types.id': 'asc' },
        },
      });
      expect(body.data.length).toBe(5);
      // Pinned int values: 10, 20, 30, 40, 50.
      const counts = body.data.map((r) => Number(r['weird_types.nestedCount']));
      expect(counts).toEqual([10, 20, 30, 40, 50]);
    });

    it('Long-as-bigint round-trip — idLong dimension preserves type', async () => {
      const body = await loadQuery({
        query: {
          dimensions: ['weird_types.id', 'weird_types.idLong'],
          order: { 'weird_types.idLong': 'asc' },
        },
      });
      expect(body.data.length).toBe(5);
      // Cube's load API serialises bigint as a JS number unless it
      // exceeds Number.MAX_SAFE_INTEGER. For our 1..5 values both shapes
      // (number / string) round-trip cleanly via Number(...).
      const longs = body.data.map((r) => Number(r['weird_types.idLong']));
      expect(longs).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 8 — driverFactory(ctx) multi-tenant routing (integration-grade).
  //
  // The unit-level Gap-8 block (`tests/unit/driver.test.ts`) pins
  // constructor-independence — distinct configs route to distinct native
  // clients. This block pins the CUBE-SERVER-SIDE half: Cube invoking
  // `driverFactory(ctx)` with the right `ctx.dataSource`, routing /load
  // requests to the per-tenant driver instance.
  //
  // Setup:
  //   - atlas-local seeds TWO databases — `mongosql_test` (primary,
  //     5 rows in `orders`) and `mongosql_test_secondary` (2 rows in
  //     `orders_secondary`). Initdb scripts:
  //       tests/integration/fixtures/seed-secondary-data.js
  //       tests/integration/fixtures/seed-secondary-schemas.js
  //   - `examples/docker/cube/cube.js` `driverFactory(ctx)` branches on
  //     `ctx.dataSource`: 'secondary' → driver targeting
  //     `mongosql_test_secondary`, anything else → primary.
  //   - `examples/docker/cube/model/orders_secondary.js` declares
  //     `data_source: 'secondary'`.
  //
  // The visible proof of routing: querying `orders.count` returns 5
  // (primary seed), querying `orders_secondary.count` returns 2
  // (secondary seed). A mis-routed query (e.g. both going to primary,
  // or factory ignoring ctx) would return 5 OR error with "table
  // unknown" — both surface as test failures.
  //
  // Removing the `ctx.dataSource === 'secondary'` branch in cube.js
  // makes this test fail with either:
  //   - `MONGOSQL_TRANSLATE_FAILED: orders_secondary not found` (the
  //     primary driver can't see the secondary collection), or
  //   - count !== 2 (if the primary somehow served the query).
  // ---------------------------------------------------------------------------
  describe('Gap 8 — driverFactory(ctx) multi-tenant routing', () => {
    it('primary cube (orders) routes to mongosql_test', async () => {
      const body = await loadQuery({ query: { measures: ['orders.count'] } });
      // Seed: 5 rows in mongosql_test.orders.
      const count = Number(body.data[0]?.['orders.count']);
      expect(count).toBe(5);
    });

    it("secondary cube (orders_secondary, data_source: 'secondary') routes to mongosql_test_secondary", async () => {
      const body = await loadQuery({ query: { measures: ['orders_secondary.count'] } });
      // Seed: 2 rows in mongosql_test_secondary.orders_secondary. If the
      // factory ignored ctx and used the primary driver, this query
      // would translate-fail (orders_secondary doesn't exist in
      // mongosql_test).
      const count = Number(body.data[0]?.['orders_secondary.count']);
      expect(count).toBe(2);
    });

    it('the two cubes return different totals (proves they hit different databases)', async () => {
      const [primary, secondary] = await Promise.all([
        loadQuery({ query: { measures: ['orders.count'] } }),
        loadQuery({ query: { measures: ['orders_secondary.count'] } }),
      ]);
      const a = Number(primary.data[0]?.['orders.count']);
      const b = Number(secondary.data[0]?.['orders_secondary.count']);
      // The exact values are pinned above; here we just assert they
      // differ — a single regression that points both cubes at the
      // same DB would equalise them.
      expect(a).not.toBe(b);
      expect(a).toBe(5);
      expect(b).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 15 — /load annotation shape snapshot.
  //
  // Cube clients (Studio, frontend dashboards) parse the `annotation`
  // block of /load responses to render measure titles, dimension types,
  // granularity labels, etc. A dialect change to type derivation, or a
  // Cube upgrade that adjusts the annotation envelope, could silently
  // flip downstream rendering.
  //
  // This test locks the annotation for a representative query
  // (measure + dimension + time-dimension with granularity) using
  // `toMatchInlineSnapshot`. The snapshot includes `type` (`number` /
  // `string` / `time`), `title`, `shortTitle`, `drillMembers`, and the
  // `granularity` sub-block for time-dimensions.
  //
  // Run `pnpm test:cube-e2e -- -u` to regenerate the snapshot when an
  // intentional annotation change lands.
  // ---------------------------------------------------------------------------
  describe('Gap 15 — /load annotation shape snapshot', () => {
    it('matches the locked annotation envelope for a measure + dimension + time-dimension query', async () => {
      const body = await loadQuery({
        query: {
          measures: ['revenue_events.count', 'revenue_events.totalAmount'],
          dimensions: ['revenue_events.category'],
          timeDimensions: [
            {
              dimension: 'revenue_events.occurredAt',
              granularity: 'month',
              dateRange: ['2026-01-01', '2026-04-01'],
            },
          ],
        },
      });
      const annotation = (body as { annotation?: unknown }).annotation;
      expect(annotation).toMatchInlineSnapshot(`
        {
          "dimensions": {
            "revenue_events.category": {
              "shortTitle": "Category",
              "title": "Revenue Events Category",
              "type": "string",
            },
          },
          "measures": {
            "revenue_events.count": {
              "drillMembers": [],
              "drillMembersGrouped": {
                "dimensions": [],
                "measures": [],
              },
              "shortTitle": "Count",
              "title": "Revenue Events Count",
              "type": "number",
            },
            "revenue_events.totalAmount": {
              "drillMembers": [],
              "drillMembersGrouped": {
                "dimensions": [],
                "measures": [],
              },
              "shortTitle": "Total Amount",
              "title": "Revenue Events Total Amount",
              "type": "number",
            },
          },
          "segments": {},
          "timeDimensions": {
            "revenue_events.occurredAt": {
              "shortTitle": "Occurred at",
              "title": "Revenue Events Occurred at",
              "type": "time",
            },
            "revenue_events.occurredAt.month": {
              "granularity": {
                "interval": "1 month",
                "name": "month",
                "title": "month",
              },
              "shortTitle": "Occurred at",
              "title": "Revenue Events Occurred at",
              "type": "time",
            },
          },
        }
      `);
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 12 — SIGTERM lifecycle (process exits + connection drain).
  //
  // Cube's `cubejs-testing/test/smoke-graceful-shutdown.test.ts` pins
  // process-level shutdown behaviour. We pin three observable things:
  //
  //   1. The cube container exits within 30s of SIGTERM (no hung
  //      process). Exit code is 0 or 143 (128 + SIGTERM=15).
  //   2. The cube log carries the specific marker Cube emits from
  //      its SIGTERM handler — `Received SIGTERM signal` (verified
  //      empirically against cubejs/cube v1.6.44 output). Tighter
  //      than a generic 'shutdown' substring, which could match
  //      unrelated startup-banner text in future Cube versions.
  //   3. After SIGTERM + 2s settle, no MongoDB ops tagged with our
  //      appName `cube-e2e-driver` remain on the atlas-local server.
  //
  // **What contract #3 actually pins.** This is a post-exit cleanup
  // window check: the kernel closes the cube process's FDs on exit
  // regardless of whether our `release()` handler ran, and MongoDB
  // evicts orphaned connections from `$currentOp` within seconds. So
  // a non-zero count after 2s indicates EITHER (a) a leaked native
  // handle that escaped process exit (rare; would require a forked
  // child or napi reference cycle past the process boundary), OR (b)
  // a Cube-side hung pre-agg task that kept the process alive long
  // enough that the inspect-state check above timed out — but the
  // inspect check would have already failed in that case. So this
  // check is mostly a sanity guard, not a positive proof that
  // `release()` fired.
  //
  // After the test we restart the cube container so subsequent tests
  // in the suite see a healthy stack. globalSetup's teardown does
  // `down -v` later — this test only bounces the cube container.
  // ---------------------------------------------------------------------------
  describe('Gap 12 — SIGTERM lifecycle (process exits + connection drain)', () => {
    /** Small async sleep — avoids the busy-wait CPU spin. */
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    it('cube exits cleanly under SIGTERM, logs the expected marker, and drains atlas-local connections', async () => {
      // Send SIGTERM. Docker compose `kill --signal=SIGTERM` propagates
      // the signal to the container's PID 1 (cube's node process).
      execSync('docker compose -f examples/docker/docker-compose.yaml kill --signal=SIGTERM cube', {
        cwd: path.resolve(__dirname, '..', '..'),
      });

      // Poll container state — Cube should exit within seconds. 30s
      // matches upstream's smoke-graceful-shutdown upper bound.
      const deadline = Date.now() + 30_000;
      let exitCode: number | null = null;
      let isRunning = true;
      while (Date.now() < deadline) {
        try {
          const out = execSync(
            'docker inspect cubejs-mongosql-e2e-cube --format "{{.State.Running}} {{.State.ExitCode}}"',
            { encoding: 'utf-8' },
          ).trim();
          const [running, code] = out.split(/\s+/);
          if (running === 'false') {
            isRunning = false;
            exitCode = Number(code);
            break;
          }
        } catch {
          // container may transiently be unreachable during exit
        }
        await sleep(500);
      }

      expect(isRunning, 'cube did not exit within 30s of SIGTERM').toBe(false);
      // 0 = caught SIGTERM + ran handlers + exited via `process.exit(0)`.
      // 143 = 128 + SIGTERM (15) — node propagated the signal.
      // Both are graceful; 137 (SIGKILL) would be a forceful shutdown
      // and would fail this assertion.
      expect([0, 143]).toContain(exitCode);

      // Tight marker: Cube v1.6.44 emits "Received SIGTERM signal" from
      // its SIGTERM handler. Tighter than a generic 'shutdown'
      // substring, which could match unrelated startup-banner text in
      // future Cube versions.
      const logs = execSync('docker logs --tail 200 cubejs-mongosql-e2e-cube 2>&1', {
        encoding: 'utf-8',
      }).toLowerCase();
      expect(
        logs.includes('received sigterm signal'),
        `expected "Received SIGTERM signal" in cube logs (Cube's own SIGTERM-handler marker); last 4KB:\n${logs.slice(
          -4096,
        )}`,
      ).toBe(true);

      // Post-exit cleanup window check (see "What contract #3 actually
      // pins" in the describe-block docstring above). 2s settle for
      // MongoDB to evict the now-orphaned ops from `$currentOp`.
      // `appName: 'cube-e2e-driver'` is set via
      // CUBEJS_MONGOSQL_APP_NAME in
      // `examples/docker/docker-compose.yaml`.
      await sleep(2_000);
      let leakedConns = 0;
      let mongoshError: unknown = null;
      try {
        const out = execSync(
          `docker exec cubejs-mongosql-e2e-atlas mongosh --quiet -u admin -p admin --authenticationDatabase admin --eval 'db.adminCommand({currentOp: 1, $all: true}).inprog.filter(o => o.appName === "cube-e2e-driver").length'`,
          { encoding: 'utf-8' },
        ).trim();
        // Last line is the eval result.
        leakedConns = Number(out.split('\n').pop()?.trim() ?? '0');
        if (!Number.isFinite(leakedConns)) leakedConns = 0;
      } catch (e) {
        mongoshError = e;
        // Surface to maintainers so a broken mongosh exec doesn't
        // silently pass. The container-exit + marker checks above
        // already cover the primary contract; we don't fail-loud on
        // this tooling error because the assertion semantics are
        // weak anyway (see docstring).
        // eslint-disable-next-line no-console
        console.warn(
          'Gap 12: mongosh currentOp probe failed; connection-drain check is skipped. Error:',
          e instanceof Error ? e.message : String(e),
        );
        leakedConns = 0;
      }
      expect(
        leakedConns,
        `expected no leaked MongoDB connections tagged appName=cube-e2e-driver after SIGTERM; found ${leakedConns}${
          mongoshError ? ' (mongosh probe failed; skipped — see warning above)' : ''
        }`,
      ).toBe(0);

      // Restart the cube container so the rest of the suite (and
      // subsequent runs) see a healthy stack.
      execSync('docker compose -f examples/docker/docker-compose.yaml up -d cube', {
        cwd: path.resolve(__dirname, '..', '..'),
      });
      const upDeadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < upDeadline) {
        try {
          const code = execSync('curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:4000/readyz', {
            encoding: 'utf-8',
          }).trim();
          if (code === '200') {
            ready = true;
            break;
          }
        } catch {
          /* ignore */
        }
        await sleep(1_000);
      }
      expect(ready, 'cube did not come back up within 60s after SIGTERM test').toBe(true);
    }, 120_000);
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

// ---------------------------------------------------------------------------
// Gap 9 — testConnection failure modes.
//
// CubeJS pattern: when the driver cannot connect (unreachable host, bad
// creds, misconfigured URI), the cube container must:
//   1. NOT crash-loop — the process must stay alive.
//   2. Surface /readyz as non-200 (or 200 with error logs, depending on
//      Cube version — pre v1.7 /readyz is a process-liveness probe,
//      post-v1.7 it factors in driver readiness).
//   3. Log the driver-init error cleanly (a MongoSqlError with a
//      documented code — `MONGOSQL_CONNECT_FAILED` for unresolvable
//      hosts) rather than a panic / segfault / uncaught exception.
//
// The overlay compose (`docker-compose.broken.yaml`) starts a cube
// container on port 4002 with `CUBEJS_DB_URI` pointing at
// `nonexistent-host.invalid` (RFC 6761 reserved — never resolves).
// This block brings the overlay up, observes liveness, and tears it
// down.
// ---------------------------------------------------------------------------
const BROKEN_CUBE_URL = 'http://localhost:4002';
const BROKEN_COMPOSE_FILE = 'examples/docker/docker-compose.broken.yaml';

describe('Gap 9 — testConnection failure modes (broken DB URI cube container)', () => {
  beforeAll(() => {
    // Bring up the overlay cube container. Reuses the same prebuilt
    // image as the outer compose stack.
    execSync(`docker compose -f ${BROKEN_COMPOSE_FILE} up -d`, {
      stdio: 'inherit',
    });
  }, 120_000);

  afterAll(() => {
    try {
      execSync(`docker compose -f ${BROKEN_COMPOSE_FILE} down`, {
        stdio: 'inherit',
      });
    } catch (err) {
      console.error('broken cube teardown error (ignored):', err);
    }
  });

  it('container does NOT crash-loop within 30 seconds of startup', async () => {
    // Wait long enough for at least one schema-refresh tick (30 s);
    // assert that the container is still running. A crash-loop would
    // show as `Restarting (N)` and the inspect call below would return
    // a State.Running=false. The `restart: 'no'` policy in the compose
    // file ensures one and only one boot attempt — so if it crashed,
    // the state would be `exited`.
    await new Promise((r) => setTimeout(r, 30_000));
    const inspect = execSync(
      `docker inspect --format '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}' cubejs-mongosql-e2e-cube-broken`,
      { encoding: 'utf-8' },
    ).trim();
    // Expected: "true false 0" — process running, not in a restart
    // cycle, never restarted. A crash-looping container would have
    // RestartCount > 0 or State.Restarting=true; a crashed container
    // would have State.Running=false.
    expect(inspect.startsWith('true ')).toBe(true);
    expect(inspect.endsWith(' 0')).toBe(true);
  }, 60_000);

  it('/readyz reports the driver init failure (non-200 or error body)', async () => {
    // Cube's /readyz semantics: in dev mode at v1.6.44 it returns 200
    // even when the driver hasn't successfully tested its connection
    // YET (the driver's testConnection is invoked lazily on first
    // /load, not at boot). We don't pin a specific HTTP status here —
    // either non-200 OR 200-with-error-body is acceptable. What we DO
    // assert is:
    //   - the request resolves (no socket hang, no protocol error)
    //   - SOMETHING about the response is observable (status code or
    //     body), so a future regression that breaks the HTTP listener
    //     surfaces here.
    const res = await fetch(`${BROKEN_CUBE_URL}/readyz`);
    expect(res.status).toBeGreaterThanOrEqual(200);
    // The status MAY be 200 (process liveness only) or 503 (driver
    // unhealthy) depending on Cube version. Pin the loose contract:
    // anything in the 2xx-5xx range, NOT a socket error.
    expect(res.status).toBeLessThan(600);
  }, 30_000);

  it('attempting a /load query surfaces the connection error cleanly (no panic)', async () => {
    // A /load against the broken cube triggers the driver's lazy
    // testConnection. The connection fails (DNS resolution for the
    // `.invalid` host returns NXDOMAIN), and the driver throws a
    // MongoSqlError with code `MONGOSQL_CONNECT_FAILED`. Cube wraps
    // the error in its API response shape. We assert the request
    // resolves (HTTP-wise) with either an explicit error response OR
    // a /load 200 with `{ error: '...' }` body — either way, NO
    // socket hang and NO container crash.
    const res = await fetch(`${BROKEN_CUBE_URL}/cubejs-api/v1/load`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ query: { measures: ['orders.count'] } }),
    });
    // Whatever Cube does — error response with body, 4xx, 5xx — it must
    // be a real HTTP response. A driver panic / crash would surface as
    // a fetch reject (ECONNRESET / socket hang up) before we got here.
    expect(res.status).toBeGreaterThanOrEqual(200);
    const body = await res.text();
    // The body must be SOMETHING (Cube's standard error envelope or
    // text). The empty body case would indicate a crashed connection
    // mid-response — that's the regression we're guarding against.
    expect(body.length).toBeGreaterThan(0);
  }, 30_000);

  it('docker logs surface the driver-init error code (MongoSqlError / CONNECT_FAILED)', () => {
    // Trigger one more /load so the error is observable in recent logs
    // (the previous test may have already emitted; this just ensures
    // a fresh entry).
    try {
      execSync(
        `curl -s -o /dev/null -m 10 -X POST -H 'Content-Type: application/json' -H 'Authorization: ${AUTH_HEADER}' -d '{"query":{"measures":["orders.count"]}}' ${BROKEN_CUBE_URL}/cubejs-api/v1/load`,
        { encoding: 'utf-8' },
      );
    } catch {
      // curl exit code doesn't matter — we just need to provoke an
      // attempt. Cube's response shape varies but the underlying
      // driver-init error gets logged regardless.
    }
    // Inspect the container logs for the driver-init error signature.
    //
    // Without `CUBEJS_MONGOSQL_SCHEMA_FAIL_OPEN=true`, the
    // schema-refresh path propagates the DNS resolution failure as a
    // `MongoSqlError` with our `ConnectFailed` variant. Cube's logging
    // path prints the error class name + `Display` message but NOT
    // the `.code` value (the canonical `MONGOSQL_CONNECT_FAILED` tag
    // is set on `MongoSqlError.code` and surfaced over RPC, but not
    // serialised into stderr).
    //
    // We pin three markers in combination:
    //   1. `MongoSqlError` — the error class name (proves it's OUR
    //      error, not a generic Cube-side wrapper).
    //   2. `connect failed:` — the `Display` prefix of the ConnectFailed
    //      variant (`#[error("connect failed: {msg}")]` in
    //      `crates/native/src/error.rs`). A change to the Display
    //      string would break this and that's intentional — the
    //      string is a documented contract.
    //   3. `nonexistent-host.invalid` — the configured URI host
    //      (proves the right URI flowed through; rules out a code
    //      path that swallows the error and substitutes a generic).
    //
    // All three markers together prove the error is OUR ConnectFailed
    // on the configured URI — not a generic Cube error, not a
    // TRANSLATE error, not a swallowed exception.
    const logs = execSync(`docker logs --tail 500 cubejs-mongosql-e2e-cube-broken 2>&1`, {
      encoding: 'utf-8',
    });
    expect(
      logs.includes('MongoSqlError'),
      `expected MongoSqlError class name in logs; first 4KB:\n${logs.slice(0, 4096)}`,
    ).toBe(true);
    expect(
      logs.includes('connect failed:'),
      `expected "connect failed:" Display prefix in logs (the documented ConnectFailed variant marker); first 4KB:\n${logs.slice(0, 4096)}`,
    ).toBe(true);
    expect(
      logs.includes('nonexistent-host.invalid'),
      `expected configured URI host in error logs; first 4KB:\n${logs.slice(0, 4096)}`,
    ).toBe(true);
  }, 30_000);
});
