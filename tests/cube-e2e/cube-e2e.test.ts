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
 * Known limitation surfaced during T19 (filed as a follow-up below):
 *   * mongosql v1.8.5's algebrizer rejects qualified column refs of
 *     the form `<table_alias>.<col>` even when the alias matches the
 *     FROM clause's collection (Error 3008 "Field `orders` ...").
 *     Cube's BaseQuery emits this form for every dimension, so any
 *     query with a `dimensions: [...]` term fails translation. The
 *     driver works correctly via direct SQL (verified in
 *     `tests/integration/basic-queries.test.ts`); the dialect needs a
 *     follow-up to suppress the table-alias prefix in single-cube
 *     queries. Tracked as a T13/T14 follow-up after T19.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    if (
      'error' in json &&
      typeof json.error === 'string' &&
      /continue wait/i.test(json.error)
    ) {
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

describe('Cube E2E — cubejs-mongosql-driver via cubejs/cube image', () => {
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
  }, 60_000);

  afterAll(() => {
    // Compose teardown is handled by globalSetup return value. Nothing
    // to do here — leaving the hook present so the suite has a
    // consistent shape and any test-specific resources can be released
    // here in future without restructuring.
  });

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
    const measureNames = (orders?.measures as Array<{ name: string }>).map(
      (m) => m.name,
    );
    expect(measureNames).toContain('orders.count');
    expect(measureNames).toContain('orders.totalAmount');
    // Dimensions are declared but currently unusable via /load due to
    // the `<alias>.<col>` qualified-ref limitation in mongosql v1.8.5
    // (see file header). The dimensions ARE visible in /meta which
    // confirms the cube compiled.
    const dimNames = (orders?.dimensions as Array<{ name: string }>).map(
      (d) => d.name,
    );
    expect(dimNames).toContain('orders.accountId');
    expect(dimNames).toContain('orders.status');
    expect(dimNames).toContain('orders.createdAt');
  });
});
