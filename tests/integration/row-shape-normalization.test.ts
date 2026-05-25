/**
 * Integration regression for the row-shape-normalization fix.
 *
 * **Bug.** mongosql's `$project` stage that references a nested-path
 * expression (e.g. `agent.displayName`) OMITS the field from the output
 * row when the source document doesn't carry that path — it does not
 * emit `null`. With `ORDER BY <nested-field> ASC`, the rows missing the
 * field sort to the top of the result. Cube's native
 * `getFinalQueryResult` transform compiles its row→member extraction
 * plan from row 0's keys. Without driver-side normalization, the
 * sparse-row-0 case causes Cube to drop the column from every row in
 * the response — even rows that DO have the value.
 *
 * **Fix.** `MongoSqlDriver.query()` runs the rows through
 * `normalizeRowShape` after `flattenRows`: it takes the union of keys
 * across all rows and null-fills any row missing a key, so row 0
 * carries the same shape as every other row. `downloadQueryResults`
 * uses the authoritative type list from mongosql's `select_order`
 * instead of a key union (more robust — the union would miss columns
 * absent from EVERY row).
 *
 * **Harness.** The `configs` fixture (see
 * `tests/integration/fixtures/seed-data.js`) seeds 7 docs with
 * `agent.displayName` populated and 3 docs without the `agent` field.
 * The integration test below issues the exact-shape query that
 * triggered the production bug: `SELECT id, agent.displayName ...
 * ORDER BY agent.displayName ASC`. Pre-fix, the 3 sparse rows sort
 * first and `getFinalQueryResult` would have dropped the column.
 * Post-fix, every row carries the `agent_display_name` key (null on
 * the sparse rows, real string on the populated rows).
 *
 * The test must FAIL without the fix and PASS with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';

const TEST_DB = 'mongosql_test';

describe('MongoSqlDriver — row-shape normalization (sparse nested-path projection)', () => {
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

  it('SELECT id, agent.displayName FROM configs returns the alias on every row (sparse + populated)', async () => {
    // Without ORDER BY first — sanity: 10 rows back, 7 with a name, 3
    // without. The driver must null-fill the missing key on the sparse
    // rows so callers see a uniform key set.
    const rows = await driver.query<Record<string, unknown>>(
      'SELECT id, agent.displayName AS agent_display_name FROM configs',
    );
    expect(rows).toHaveLength(10);
    // Every row carries both keys (post-normalize). If the fix is NOT
    // applied, the 3 sparse rows would lack `agent_display_name`.
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['agent_display_name', 'id']);
    }
    const populated = rows.filter((r) => r.agent_display_name !== null);
    const sparse = rows.filter((r) => r.agent_display_name === null);
    expect(populated).toHaveLength(7);
    expect(sparse).toHaveLength(3);
    // The 3 sparse rows are the cfg_h/i/j seed docs.
    const sparseIds = sparse.map((r) => r.id).sort();
    expect(sparseIds).toEqual(['cfg_h', 'cfg_i', 'cfg_j']);
  });

  it('ORDER BY agent.displayName ASC sorts the sparse rows to the TOP — row 0 must still carry the key', async () => {
    // This is the exact-shape query that triggered the production
    // useAgentsList bug. mongosql sorts the rows missing
    // `agent.displayName` to the front (nulls-first) — pre-fix, Cube's
    // native `getFinalQueryResult` would sniff row 0's keys and drop
    // `agent_display_name` from every row. Post-fix, normalize keeps
    // the key (with `null`) on row 0 so the sniff sees it.
    const rows = await driver.query<Record<string, unknown>>(
      'SELECT id, agent.displayName AS agent_display_name FROM configs ' + 'ORDER BY agent_display_name ASC LIMIT 10',
    );
    expect(rows).toHaveLength(10);
    // Row 0 carries the key (this is THE assertion the bug was about —
    // pre-fix this would throw because the key would be missing).
    expect(rows[0]).toHaveProperty('agent_display_name');
    // And row 0 is a sparse row (sorts to the top by nulls-first).
    expect(rows[0].agent_display_name).toBeNull();
    // Every row carries the key.
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['agent_display_name', 'id']);
    }
    // First 3 rows are the sparse ones; remaining 7 are in
    // alphabetical order on the name.
    expect(rows.slice(0, 3).every((r) => r.agent_display_name === null)).toBe(true);
    expect(rows.slice(3).map((r) => r.agent_display_name)).toEqual([
      'Alice',
      'Bob',
      'Carol',
      'Dave',
      'Eve',
      'Frank',
      'Grace',
    ]);
  });

  it('downloadQueryResults uses the authoritative type list to null-fill missing keys', async () => {
    // Same query, but routed through `downloadQueryResults` — the
    // pre-aggregation upload path Cube uses to ship rows into Cube
    // Store. Here the null-fill source is mongosql's `select_order`
    // (deterministic; works even if a column is missing from EVERY row).
    const result = (await driver.downloadQueryResults(
      'SELECT id, agent.displayName AS agent_display_name FROM configs ' + 'ORDER BY agent_display_name ASC LIMIT 10',
      [],
    )) as { rows: Array<Record<string, unknown>>; types: Array<{ name: string; type: string }> };
    expect(result.rows).toHaveLength(10);
    // types list carries both columns.
    const typeNames = result.types.map((t) => t.name);
    expect(typeNames).toContain('id');
    expect(typeNames).toContain('agent_display_name');
    // Every row in the rows list has both keys.
    for (const r of result.rows) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('agent_display_name');
    }
    // First 3 rows are the sparse ones — `agent_display_name` is null.
    expect(result.rows.slice(0, 3).every((r) => r.agent_display_name === null)).toBe(true);
  });
});
