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
    // configs cube was added for the sparse-nested-path row-shape
    // normalization regression test. Failing here means the configs
    // schema row didn't make it into __sql_schemas.
    expect(meta.cubes.map((c) => c.name)).toContain('configs');
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
    // All four cubes from examples/docker/cube/model/. A missing entry
    // means the cube failed to compile (model syntax error or unresolved
    // `sql_table` at compile time).
    expect(names).toContain('orders');
    expect(names).toContain('revenue_events');
    expect(names).toContain('configs');
    expect(names).toContain('revenue_events_raw');
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
              dateRange: ['2026-01-01', '2026-03-31'],
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
              dateRange: ['2026-01-01', '2026-03-31'],
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
              dateRange: ['2026-01-01', '2026-03-31'],
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
              dateRange: ['2026-01-01', '2026-03-31'],
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
