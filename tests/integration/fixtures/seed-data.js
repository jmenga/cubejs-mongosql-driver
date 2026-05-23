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

print('seed-data: collections seeded');
