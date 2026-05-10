/**
 * Integration tests for `MongoSqlDriver` against the docker-compose
 * atlas-local fixture (`mongosql_test.{users,accounts,orders}` + their
 * `__sql_schemas`). Covers IMPLEMENTATION_PLAN.md T14.
 *
 * Each test asserts BOTH row shape and the actual values produced by
 * the seed in `tests/integration/fixtures/seed-data.js`. No network
 * mocking — every test exercises the real Rust binary against a real
 * MongoDB.
 *
 * Note on JOIN row shape (T11 envelope-flattening):
 *   - `SELECT * FROM a JOIN b ...`        → `{ a: {...}, b: {...} }` →
 *     flattens to `{ a__col, b__col, ... }` (multi-key envelope branch).
 *   - `SELECT a.col, b.col FROM a JOIN b` → `{ "": { col, col } }`     →
 *     flattens to `{ col, col }` because mongosql collapses the
 *     projection into an empty-string envelope key. T14 therefore tests
 *     the `<table>__<col>` flattening path with `SELECT *`, which is the
 *     only shape that triggers it.
 */
import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';
import type { TablesSchema } from '../../src/native.js';

const TEST_DB = 'mongosql_test';

// Per the seed in fixtures/seed-data.js
const SEEDED_USER_EMAILS = ['alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.com'];
const PAID_ORDER_TOTAL = '670.50'; // 150.00 + 200.50 + 320.00

describe('MongoSqlDriver — basic queries (E2E)', () => {
  let driver: MongoSqlDriver;

  beforeAll(async () => {
    driver = new MongoSqlDriver({
      uri:
        process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true',
      database: TEST_DB,
      // Long enough that the refresh task does not fire mid-test.
      schemaRefreshSec: 3600,
      queryTimeoutMs: 10_000,
      maxRows: 1000,
    });
    await driver.testConnection();
  });

  afterAll(async () => {
    await driver?.release();
  });

  it('SELECT * from a single collection returns flattened rows with all expected fields', async () => {
    const rows = await driver.query<Record<string, unknown>>('SELECT * FROM users');
    expect(rows).toHaveLength(SEEDED_USER_EMAILS.length);

    // Single-collection envelope is unwrapped — fields land at top level.
    const sample = rows[0];
    expect(sample).toHaveProperty('email');
    expect(sample).toHaveProperty('name');
    expect(sample).toHaveProperty('account_id');
    expect(sample).toHaveProperty('created_at');
    expect(sample).toHaveProperty('_id');
    expect(typeof sample._id).toBe('string'); // ObjectId rendered as hex string per T08

    const emails = rows.map((r) => r.email).sort();
    expect(emails).toEqual([...SEEDED_USER_EMAILS].sort());
  });

  it('COUNT(*) returns one row with the count', async () => {
    const rows = await driver.query<Record<string, unknown>>('SELECT COUNT(*) AS n FROM users');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ n: 4 });
  });

  it('GROUP BY emits one row per group with correct aggregates', async () => {
    const rows = await driver.query<{ status: string; total: string; c: number }>(
      'SELECT status, COUNT(*) AS c, SUM(amount) AS total FROM orders GROUP BY status',
    );
    expect(rows).toHaveLength(3);

    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r]));
    expect(byStatus.paid).toBeDefined();
    expect(byStatus.pending).toBeDefined();
    expect(byStatus.refunded).toBeDefined();

    expect(byStatus.paid).toMatchObject({ status: 'paid', c: 3, total: PAID_ORDER_TOTAL });
    expect(byStatus.pending).toMatchObject({ status: 'pending', c: 1, total: '99.99' });
    expect(byStatus.refunded).toMatchObject({ status: 'refunded', c: 1, total: '75.25' });
  });

  it('WHERE filters by field equality', async () => {
    const rows = await driver.query<{ email: string; account_id: string }>(
      "SELECT email, account_id FROM users WHERE account_id = 'acct_a'",
    );
    expect(rows).toHaveLength(2);
    const emails = rows.map((r) => r.email).sort();
    expect(emails).toEqual(['alice@example.com', 'bob@example.com']);
    for (const r of rows) expect(r.account_id).toBe('acct_a');
  });

  it('ORDER BY orders results', async () => {
    // Mongosql requires the ORDER BY column to be in the projection.
    const rows = await driver.query<{ email: string; created_at: string }>(
      'SELECT email, created_at FROM users ORDER BY created_at ASC',
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.email)).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
      'dave@example.com',
    ]);
    // Created_at strictly increasing (ISO strings sort lexicographically).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].created_at >= rows[i - 1].created_at).toBe(true);
    }
  });

  it('LIMIT bounds rows', async () => {
    const rows = await driver.query<{ email: string }>('SELECT email FROM users ORDER BY email ASC LIMIT 2');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.email)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('JOIN across two collections produces table-prefixed columns under SELECT *', async () => {
    // SELECT * is the path that yields a multi-key envelope `{ users: {...},
    // orders: {...} }`, which T11's flattenRow merges with `<table>__<col>`
    // keys. Restrict to one row by ordering on a unique numeric column, then
    // assert both prefixes are present and the value pairing is correct.
    const rows = await driver.query<Record<string, unknown>>(
      'SELECT * FROM users JOIN orders ON orders.account_id = users.account_id ' +
        "WHERE orders.status = 'paid' AND users.email = 'dave@example.com' " +
        'ORDER BY orders.amount DESC LIMIT 1',
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // T11 row-flattening contract: <table>__<column> per the multi-key
    // envelope branch in src/MongoSqlDriver.ts::flattenRow.
    expect(row).toHaveProperty('users__email', 'dave@example.com');
    expect(row).toHaveProperty('users__account_id', 'acct_b');
    expect(row).toHaveProperty('orders__amount', '320.00');
    expect(row).toHaveProperty('orders__status', 'paid');
    expect(row).toHaveProperty('orders__account_id', 'acct_b');
    // _id from each side is preserved separately (no collision).
    expect(typeof row.users___id).toBe('string');
    expect(typeof row.orders___id).toBe('string');
  });

  it('JOIN with explicit projection collapses to a flat envelope (mongosql shape)', async () => {
    // `SELECT users.email, orders.amount` projects through mongosql with
    // an empty-string envelope key — the single-key-unwrap branch returns
    // a flat row. This documents the known mongosql behaviour referenced
    // in T11 and the IMPLEMENTATION_PLAN.md 2026-05-10 — T14 discovery.
    // Mongosql rejects `ORDER BY users.col` once the projection is flat
    // (the qualified-name datasource is gone post-projection), so we sort
    // client-side after the fact.
    //
    // Critic v2 — Issue 2 collision check: this projection is collision-
    // safe (`email` ≠ `amount`), so the heuristic in `query()` lets it
    // through. A colliding form (e.g. `SELECT users.account_id,
    // orders.account_id`) would now throw MONGOSQL_TRANSLATE_FAILED;
    // covered by the next test.
    const rows = await driver.query<{ email: string; amount: string }>(
      'SELECT users.email, orders.amount FROM users JOIN orders ' +
        'ON orders.account_id = users.account_id ' +
        "WHERE orders.status = 'paid'",
    );
    // 2 paid orders for acct_a × 2 users (alice, bob) = 4; plus 1 paid for
    // acct_b × 2 users (carol, dave) = 2; total 6 rows.
    expect(rows).toHaveLength(6);
    const sample = rows[0];
    expect(sample).toHaveProperty('email');
    expect(sample).toHaveProperty('amount');
    // No <table>__<col> prefixes here — mongosql flattens.
    expect(sample).not.toHaveProperty('users__email');
    expect(sample).not.toHaveProperty('orders__amount');

    const total = rows.map((r) => Number(r.amount)).reduce((a, b) => a + b, 0);
    // 2 users in acct_a (each paired with 2 paid orders = 150 + 200.5) +
    // 2 users in acct_b (each paired with 1 paid order = 320).
    expect(total).toBeCloseTo(2 * (150 + 200.5) + 2 * 320, 2);
  });

  it('JOIN with un-aliased colliding qualified columns is rejected (Critic v2 — Issue 2)', async () => {
    // Both sides project `account_id` — the BSON envelope `{"": {account_id,
    // account_id}}` would silently lose one column. The driver detects the
    // collision risk from the SQL pre-execution and throws
    // MONGOSQL_TRANSLATE_FAILED so callers know to alias.
    const err = (await driver
      .query<Record<string, unknown>>(
        'SELECT users.account_id, orders.account_id FROM users JOIN orders ' +
          'ON orders.account_id = users.account_id ' +
          "WHERE orders.status = 'paid'",
      )
      .catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('MONGOSQL_TRANSLATE_FAILED');

    // Aliased form: same query but with explicit aliases on the colliding
    // columns. The collision risk goes away → the query goes through and
    // returns rows with the alias names.
    const rows = await driver.query<Record<string, unknown>>(
      'SELECT users.account_id AS u_acct, orders.account_id AS o_acct FROM users JOIN orders ' +
        'ON orders.account_id = users.account_id ' +
        "WHERE orders.status = 'paid'",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('u_acct');
    expect(rows[0]).toHaveProperty('o_acct');
  });

  it('Aggregation — SUM over a Decimal128 field returns a string-form decimal', async () => {
    const rows = await driver.query<{ total: string }>("SELECT SUM(amount) AS total FROM orders WHERE status = 'paid'");
    expect(rows).toHaveLength(1);
    // T08 BSON→JSON: Decimal128 round-trips as a string to preserve precision.
    expect(typeof rows[0].total).toBe('string');
    expect(rows[0].total).toBe(PAID_ORDER_TOTAL);
  });

  it('Decimal128 string contract — pins precision (Critic v2 — Issue 3)', async () => {
    // Lock the Decimal128 → string contract end-to-end: the driver MUST NOT
    // emit a JSON number for Decimal128 columns. JS Number (IEEE 754
    // double) tops out at ~15-17 significant digits; Decimal128 carries up
    // to 34. Returning a number would silently lose precision past the
    // double-safe range, AND would drop the quantum (`4521.50` becomes
    // `4521.5` — an accounting-grade bug for monetary columns).
    //
    // PAID_ORDER_TOTAL is the seeded sum `150.00 + 200.50 + 320.00 =
    // 670.50` — note the preserved trailing zero. `Number(r.total)`
    // would yield `670.5`, losing the cents-scale digit. This test
    // asserts the string form matches byte-for-byte.
    const rows = await driver.query<{ total: string }>("SELECT SUM(amount) AS total FROM orders WHERE status = 'paid'");
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].total).toBe('string');
    expect(rows[0].total).toBe('670.50');
    // Trailing-zero preservation: must NOT be the JS-doubleified form.
    expect(rows[0].total).not.toBe('670.5');
    // Per-row decimal columns also stay as strings.
    const orderRows = await driver.query<{ amount: string }>(
      "SELECT amount FROM orders WHERE status = 'paid' ORDER BY amount ASC",
    );
    for (const r of orderRows) expect(typeof r.amount).toBe('string');
    // Seeded values include `150.00`, `200.50`, `320.00` — every value
    // carries at least one decimal place; the canonical to-string form
    // must include the `.` for accounting-shape inputs.
    for (const r of orderRows) expect(r.amount).toContain('.');
  });

  it('Date filter using CAST(... AS TIMESTAMP) returns rows in range', async () => {
    // CAST(... AS TIMESTAMP) is the canonical date-literal form (mongosql
    // does NOT accept SQL-92 `TIMESTAMP 'literal'`; see T07 discovery).
    const rows = await driver.query<{ account_id: string; amount: string; created_at: string }>(
      'SELECT account_id, amount, created_at FROM orders ' +
        "WHERE created_at > CAST('2026-04-02T12:00:00Z' AS TIMESTAMP) " +
        'ORDER BY created_at ASC',
    );
    // From the seed: orders dated 04-03, 04-04, 04-05 are after 04-02 12:00Z.
    expect(rows).toHaveLength(3);
    const amounts = rows.map((r) => r.amount);
    expect(amounts).toEqual(['99.99', '320.00', '75.25']);
    // T08 dates: in-range BSON DateTime renders as bare RFC 3339 string.
    for (const r of rows) {
      expect(typeof r.created_at).toBe('string');
      expect(r.created_at).toMatch(/^2026-04-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(r.created_at > '2026-04-02T12:00:00Z').toBe(true);
    }
  });

  it('SELECT _id returns ObjectId as a hex string', async () => {
    // T08 / T09 BSON→JSON: ObjectId renders as the 24-char hex string.
    const rows = await driver.query<{ _id: string; email: string }>('SELECT _id, email FROM users LIMIT 1');
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]._id).toBe('string');
    expect(rows[0]._id).toMatch(/^[a-f0-9]{24}$/);
    expect(SEEDED_USER_EMAILS).toContain(rows[0].email);
  });

  it('tablesSchema returns the expected three namespaces with column metadata', async () => {
    const schema: TablesSchema = await driver.tablesSchema();
    // T09 shape: `{ <db>: { <coll>: ColumnInfo[] } }`.
    expect(schema).toHaveProperty(TEST_DB);
    const db = schema[TEST_DB];
    expect(db).toBeDefined();
    expect(Object.keys(db).sort()).toEqual(['accounts', 'orders', 'users']);

    // users columns
    const userColNames = db.users.map((c) => c.name).sort();
    expect(userColNames).toEqual(['_id', 'account_id', 'created_at', 'email', 'name']);

    // orders carries the decimal column at type=decimal
    const amountCol = db.orders.find((c) => c.name === 'amount');
    expect(amountCol).toBeDefined();
    expect(amountCol!.type).toBe('decimal');

    // created_at is timestamp
    const createdAtCol = db.users.find((c) => c.name === 'created_at');
    expect(createdAtCol).toBeDefined();
    expect(createdAtCol!.type).toBe('timestamp');

    // ObjectId / string-_id collapse to "string" per T09 BsonTypeName mapping.
    const userIdCol = db.users.find((c) => c.name === '_id');
    expect(userIdCol!.type).toBe('string');

    // Every ColumnInfo carries name + type + attributes.
    for (const cols of Object.values(db)) {
      for (const c of cols) {
        expect(typeof c.name).toBe('string');
        expect(typeof c.type).toBe('string');
        expect(Array.isArray(c.attributes)).toBe(true);
      }
    }
  });
});
