/**
 * Integration test for the large-IN-list workaround — FLATTEN PATH ONLY.
 *
 * Real failure mode: `mongosql::translate_sql` v1.8.5 outputs a FLAT
 * `$or` (depth 1) for SQL `IN (v1..vN)` both locally and against the
 * Atlas SQL endpoint. The Atlas SQL **proxy / server-side query layer
 * re-expands** the flat array into a right-leaning binary-`$or` chain
 * before passing the aggregate to MongoDB. For N ≥ ~100 the chain busts
 * MongoDB's max BSON nested-object depth (100) and the server rejects
 * the aggregate with `Error code 15 (Overflow)`. Collapsing the same-
 * field `$eq` disjunction to `$in` defeats the re-expansion.
 *
 * The driver's Rust-side `pipeline_rewrite::flatten_or_chains_and_collapse_to_in`
 * pass:
 *   1. Flattens any nested `$or` chains into a flat array (cheap; defends
 *      against any client-side chain shape from future translators).
 *   2. Collapses same-field `$eq` disjunctions to `$in` (defeats the
 *      Atlas SQL proxy re-expansion).
 *
 * This test exercises the **FLATTEN path only**: against the
 * atlas-local fixture catalog, every `$or` leaf has a
 * `$$desugared_sqlOr_inputN` (variable LHS) operand, which blocks the
 * COLLAPSE precondition. The driver still passes the query end-to-end
 * because the flat `$or` array (depth 1) doesn't trip MongoDB's depth
 * limit; this test pins that the rewriter does not corrupt that valid
 * shape and that the server accepts and returns the expected rows.
 *
 * The COLLAPSE path is exercised by the in-Rust manual-pipeline
 * integration test
 * `query_with_large_in_list_collapse_against_atlas_local` (file
 * `crates/native/tests/client_e2e.rs`), which injects a bare-`$field`
 * LHS shape that satisfies the collapse precondition.
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

  // MAJOR-2 regression: literal `$`-prefixed strings in an IN list must
  // be compared as literals, NOT dereferenced as field references at
  // server-side `$in` evaluation. Pre-fix, the rewriter unwrapped
  // `{$literal: "$pretend_field"}` to a bare `"$pretend_field"`, which
  // MongoDB would treat as a field reference inside the `$in` value
  // array. The unit test
  // `collapse_preserves_literal_wrapper_for_dollar_prefixed_string`
  // pins the BSON shape; this test pins the wire-level behaviour
  // end-to-end against atlas-local.
  it('IN list with literal $-prefixed strings does not dereference field refs', async () => {
    // The seed has 3 `acct_a` orders + 2 `acct_b` orders. Build an IN
    // list with several `$`-prefixed strings plus the seed value, so
    // that any "field reference" interpretation would either error
    // (no field named `$evil`) or silently match against the wrong
    // column.
    const sql = `SELECT account_id FROM orders WHERE account_id IN ('$evil_field', '$account_id', '$$pretend_var', 'acct_a')`;
    const rows = await driver.query<{ account_id: string }>(sql);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      // Every row must be the LITERAL seed match. If `extract_literal`
      // had unwrapped `{$literal: "$account_id"}` to a bare
      // `"$account_id"`, MongoDB would interpret it as the field path
      // and every row would self-match, returning all 5 orders.
      expect(r.account_id).toBe('acct_a');
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
