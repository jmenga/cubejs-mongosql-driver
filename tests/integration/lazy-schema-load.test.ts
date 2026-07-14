/**
 * Integration regression for the empty-catalog window (GitHub issue #2):
 *
 *   "query()/downloadQueryResults() translate against an empty catalog when
 *    testConnection() hasn't primed the schema cache"
 *
 * Cube's pre-aggregation refresh-worker path can invoke `downloadQueryResults()`
 * (and `query()` / `tablesSchema()`) on a `MongoSqlDriver` instance whose
 * `testConnection()` has NOT run first. Before the fix, the native query path
 * translated against an empty catalog and every translate failed with a
 * misleading mongosql algebrize error ("Field `t` ... cannot be resolved to
 * any datasource"), which reads as a schema/data problem rather than a
 * driver-lifecycle one — crash-looping the pod.
 *
 * These tests construct a fresh driver and deliberately DO NOT call
 * `testConnection()` before the query paths. Each must resolve by lazily
 * priming the schema (native `ensure_schema_loaded`, shared `init_once` guard)
 * rather than throwing a translate/algebrize error.
 *
 * Runs against the real Rust binary + atlas-local fixture (same seed as
 * `basic-queries.test.ts`). No network mocking.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';

const TEST_DB = 'mongosql_test';
const URI =
  process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true';

function freshDriver(): MongoSqlDriver {
  return new MongoSqlDriver({
    uri: URI,
    database: TEST_DB,
    // Long enough that the background refresh task never fires mid-test.
    schemaRefreshSec: 3600,
    queryTimeoutMs: 10_000,
    maxRows: 1000,
  });
}

describe('MongoSqlDriver — lazy schema load without a prior testConnection() (issue #2)', () => {
  let driver: MongoSqlDriver | undefined;

  afterEach(async () => {
    await driver?.release();
    driver = undefined;
  });

  it('query() resolves without a prior testConnection() (lazy load, not an algebrize error)', async () => {
    driver = freshDriver();
    // NOTE: deliberately NO `await driver.testConnection()` here — this is the
    // exact ordering the Cube pre-agg refresh worker can produce.
    const rows = await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    expect(rows).toEqual([{ n: 4 }]);
  });

  it('reproduces the issue verbatim: SELECT `t`.<col> FROM <coll> AS `t` resolves', async () => {
    // The issue's reproduction shape — an aliased single-table projection.
    // Pre-fix this threw `MongoSqlError: translate failed: algebrize error:
    // Error 3008 ... cannot be resolved to any datasource`.
    driver = freshDriver();
    const rows = await driver.query<Record<string, unknown>>(
      'SELECT `t`.email AS email FROM users AS `t` ORDER BY email ASC LIMIT 1',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('email', 'alice@example.com');
  });

  it('downloadQueryResults() resolves without a prior testConnection() (refresh-worker path)', async () => {
    // This is the method Cube's `PreAggregationLoader.refreshReadOnlyExternalStrategy`
    // drives — the one that crash-looped in the report.
    driver = freshDriver();
    const result = await driver.downloadQueryResults('SELECT amount, status FROM orders LIMIT 3', []);
    expect(result).toHaveProperty('rows');
    expect(result).toHaveProperty('types');
    const names = result.types.map((t) => t.name);
    expect(names).toEqual(['amount', 'status']);
  });

  it('tablesSchema() resolves the real catalog without a prior testConnection()', async () => {
    // Cube's incremental-schema introspection (getSchemas / *ForSpecificSchemas
    // / *ForSpecificTables) renders from this snapshot — pre-fix it returned an
    // empty `{<db>: {}}` so Cube believed the database had no tables.
    driver = freshDriver();
    const schema = await driver.tablesSchema();
    expect(schema).toHaveProperty(TEST_DB);
    const db = schema[TEST_DB];
    expect(Object.keys(db)).toEqual(expect.arrayContaining(['users', 'orders', 'accounts']));
  });

  it('getSchemas() is non-empty without a prior testConnection() (introspection entry point)', async () => {
    driver = freshDriver();
    const schemas = await driver.getSchemas();
    expect(schemas).toEqual([{ schema_name: TEST_DB }]);
  });
});
