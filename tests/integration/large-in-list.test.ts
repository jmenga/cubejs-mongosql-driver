/**
 * Integration test for the large-IN-list workaround.
 *
 * mongosql v1.8.5 translates SQL `IN (v1, ..., vN)` to a pipeline that
 * contains a (potentially right-leaning) `$or` chain. At the Atlas SQL
 * endpoint the chain is right-leaning, which for N ≥ ~100 overflows
 * MongoDB's max BSON nested-object depth (100) and the server rejects
 * the aggregate with `Error code 15 (Overflow): BSONObj exceeds maximum
 * nested object depth`.
 *
 * The driver's Rust-side `pipeline_rewrite::flatten_or_chains_and_collapse_to_in`
 * pass:
 *   1. Flattens right-leaning chains into a single flat array (defeats
 *      the depth cliff).
 *   2. Collapses same-field `$eq` disjunctions to `$in` (so the server
 *      receives the most natural form).
 *
 * This test drives the FULL TS-side path (substituteParameters →
 * translate → execute) with 200 string values in an IN, against
 * atlas-local. Pre-fix, the right-leaning shape — although not produced
 * locally by v1.8.5 against the YAML fixture — would still surface on
 * any future mongosql release that emits the same chain shape; the
 * rewriter defends against it regardless.
 *
 * On atlas-local the local mongosql happens to emit a flat `$or`, so
 * this test pins the end-to-end correctness of the post-collapse `$in`
 * shape: the query must complete and return the expected rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';

const TEST_DB = 'mongosql_test';

describe('MongoSqlDriver — large IN-list workaround', () => {
  let driver: MongoSqlDriver;

  beforeAll(async () => {
    driver = new MongoSqlDriver({
      uri:
        process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true',
      database: TEST_DB,
      schemaRefreshSec: 3600,
      queryTimeoutMs: 30_000,
      maxRows: 10_000,
    });
    await driver.testConnection();
  });

  afterAll(async () => {
    await driver?.release();
  });

  it('IN list with 200 values succeeds and returns rows for matching seed values', async () => {
    // Build 200 synthetic values, then append the real seed value
    // (`acct_a`, 3 matching orders). Both the flatten and the $in
    // collapse must run; the server must accept the resulting
    // pipeline; the rows must be returned.
    const values: string[] = [];
    for (let i = 0; i < 200; i++) values.push(`v${i}`);
    values.push('acct_a');
    const inList = values.map((v) => `'${v}'`).join(', ');
    const sql = `SELECT account_id, status, amount FROM orders WHERE account_id IN (${inList})`;
    const rows = await driver.query<{ account_id: string; status: string; amount: string }>(sql);
    // Per the seed: 3 orders have `account_id = acct_a`.
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.account_id).toBe('acct_a');
    }
    // Sanity: amounts are non-empty strings (Decimal128 wire shape).
    for (const r of rows) {
      expect(typeof r.amount).toBe('string');
      expect(r.amount).toContain('.');
    }
  });

  it('IN list with 200 values + COUNT(*) succeeds (zero matches still wire-clean)', async () => {
    // 200 synthetic values only — no real seed match. The query must
    // SUCCEED and return a well-formed (possibly empty) result set.
    // Pre-fix this is the shape that overflows BSON depth on a real
    // Atlas SQL endpoint.
    const values: string[] = [];
    for (let i = 0; i < 200; i++) values.push(`unmatched_v${i}`);
    const inList = values.map((v) => `'${v}'`).join(', ');
    const sql = `SELECT COUNT(*) AS n FROM orders WHERE account_id IN (${inList})`;
    // Note: mongosql collapses an empty COUNT(*) (with no group key
    // and no matches) to zero rows, so we don't assert on the row
    // count — only that the call succeeds.
    const rows = await driver.query<{ n: number }>(sql);
    expect(Array.isArray(rows)).toBe(true);
  });
});
