// Seed sample collections used by integration tests.
// Three collections in the `mongosql_test` database: orders, users, accounts.
// Idempotent — re-runs do nothing harmful.

const db = db.getSiblingDB('mongosql_test');

if (db.users.countDocuments() === 0) {
  db.users.insertMany([
    { _id: ObjectId(), email: 'alice@example.com', name: 'Alice', account_id: 'acct_a', created_at: new Date('2026-01-15T10:00:00Z') },
    { _id: ObjectId(), email: 'bob@example.com',   name: 'Bob',   account_id: 'acct_a', created_at: new Date('2026-02-03T14:30:00Z') },
    { _id: ObjectId(), email: 'carol@example.com', name: 'Carol', account_id: 'acct_b', created_at: new Date('2026-03-22T09:15:00Z') },
    { _id: ObjectId(), email: 'dave@example.com',  name: 'Dave',  account_id: 'acct_b', created_at: new Date('2026-04-08T16:45:00Z') },
  ]);
}

if (db.accounts.countDocuments() === 0) {
  db.accounts.insertMany([
    { _id: 'acct_a', name: 'Acme Corp',  tier: 'enterprise', created_at: new Date('2025-06-01T00:00:00Z') },
    { _id: 'acct_b', name: 'Beta Inc',   tier: 'standard',   created_at: new Date('2025-09-12T00:00:00Z') },
  ]);
}

if (db.orders.countDocuments() === 0) {
  db.orders.insertMany([
    { _id: ObjectId(), account_id: 'acct_a', amount: NumberDecimal('150.00'), status: 'paid',     created_at: new Date('2026-04-01T10:00:00Z'), updated_at: new Date('2026-04-01T10:00:00Z') },
    { _id: ObjectId(), account_id: 'acct_a', amount: NumberDecimal('200.50'), status: 'paid',     created_at: new Date('2026-04-02T11:00:00Z'), updated_at: new Date('2026-04-02T11:00:00Z') },
    { _id: ObjectId(), account_id: 'acct_b', amount: NumberDecimal('99.99'),  status: 'pending',  created_at: new Date('2026-04-03T12:00:00Z'), updated_at: new Date('2026-04-03T12:00:00Z') },
    { _id: ObjectId(), account_id: 'acct_b', amount: NumberDecimal('320.00'), status: 'paid',     created_at: new Date('2026-04-04T13:00:00Z'), updated_at: new Date('2026-04-04T13:00:00Z') },
    { _id: ObjectId(), account_id: 'acct_a', amount: NumberDecimal('75.25'),  status: 'refunded', created_at: new Date('2026-04-05T14:00:00Z'), updated_at: new Date('2026-04-05T14:00:00Z') },
  ]);
}

// `revenue_events` is the multi-month dataset that drives the cube-e2e
// rollup-partition test (Critic v3 — Issue #2). It must span at least
// two distinct months so that a `partition_granularity: 'month'`
// pre-aggregation produces 2+ partitions, which Cube Store will UNION
// together at query time. Pre-fix, the UNION failed with
// `type_coercion ... Timestamp vs Int64` because the driver typed the
// aggregate columns as `text` on one partition and `bigint`/`decimal`
// on another. This dataset is the regression harness.
//
// Keeping the data static (no Date.now()) is required so test
// assertions can pin exact totals.
if (db.revenue_events.countDocuments() === 0) {
  db.revenue_events.insertMany([
    // January 2026 — 3 events, total 100 + 200 + 50.50 = 350.50.
    { _id: ObjectId(), account_id: 'acct_a', amount: NumberDecimal('100.00'), category: 'subscription', occurred_at: new Date('2026-01-05T08:00:00Z') },
    { _id: ObjectId(), account_id: 'acct_b', amount: NumberDecimal('200.00'), category: 'subscription', occurred_at: new Date('2026-01-18T11:30:00Z') },
    { _id: ObjectId(), account_id: 'acct_a', amount: NumberDecimal('50.50'),  category: 'usage',        occurred_at: new Date('2026-01-30T22:15:00Z') },
    // February 2026 — 2 events, total 75 + 125.25 = 200.25.
    { _id: ObjectId(), account_id: 'acct_a', amount: NumberDecimal('75.00'),  category: 'usage',        occurred_at: new Date('2026-02-10T14:00:00Z') },
    { _id: ObjectId(), account_id: 'acct_b', amount: NumberDecimal('125.25'), category: 'subscription', occurred_at: new Date('2026-02-22T09:45:00Z') },
    // March 2026 — 2 events, total 300 + 99.99 = 399.99.
    { _id: ObjectId(), account_id: 'acct_b', amount: NumberDecimal('300.00'), category: 'subscription', occurred_at: new Date('2026-03-07T16:20:00Z') },
    { _id: ObjectId(), account_id: 'acct_a', amount: NumberDecimal('99.99'),  category: 'usage',        occurred_at: new Date('2026-03-28T03:10:00Z') },
  ]);
}

// `configs` is the sparse-nested-path harness for the row-shape
// normalization fix. Each doc has a top-level `id` plus an embedded
// `agent.displayName` — but a deliberate subset of docs are missing
// the `agent` field entirely. With a query that projects
// `agent.displayName` AND `ORDER BY agent.displayName ASC`, mongosql
// emits rows with NO `agent_display_name` key on the missing-source
// docs, and those rows sort to row 0 (nulls-first). Cube's native
// `getFinalQueryResult` transform compiles its row→member extraction
// plan from row 0's keys — without the driver-side normalization, it
// would drop the column from every row in the response. This collection
// is the regression harness for that bug.
if (db.configs.countDocuments() === 0) {
  db.configs.insertMany([
    // 7 docs WITH `agent.displayName` populated.
    { _id: ObjectId(), id: 'cfg_a', agent: { displayName: 'Alice' } },
    { _id: ObjectId(), id: 'cfg_b', agent: { displayName: 'Bob' } },
    { _id: ObjectId(), id: 'cfg_c', agent: { displayName: 'Carol' } },
    { _id: ObjectId(), id: 'cfg_d', agent: { displayName: 'Dave' } },
    { _id: ObjectId(), id: 'cfg_e', agent: { displayName: 'Eve' } },
    { _id: ObjectId(), id: 'cfg_f', agent: { displayName: 'Frank' } },
    { _id: ObjectId(), id: 'cfg_g', agent: { displayName: 'Grace' } },
    // 3 docs WITHOUT the `agent` field at all — the sparse rows.
    { _id: ObjectId(), id: 'cfg_h' },
    { _id: ObjectId(), id: 'cfg_i' },
    { _id: ObjectId(), id: 'cfg_j' },
  ]);
}

// `product_catalog` is the filter-operator regression harness — Gap 4.
// Distinct prefixes/suffixes/substrings + special-character payloads so the
// test matrix can pin every documented Cube filter operator:
// `contains`, `notContains`, `startsWith`, `notStartsWith`, `endsWith`,
// `notEndsWith`, `equals` (multi-value), plus empty-result and special-char
// (`%`, `_`, regex-meta) variants. The data is small and stable so the test
// suite can pin EXACT row counts.
//
// Naming convention:
//   - `Widget-A1` / `Widget-B2` / `Widget-C3` — three classic items.
//   - `Gadget X` / `Gadget Y` — distinct prefix (`Gadget `).
//   - `Special_With_Underscore` — contains a literal `_` that must NOT be
//     treated as the SQL LIKE single-char wildcard. The driver/dialect MUST
//     emit the pattern with the underscore escaped (or with no LIKE wildcard
//     semantics) for this to match the literal value.
//   - `Special%With%Percent` — contains a literal `%` (multi-char wildcard).
//   - `Special.Regex+Meta*` — regex-shaped metachars that have NO meaning
//     in SQL LIKE but DO in MongoDB regex. We assert they round-trip as
//     LIKE-literals (not as a regex), bypassing any accidental regex
//     interpretation.
if (db.product_catalog.countDocuments() === 0) {
  db.product_catalog.insertMany([
    { _id: ObjectId(), id: 'p1', name: 'Widget-A1',                category: 'tools' },
    { _id: ObjectId(), id: 'p2', name: 'Widget-B2',                category: 'tools' },
    { _id: ObjectId(), id: 'p3', name: 'Widget-C3',                category: 'tools' },
    { _id: ObjectId(), id: 'p4', name: 'Gadget X',                 category: 'gadgets' },
    { _id: ObjectId(), id: 'p5', name: 'Gadget Y',                 category: 'gadgets' },
    { _id: ObjectId(), id: 'p6', name: 'Special_With_Underscore',  category: 'specials' },
    { _id: ObjectId(), id: 'p7', name: 'Special%With%Percent',     category: 'specials' },
    { _id: ObjectId(), id: 'p8', name: 'Special.Regex+Meta*',      category: 'specials' },
  ]);
}

// `weird_types` is the BSON-type matrix harness — Gap 10. Mongo's BSON
// vocabulary is broader than the few types our other collections exercise
// (Decimal128, ObjectId-as-string, String, Date, Int). This collection
// adds:
//   - Long (Int64) — BSON code 0x12; mongosql exposes as LONG.
//   - Binary (subtype 0x00 generic) — BSON code 0x05; mongosql exposes
//     as BINDATA. We project it via `CAST(... AS STRING)` to round-trip
//     a hex digest; raw BINDATA is intentionally NOT a Cube generic type.
//   - UUID (BSON Binary subtype 0x04) — same envelope as Binary but
//     mongosql treats subtype 4 as a UUID column; tests pin the round-trip
//     through the `tablesSchema()` snapshot.
//   - Timestamp (BSON code 0x11, NOT Date) — replication/internal type.
//     Pinned distinct from `Date` so any future BSON-type widening that
//     conflates the two surfaces as a test break.
//   - Nested document — projected as the empty-string envelope; tests
//     verify a single nested-field path round-trips through Cube.
//   - Embedded array of primitives — projected scalar via [position] /
//     subscript syntax (mongosql accepts `arr[0]` for the head element).
//
// All five seeded rows have the SAME shape — no sparse fields. The
// distinct selling point of this collection (vs. configs) is the BSON
// **type** matrix, not the sparsity.
//
// Pinned values per row:
//   row 1: id_long=1, hex=DEADBEEF, uuid=00112233-4455-6677-8899-aabbccddeeff,
//          ts has ordinal=1, nested.label='alpha', tags=['a','b','c']
//   row 2: id_long=2, hex=CAFEBABE, uuid=11223344-5566-7788-99aa-bbccddeeff00,
//          ts has ordinal=2, nested.label='beta',  tags=['d','e']
//   row 3: id_long=3, hex=FEEDFACE, uuid=22334455-6677-8899-aabb-ccddeeff0011,
//          ts has ordinal=3, nested.label='gamma', tags=['f']
//   row 4: id_long=4, hex=00000000, uuid=33445566-7788-99aa-bbcc-ddeeff001122,
//          ts has ordinal=4, nested.label='delta', tags=['g','h','i','j']
//   row 5: id_long=5, hex=FFFFFFFF, uuid=44556677-8899-aabb-ccdd-eeff00112233,
//          ts has ordinal=5, nested.label='epsilon', tags=[]
if (db.weird_types.countDocuments() === 0) {
  // mongosh exposes `BinData(subtype, base64)`; subtype 0x00 is generic
  // and 0x04 is UUID. Hex `DEADBEEF` is base64 `3q2+7w==`; `CAFEBABE`
  // is `yv66vg==`; `FEEDFACE` is `/u36zg==`; `00000000` is `AAAAAA==`;
  // `FFFFFFFF` is `/////w==`. UUIDs use mongosh's `UUID('...')` builder
  // (subtype 4 with the canonical 16-byte big-endian encoding).
  db.weird_types.insertMany([
    {
      _id: ObjectId(),
      id: 'wt1',
      id_long: NumberLong('1'),
      // Binary subtype 0 (generic). The integration tests pin the
      // round-trip via `HEX(bin)` to make the comparison stable on the
      // wire (BSON Binary → SQL STRING needs explicit cast).
      bin: BinData(0, '3q2+7w=='),
      uuid: UUID('00112233-4455-6677-8899-aabbccddeeff'),
      // BSON Timestamp (NOT a Date). `Timestamp(seconds, ordinal)` is the
      // mongosh constructor; the integration tests cast it via mongosql's
      // documented `TIMESTAMP` extractor (mongosql treats BSON Timestamp
      // separately from `Date`, surfacing it as the `TIMESTAMP` SQL type).
      ts: Timestamp(1735689600, 1),
      occurred_at: new Date('2026-01-01T00:00:00Z'),
      nested: { label: 'alpha', count: NumberInt(10) },
      tags: ['a', 'b', 'c'],
    },
    {
      _id: ObjectId(),
      id: 'wt2',
      id_long: NumberLong('2'),
      bin: BinData(0, 'yv66vg=='),
      uuid: UUID('11223344-5566-7788-99aa-bbccddeeff00'),
      ts: Timestamp(1735776000, 2),
      occurred_at: new Date('2026-01-02T00:00:00Z'),
      nested: { label: 'beta', count: NumberInt(20) },
      tags: ['d', 'e'],
    },
    {
      _id: ObjectId(),
      id: 'wt3',
      id_long: NumberLong('3'),
      bin: BinData(0, '/u36zg=='),
      uuid: UUID('22334455-6677-8899-aabb-ccddeeff0011'),
      ts: Timestamp(1735862400, 3),
      occurred_at: new Date('2026-01-03T00:00:00Z'),
      nested: { label: 'gamma', count: NumberInt(30) },
      tags: ['f'],
    },
    {
      _id: ObjectId(),
      id: 'wt4',
      id_long: NumberLong('4'),
      bin: BinData(0, 'AAAAAA=='),
      uuid: UUID('33445566-7788-99aa-bbcc-ddeeff001122'),
      ts: Timestamp(1735948800, 4),
      occurred_at: new Date('2026-01-04T00:00:00Z'),
      nested: { label: 'delta', count: NumberInt(40) },
      tags: ['g', 'h', 'i', 'j'],
    },
    {
      _id: ObjectId(),
      id: 'wt5',
      id_long: NumberLong('5'),
      bin: BinData(0, '/////w=='),
      uuid: UUID('44556677-8899-aabb-ccdd-eeff00112233'),
      ts: Timestamp(1736035200, 5),
      occurred_at: new Date('2026-01-05T00:00:00Z'),
      nested: { label: 'epsilon', count: NumberInt(50) },
      tags: [],
    },
  ]);
}

// `granular_events` is the time-granularity matrix harness — Gap 6.
// Distinct timestamps placed across the granularity axis so a single
// query like `DATETRUNC(<unit>, ts) GROUP BY <unit>` produces a known,
// pinnable bucket count for every supported granularity. The values
// span:
//   * second / minute / hour / day — three distinct days in the same
//     month, with two events on day 1 sharing a minute (so minute-grouped
//     count is one bucket smaller than second-grouped) and two events on
//     day 2 sharing an hour (so hour-grouped count is one bucket smaller
//     than minute-grouped).
//   * week — spans two weeks (Sunday-rolled) across the same month.
//   * month / quarter — spans Jan/Feb 2026 (Q1) plus one row in Q2.
//   * year — spans 2025/2026 (one 2025 row at the end so year-grouped
//     count is 2).
//
// Total: 12 rows. Pinned bucket counts per granularity (asserted in the
// cube-e2e test):
//   second:  11 (two events share the same second on 2026-01-05 08:00)
//   minute:  11 (no two distinct events share a minute beyond the second
//                pair already collapsed above)
//   hour:     9 (also collapses 08:00+08:30 on day1 + 14:00+14:30 on day2)
//   day:      8 (collapses ge_02/03/04 on 2026-01-05, ge_05/06 on
//                2026-02-10, ge_10/11 on 2026-04-09)
//   week:     7 (Sunday-start: 2025-12-28, 2026-01-04, 2026-02-08,
//                2026-02-15, 2026-03-01, 2026-04-05, 2026-04-12)
//   month:    5 (2025-12, 2026-01, 2026-02, 2026-03, 2026-04)
//   quarter:  3 (Q4-2025, Q1-2026, Q2-2026)
//   year:     2 (2025, 2026)
//
// Document the exact times so the assertions are reviewable inline:
//   2025-12-30T00:00:00Z  (year=2025, Q4-2025)
//   2026-01-05T08:00:00.000Z  ┐
//   2026-01-05T08:00:00.000Z  │ same SECOND on day1 → collapse @ second
//   2026-01-05T08:30:00.000Z  ┘ same MINUTE on day1
//   2026-02-10T14:00:00.000Z  ┐
//   2026-02-10T14:30:00.000Z  ┘ same HOUR on day2
//   2026-02-15T10:00:00.000Z  separate week from feb-10
//   2026-03-07T16:20:00.000Z  Q1-2026, March
//   2026-04-08T09:00:00.000Z  Q2-2026
//   2026-04-09T09:00:00.000Z  Q2-2026 (separate day)
//   2026-04-09T10:00:00.000Z  same DAY as above; separate HOUR
//   2026-04-12T00:00:00.000Z  new week (Sunday boundary)
if (db.granular_events.countDocuments() === 0) {
  db.granular_events.insertMany([
    { _id: ObjectId(), id: 'ge_01', occurred_at: new Date('2025-12-30T00:00:00.000Z') },
    { _id: ObjectId(), id: 'ge_02', occurred_at: new Date('2026-01-05T08:00:00.000Z') },
    { _id: ObjectId(), id: 'ge_03', occurred_at: new Date('2026-01-05T08:00:00.000Z') },
    { _id: ObjectId(), id: 'ge_04', occurred_at: new Date('2026-01-05T08:30:00.000Z') },
    { _id: ObjectId(), id: 'ge_05', occurred_at: new Date('2026-02-10T14:00:00.000Z') },
    { _id: ObjectId(), id: 'ge_06', occurred_at: new Date('2026-02-10T14:30:00.000Z') },
    { _id: ObjectId(), id: 'ge_07', occurred_at: new Date('2026-02-15T10:00:00.000Z') },
    { _id: ObjectId(), id: 'ge_08', occurred_at: new Date('2026-03-07T16:20:00.000Z') },
    { _id: ObjectId(), id: 'ge_09', occurred_at: new Date('2026-04-08T09:00:00.000Z') },
    { _id: ObjectId(), id: 'ge_10', occurred_at: new Date('2026-04-09T09:00:00.000Z') },
    { _id: ObjectId(), id: 'ge_11', occurred_at: new Date('2026-04-09T10:00:00.000Z') },
    { _id: ObjectId(), id: 'ge_12', occurred_at: new Date('2026-04-12T00:00:00.000Z') },
  ]);
}

// `tz_events` is the timezone-boundary harness — Gap 7.
// Each event is placed so its UTC bucket differs from its non-UTC bucket
// for at least one granularity. The first event is `2026-01-01T03:00:00Z`
// which is:
//   - UTC: 2026-01-01 03:00
//   - IST (UTC+5:30): 2026-01-01 08:30
//   - EST (UTC-5):    2025-12-31 22:00
// So a day-grouped query at UTC vs EST puts this row in a different bucket.
//
// Three events total — one near the day boundary, one mid-day, one near
// end of day. Sufficient to pin the TZ-offset shift at day granularity.
if (db.tz_events.countDocuments() === 0) {
  db.tz_events.insertMany([
    { _id: ObjectId(), id: 'tz_01', occurred_at: new Date('2026-01-01T03:00:00.000Z') },
    { _id: ObjectId(), id: 'tz_02', occurred_at: new Date('2026-01-01T12:00:00.000Z') },
    { _id: ObjectId(), id: 'tz_03', occurred_at: new Date('2026-01-01T20:00:00.000Z') },
  ]);
}

// `driver_tests_shared` — Gap 11. Mirrors the 4-row canned fixture
// shape from Cube's `@cubejs-backend/testing-shared.DriverTests.QUERY`:
// `(id_num INT, id_str STRING, last_mod TIMESTAMP, name STRING)`.
// Cube's testing-shared issues this exact query against every driver
// to pin: read happens at all, types come back in the expected
// generic-Cube shape, no transparent type coercion drops information.
// We reproduce the contract here as a collection (vs the upstream
// UNION-ALL-of-literals) because mongosql doesn't accept the upstream
// literal-only form. Same 4 rows, same semantic check.
if (db.driver_tests_shared.countDocuments() === 0) {
  db.driver_tests_shared.insertMany([
    { _id: ObjectId(), id_num: NumberInt(1), id_str: 'one',   last_mod: new Date('2024-01-01T00:00:00Z'), name: 'a' },
    { _id: ObjectId(), id_num: NumberInt(2), id_str: 'two',   last_mod: new Date('2024-02-01T00:00:00Z'), name: 'b' },
    { _id: ObjectId(), id_num: NumberInt(3), id_str: 'three', last_mod: new Date('2024-03-01T00:00:00Z'), name: 'c' },
    { _id: ObjectId(), id_num: NumberInt(4), id_str: 'four',  last_mod: new Date('2024-04-01T00:00:00Z'), name: 'd' },
  ]);
}

print('seed-data: collections seeded');
