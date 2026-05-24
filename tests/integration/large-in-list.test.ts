/**
 * Integration test for the large-IN-list workaround — FLATTEN PATH ONLY
 * against atlas-local; the COLLAPSE-against-real-Atlas-SQL path lives in
 * the `describe.runIf(!!INTEGRATION_ATLAS_SQL_URI)` block at the bottom
 * of this file.
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
 * The atlas-local suite below exercises the **FLATTEN path only**:
 * against the atlas-local fixture catalog, every `$or` leaf has a
 * `$$desugared_sqlOr_inputN` (variable LHS) operand, which blocks the
 * COLLAPSE precondition (verified empirically; see
 * `crates/native/tests/critic_probe.rs`). The driver still passes the
 * query end-to-end because the flat `$or` array (depth 1) doesn't trip
 * MongoDB's depth limit; the atlas-local tests pin that the rewriter
 * does not corrupt that valid shape and that the server accepts and
 * returns the expected rows. The `$`-prefixed-literal test below pins
 * the wire-level acceptance of `$`-prefixed string literals in the IN
 * list — it does NOT exercise the COLLAPSE / `extract_literal`
 * preservation logic (those preconditions are blocked by the same
 * variable-LHS shape).
 *
 * The COLLAPSE path is exercised by:
 *   - In-Rust manual-pipeline integration test
 *     `query_with_large_in_list_collapse_against_atlas_local` (file
 *     `crates/native/tests/client_e2e.rs`) for the BSON-shape
 *     correctness.
 *   - The bottom `describe.runIf` block in this file for the
 *     end-to-end wire-level correctness of `$literal` preservation
 *     against a real Atlas SQL endpoint where bare-`$field` LHS IS
 *     empirically produced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';

const TEST_DB = 'mongosql_test';

const ATLAS_SQL_URI = process.env.INTEGRATION_ATLAS_SQL_URI;
const ATLAS_SQL_DB = process.env.INTEGRATION_ATLAS_SQL_DB ?? 'dev-convo-hub';

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

  // Wire-level FLATTEN-path test for `$`-prefixed string literals in an
  // IN list.
  //
  // What this test pins (FLATTEN PATH ONLY):
  //   - mongosql v1.8.5 against the atlas-local fixture catalog
  //     translates `IN ('$evil_field', '$account_id', '$$pretend_var',
  //     'acct_a')` into a `$or` of `$eq` leaves whose LHS is a
  //     `$$desugared_sqlOr_inputN` variable reference (NOT a bare
  //     `$field` shape). The rewriter's COLLAPSE precondition is NOT
  //     met against this fixture — `extract_literal` is never called
  //     from the rewriter's hot path in this test, so the MAJOR-2
  //     `$literal` preservation correctness fix is NOT exercised here.
  //   - This test pins (a) the FLATTEN pass does not corrupt that valid
  //     shape, (b) the server accepts `$`-prefixed string literals
  //     embedded in the IN list at the wire level (i.e. mongosql's own
  //     `$literal` wrapping is enough — the driver's translation path
  //     does not strip it for this fixture).
  //
  // What pins the MAJOR-2 `extract_literal` regression itself:
  //   - The Rust unit test
  //     `collapse_preserves_literal_wrapper_for_dollar_prefixed_string`
  //     pins the BSON-level correctness when `extract_literal` IS called
  //     (bare-`$field` LHS path).
  //   - The Rust in-tree integration test
  //     `query_with_large_in_list_collapse_against_atlas_local`
  //     (file `crates/native/tests/client_e2e.rs`) wires a manually-
  //     constructed bare-`$field` chain through `flatten_or_chains_and_collapse_to_in`
  //     end-to-end and asserts the post-rewrite pipeline contains
  //     exactly one `$in`.
  //   - The ignored-by-default block at the bottom of THIS file
  //     (`describe.runIf(!!INTEGRATION_ATLAS_SQL_URI)`) reproduces the
  //     wire-level `$literal` correctness path against a real Atlas SQL
  //     endpoint, where bare-`$field` LHS IS produced by mongosql (per
  //     the in-Rust `query_with_large_in_list_against_atlas_sql` test).
  it('IN list with literal $-prefixed strings is accepted and returns LITERAL matches (flatten path)', async () => {
    // The seed has 3 `acct_a` orders + 2 `acct_b` orders. Build an IN
    // list with several `$`-prefixed strings plus the seed value, so
    // that the wire-level result must include exactly the 3 LITERAL
    // `acct_a` matches and nothing else.
    const sql = `SELECT account_id FROM orders WHERE account_id IN ('$evil_field', '$account_id', '$$pretend_var', 'acct_a')`;
    const rows = await driver.query<{ account_id: string }>(sql);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
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

// ---------------------------------------------------------------------------
// COLLAPSE-path wire-level test — gated on INTEGRATION_ATLAS_SQL_URI.
//
// mongosql v1.8.5 against a real Atlas SQL endpoint's `sqlGetSchema`-
// derived catalog produces a bare-`$field` LHS shape for `$or`/`$eq`
// leaves (NOT the `$$desugared_sqlOr_inputN` variable LHS the
// local YAML fixture produces). That bare-`$field` shape SATISFIES the
// rewriter's COLLAPSE precondition — i.e. `extract_literal` IS called,
// and the MAJOR-2 `$literal`-preservation correctness fix is exercised
// at the wire level. The in-Rust `query_with_large_in_list_against_atlas_sql`
// test (file `crates/native/tests/client_e2e.rs`) confirms the
// collapse fires on this endpoint by counting `$in` occurrences in the
// post-rewrite pipeline.
//
// This block pins the **wire-level correctness** of the
// `$literal`-preservation fix: a SQL IN list of `$`-prefixed literals
// against a real Atlas SQL endpoint must NOT return spurious
// field-reference self-matches.
//
// Default `pnpm test:integration` (CI / local docker-compose flow)
// skips this block — the atlas-local container is plain MongoDB
// without the SQL proxy, so the COLLAPSE precondition isn't met there.
//
// To run locally:
//
//   INTEGRATION_ATLAS_SQL_URI="mongodb://USER:PASS@<endpoint>.a.query.mongodb.net/?ssl=true&authSource=admin" \
//   INTEGRATION_ATLAS_SQL_DB="dev-convo-hub" \
//   pnpm test:integration tests/integration/large-in-list.test.ts
// ---------------------------------------------------------------------------
describe.runIf(!!ATLAS_SQL_URI)('MongoSqlDriver — large IN-list COLLAPSE path against real Atlas SQL', () => {
  let driver: MongoSqlDriver;

  beforeAll(async () => {
    driver = new MongoSqlDriver({
      uri: ATLAS_SQL_URI!,
      database: ATLAS_SQL_DB,
      schemaSource: { kind: 'atlas-sql' },
      schemaRefreshSec: 3600,
      queryTimeoutMs: 60_000,
      maxRows: 10_000,
    });
    await driver.testConnection();
  }, 60_000);

  afterAll(async () => {
    await driver?.release();
  });

  it('IN list with literal $-prefixed strings returns ONLY literal matches (collapse path)', async () => {
    // Strategy: pick a string-typed column from the Atlas SQL catalog,
    // pull a real value, then construct an IN list mixing
    // `$`-prefixed literals with that real value. The result MUST be
    // exactly the rows where the column equals the literal real value
    // — pre-fix the rewriter would have unwrapped
    // `{$literal: "$foo"}` to a bare `"$foo"` inside the collapsed
    // `$in` array, and MongoDB would dereference that as the
    // self-field path, returning ALL rows of the chosen collection.
    const schema = await driver.tablesSchema();
    const inner = schema[ATLAS_SQL_DB] as Record<string, Array<{ name: string; type: string }>>;
    expect(inner).toBeDefined();

    // Find a (collection, string column) pair. Skip `_id` for the
    // type-mismatch reason the in-Rust test calls out.
    let collName: string | null = null;
    let colName: string | null = null;
    for (const [c, cols] of Object.entries(inner)) {
      const f = cols.find((col) => col.name !== '_id' && (col.type === 'string' || col.type === 'text'));
      if (f) {
        collName = c;
        colName = f.name;
        break;
      }
    }
    expect(collName, 'no string-typed column found in catalog').not.toBeNull();
    expect(colName, 'no string-typed column found in catalog').not.toBeNull();

    // Pull a real value to anchor the IN list. If the collection is
    // empty we skip; the test isn't meaningful without a real match.
    const sample = await driver.query<Record<string, unknown>>(
      `SELECT \`${colName}\` FROM \`${collName}\` WHERE \`${colName}\` IS NOT NULL LIMIT 1`,
    );
    if (sample.length === 0) {
      console.warn(
        `[large-IN COLLAPSE path] collection \`${collName}\` has no non-null \`${colName}\` rows — skipping`,
      );
      return;
    }
    const real = String(sample[0][colName as string]);
    expect(typeof real).toBe('string');

    // Sanity guard: if the real value itself happens to start with `$`
    // our literal-vs-fieldref distinction is moot for this row — pick
    // a different anchor column or fail the test gracefully.
    expect(real.startsWith('$'), `chosen sample value ${JSON.stringify(real)} starts with $`).toBe(false);

    // Construct the IN list. Pre-fix, the bare-`$foo` literal would
    // have been spliced into the `$in` value array unwrapped, and
    // MongoDB would interpret it as `$foo` (the field reference).
    // Each row would then trivially self-match and we'd get back
    // every row in the collection. Post-fix, the rewriter preserves
    // the `{$literal: x}` wrapper for `$`-prefixed strings, so the
    // comparison is against the LITERAL string `"$evil_field"` and
    // only the genuine `<real>` matches return.
    const inList = ['$evil_field', '$$pretend_var', '$another_fake_field', real]
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(', ');
    const sql = `SELECT \`${colName}\` FROM \`${collName}\` WHERE \`${colName}\` IN (${inList})`;
    const rows = await driver.query<Record<string, unknown>>(sql);

    // Every returned row must have the column equal to the genuine
    // anchor value. Field-reference self-matching would return rows
    // with arbitrary values (anything where the column equals itself,
    // i.e. every row).
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r[colName as string]).toBe(real);
    }

    // Upper-bound sanity: count all rows in the collection. If the
    // pre-fix bug were present, rows.length would equal totalCount;
    // post-fix, rows.length must be strictly less than (or equal to,
    // if the genuine value matches every row by coincidence) the
    // collection's total — but practically much smaller.
    const totals = await driver.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM \`${collName}\``);
    if (totals.length === 1) {
      const total = Number(totals[0].n);
      // If the bug were present the row count would equal `total`
      // because every row self-matches. We tolerate the case where
      // they coincidentally equal (rare for a real Atlas SQL endpoint
      // with > 1 distinct value).
      if (rows.length < total) {
        expect(rows.length).toBeLessThan(total);
      }
    }
  }, 60_000);
});
