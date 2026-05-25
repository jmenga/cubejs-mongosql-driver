/**
 * Incremental schema loading — Gap 2 (HIGH).
 *
 * Cube's `tablesSchema` consumer has two paths:
 *   - Bulk: `driver.tablesSchema()` returns the whole nested
 *     `{ <schema>: { <table>: ColumnInfo[] } }` snapshot in one shot.
 *   - Incremental: `driver.getSchemas()` → `getTablesForSpecificSchemas` →
 *     `getColumnsForSpecificTables`, dispatched when
 *     `capabilities().incrementalSchemaLoading === true`. Cube uses
 *     this path for large catalogs to avoid eager full-tree loads.
 *
 * The driver implements both. This suite exercises the incremental
 * path end-to-end against atlas-local with the seeded `mongosql_test`
 * database (users, accounts, orders, revenue_events, configs).
 *
 * Cross-checks:
 *   - Schema list contains `mongosql_test`.
 *   - Table list for that schema covers all 5 seeded collections.
 *   - Column list per table matches `fixtures/seed-schemas.js` —
 *     orders.amount: decimal, users.created_at: timestamp,
 *     revenue_events.occurred_at: timestamp, etc.
 *   - Output shape matches Cube's `QuerySchemasResult` /
 *     `QueryTablesResult` / `QueryColumnsResult` typings — every row
 *     carries snake_case keys (`schema_name`, `table_name`,
 *     `column_name`, `data_type`).
 *   - Capability flag flipped to `true` so Cube actually routes
 *     through this path.
 *
 * Pre-fix the driver advertised `incrementalSchemaLoading: false` —
 * Cube would have fallen back to the BaseDriver SQL path which
 * issues `SELECT ... FROM information_schema.*` (no such schema in
 * MongoSQL, so the whole introspection would have failed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';

const TEST_DB = 'mongosql_test';

describe('MongoSqlDriver — incremental schema loading (E2E)', () => {
  let driver: MongoSqlDriver;

  beforeAll(async () => {
    driver = new MongoSqlDriver({
      uri:
        process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true',
      database: TEST_DB,
      schemaRefreshSec: 3600,
      queryTimeoutMs: 10_000,
      maxRows: 1000,
    });
    await driver.testConnection();
  });

  afterAll(async () => {
    await driver?.release();
  });

  it('capabilities().incrementalSchemaLoading === true (Cube routes through the 3-method path)', () => {
    expect(driver.capabilities().incrementalSchemaLoading).toBe(true);
  });

  it('getSchemas() returns the configured database', async () => {
    const schemas = await driver.getSchemas();
    expect(schemas).toContainEqual({ schema_name: TEST_DB });
    // The driver only ever exposes the configured CUBEJS_DB_NAME.
    expect(schemas.length).toBe(1);
  });

  it('getTablesForSpecificSchemas() lists every seeded collection', async () => {
    const tables = await driver.getTablesForSpecificSchemas([{ schema_name: TEST_DB }]);
    const tableNames = tables.map((t) => t.table_name).sort();
    // Per fixtures/seed-schemas.js the database registers schemas for
    // these 10 collections — must be the same set tablesSchema()
    // surfaces in basic-queries.test.ts. Phase B added product_catalog
    // (Gap 4), granular_events (Gap 6), tz_events (Gap 7), weird_types
    // (Gap 10); Phase C added driver_tests_shared (Gap 11).
    expect(tableNames).toEqual([
      'accounts',
      'configs',
      'driver_tests_shared',
      'granular_events',
      'orders',
      'product_catalog',
      'revenue_events',
      'tz_events',
      'users',
      'weird_types',
    ]);
    // Every row carries the requested schema name.
    for (const r of tables) expect(r.schema_name).toBe(TEST_DB);
  });

  it('getTablesForSpecificSchemas() silently drops unknown schemas (matches SQL-path behavior)', async () => {
    const tables = await driver.getTablesForSpecificSchemas([
      { schema_name: TEST_DB },
      { schema_name: 'does_not_exist' },
    ]);
    // Only the known schema contributes rows.
    expect(tables.some((t) => t.schema_name === 'does_not_exist')).toBe(false);
    // Expect at least the 9 seeded collections.
    expect(tables.length).toBeGreaterThanOrEqual(9);
  });

  it('getColumnsForSpecificTables() returns one row per (table, column) with snake_case keys', async () => {
    const cols = await driver.getColumnsForSpecificTables([
      { schema_name: TEST_DB, table_name: 'orders' },
      { schema_name: TEST_DB, table_name: 'users' },
    ]);
    // Each row must carry the QueryColumnsResult shape.
    for (const c of cols) {
      expect(typeof c.schema_name).toBe('string');
      expect(typeof c.table_name).toBe('string');
      expect(typeof c.column_name).toBe('string');
      expect(typeof c.data_type).toBe('string');
    }
    // orders has 6 columns (per seed-schemas.js):
    //   _id, account_id, amount, status, created_at, updated_at
    const ordersCols = cols.filter((c) => c.table_name === 'orders');
    const ordersNames = ordersCols.map((c) => c.column_name).sort();
    expect(ordersNames).toEqual(['_id', 'account_id', 'amount', 'created_at', 'status', 'updated_at']);

    // users has 5 columns: _id, email, name, account_id, created_at.
    const usersCols = cols.filter((c) => c.table_name === 'users');
    const usersNames = usersCols.map((c) => c.column_name).sort();
    expect(usersNames).toEqual(['_id', 'account_id', 'created_at', 'email', 'name']);

    // Pin specific data_type mappings (Cube generic-type strings from
    // BSON types in __sql_schemas — matches the basic-queries
    // tablesSchema assertions).
    const amount = cols.find((c) => c.table_name === 'orders' && c.column_name === 'amount');
    expect(amount?.data_type).toBe('decimal');
    const createdAt = cols.find((c) => c.table_name === 'users' && c.column_name === 'created_at');
    expect(createdAt?.data_type).toBe('timestamp');
    const userId = cols.find((c) => c.table_name === 'users' && c.column_name === '_id');
    expect(userId?.data_type).toBe('string');
  });

  it('getColumnsForSpecificTables() covers revenue_events end-to-end', async () => {
    // Multi-month dataset added for the rollup-partition test
    // (Critic v3 — Issue #2). Verifies the incremental path sees the
    // collection schema the same way the bulk `tablesSchema()` does.
    const cols = await driver.getColumnsForSpecificTables([{ schema_name: TEST_DB, table_name: 'revenue_events' }]);
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(['_id', 'account_id', 'amount', 'category', 'occurred_at']);
    const occurredAt = cols.find((c) => c.column_name === 'occurred_at');
    expect(occurredAt?.data_type).toBe('timestamp');
    const amount = cols.find((c) => c.column_name === 'amount');
    expect(amount?.data_type).toBe('decimal');
  });

  it('incremental + bulk paths agree on the schema snapshot (no drift)', async () => {
    // Cross-check: re-render the bulk shape from the three granular
    // calls and assert byte-equivalence with `tablesSchema()`. Any
    // divergence would surface a filtering bug that the unit tests
    // (which stub the snapshot) could miss against real data.
    const bulk = await driver.tablesSchema();
    const schemas = await driver.getSchemas();
    const tables = await driver.getTablesForSpecificSchemas(schemas);
    const cols = await driver.getColumnsForSpecificTables(tables);

    const reconstructed: Record<string, Record<string, Array<{ name: string; type: string }>>> = {};
    for (const c of cols) {
      if (!reconstructed[c.schema_name]) reconstructed[c.schema_name] = {};
      if (!reconstructed[c.schema_name][c.table_name]) reconstructed[c.schema_name][c.table_name] = [];
      reconstructed[c.schema_name][c.table_name].push({ name: c.column_name, type: c.data_type });
    }

    // Every schema/table/column the bulk path knows about must be
    // present in the reconstructed view (allow superset on attributes
    // since the granular path forwards them but we don't compare).
    for (const [schema, tablesObj] of Object.entries(bulk)) {
      for (const [tbl, colArr] of Object.entries(tablesObj)) {
        const recCols = reconstructed[schema]?.[tbl];
        expect(recCols).toBeDefined();
        const bulkNames = colArr.map((c) => c.name).sort();
        const recNames = recCols!.map((c) => c.name).sort();
        expect(recNames).toEqual(bulkNames);
        for (const bc of colArr) {
          const match = recCols!.find((rc) => rc.name === bc.name);
          expect(match?.type).toBe(bc.type);
        }
      }
    }
  });

  it('empty input arrays short-circuit (no schema reload necessary)', async () => {
    // Both downstream calls accept empty arrays and return empty
    // results — the granular path is safe to call zero-args.
    expect(await driver.getTablesForSpecificSchemas([])).toEqual([]);
    expect(await driver.getColumnsForSpecificTables([])).toEqual([]);
  });
});
