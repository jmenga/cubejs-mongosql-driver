/**
 * Integration tests for the `atlas-sql` schema-source mode against a real
 * Atlas SQL endpoint (`*.a.query.mongodb.net`).
 *
 * The whole file is gated on `INTEGRATION_ATLAS_SQL_URI`. Without that env
 * var the suite skips at the `describe.runIf` gate so CI runs (which boot
 * atlas-local, not a real Atlas SQL endpoint) never attempt to hit the
 * cloud and our default `pnpm test:integration` stays self-contained.
 *
 * To run locally:
 *
 *   INTEGRATION_ATLAS_SQL_URI="mongodb://USER:PASS@<endpoint>.a.query.mongodb.net/?ssl=true&authSource=admin" \
 *   INTEGRATION_ATLAS_SQL_DB="dev-convo-hub" \
 *   pnpm test:integration tests/integration/atlas-sql.test.ts
 *
 * What this exercises that other suites do not:
 *   - The Rust `load_from_atlas_sql_with_columns` loader: `listCollections`
 *     + per-collection `sqlGetSchema` against a real Atlas SQL endpoint.
 *   - The empty-schema skip path (`{ok: 1, metadata: {}, schema: {}}`) for
 *     collections like `system.views` that exist on the endpoint but have
 *     no SQL schema registered.
 *   - End-to-end driver behavior (`tablesSchema()`, `downloadQueryResults`)
 *     wired through the new atlas-sql code path.
 *
 * See `crates/native/src/schema.rs` module docs for the canonical
 * `sqlGetSchema` spec and the per-mode loader design.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MongoSqlDriver } from '../../src/index.js';
import type { DownloadQueryResultsResult } from '@cubejs-backend/base-driver';

const ATLAS_SQL_URI = process.env.INTEGRATION_ATLAS_SQL_URI;
const ATLAS_SQL_DB = process.env.INTEGRATION_ATLAS_SQL_DB ?? 'dev-convo-hub';

// Only run against the explicitly-configured Atlas SQL endpoint. The
// integration suite's docker-compose harness brings up atlas-local, which
// does NOT expose Atlas SQL — running atlas-sql mode against it would
// fail with "sqlGetSchema not supported" rather than test the new code.
describe.runIf(!!ATLAS_SQL_URI)('atlas-sql schema source — real Atlas SQL endpoint', () => {
  let driver: MongoSqlDriver;

  beforeAll(async () => {
    driver = new MongoSqlDriver({
      uri: ATLAS_SQL_URI!,
      database: ATLAS_SQL_DB,
      schemaSource: { kind: 'atlas-sql' },
      // Long enough that the refresh task does not fire mid-test.
      schemaRefreshSec: 3600,
      queryTimeoutMs: 30_000,
      maxRows: 10_000,
    });
    await driver.testConnection();
  }, 60_000);

  afterAll(async () => {
    await driver?.release();
  });

  it('tablesSchema() exposes the configured database and at least one collection', async () => {
    const schema = await driver.tablesSchema();
    expect(Object.keys(schema)).toContain(ATLAS_SQL_DB);
    const inner = schema[ATLAS_SQL_DB];
    expect(inner).toBeDefined();
    // The endpoint MUST have at least one collection with a schema set;
    // if it doesn't, the test fixture has been mis-configured.
    expect(Object.keys(inner).length).toBeGreaterThan(0);

    // Each column entry carries the standard `{name, type, attributes}` shape.
    for (const cols of Object.values(inner)) {
      expect(Array.isArray(cols)).toBe(true);
      for (const c of cols) {
        expect(typeof c.name).toBe('string');
        expect(typeof c.type).toBe('string');
        expect(Array.isArray(c.attributes)).toBe(true);
      }
    }
  }, 60_000);

  it('downloadQueryResults() runs SELECT COUNT(*) and returns authoritative types', async () => {
    // Dynamically pick the first collection in the catalog so this test
    // is portable across Atlas SQL endpoints — we don't hard-code
    // `calllogs`.
    const schema = await driver.tablesSchema();
    const colls = Object.keys(schema[ATLAS_SQL_DB] ?? {});
    expect(colls.length).toBeGreaterThan(0);
    const coll = colls[0];

    const result = (await driver.downloadQueryResults(
      `SELECT COUNT(*) AS n FROM \`${coll}\``,
    )) as DownloadQueryResultsResult & {
      rows: Array<Record<string, unknown>>;
      types: Array<{ name: string; type: string }>;
    };

    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows.length).toBe(1);
    // Type list comes from `mongosql::select_order` / `result_set_schema`
    // — the same authoritative metadata path the collection-mode tests
    // pin. Atlas SQL mode must NOT regress that.
    expect(Array.isArray(result.types)).toBe(true);
    expect(result.types.length).toBe(1);
    expect(result.types[0].name).toBe('n');
    // COUNT(*) classifies as bigint (mongosql widens Int/Long unions).
    expect(result.types[0].type).toBe('bigint');
  }, 60_000);
});
