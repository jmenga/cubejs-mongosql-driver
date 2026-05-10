// Seed sample collections used by the local-dev cube model.
// Mirrors tests/integration/fixtures/seed-data.js so the model in
// cube/model/orders.js works against the same shapes our integration
// tests pin. Idempotent — re-runs do nothing harmful.

const db = db.getSiblingDB('mongosql_localdev');

if (db.users.countDocuments() === 0) {
  db.users.insertMany([
    {
      _id: ObjectId(),
      email: 'alice@example.com',
      name: 'Alice',
      account_id: 'acct_a',
      created_at: new Date('2026-01-15T10:00:00Z'),
    },
    {
      _id: ObjectId(),
      email: 'bob@example.com',
      name: 'Bob',
      account_id: 'acct_a',
      created_at: new Date('2026-02-03T14:30:00Z'),
    },
    {
      _id: ObjectId(),
      email: 'carol@example.com',
      name: 'Carol',
      account_id: 'acct_b',
      created_at: new Date('2026-03-22T09:15:00Z'),
    },
    {
      _id: ObjectId(),
      email: 'dave@example.com',
      name: 'Dave',
      account_id: 'acct_b',
      created_at: new Date('2026-04-08T16:45:00Z'),
    },
  ]);
}

if (db.accounts.countDocuments() === 0) {
  db.accounts.insertMany([
    { _id: 'acct_a', name: 'Acme Corp', tier: 'enterprise', created_at: new Date('2025-06-01T00:00:00Z') },
    { _id: 'acct_b', name: 'Beta Inc', tier: 'standard', created_at: new Date('2025-09-12T00:00:00Z') },
  ]);
}

if (db.orders.countDocuments() === 0) {
  db.orders.insertMany([
    {
      _id: ObjectId(),
      account_id: 'acct_a',
      amount: NumberDecimal('150.00'),
      status: 'paid',
      created_at: new Date('2026-04-01T10:00:00Z'),
      updated_at: new Date('2026-04-01T10:00:00Z'),
    },
    {
      _id: ObjectId(),
      account_id: 'acct_a',
      amount: NumberDecimal('200.50'),
      status: 'paid',
      created_at: new Date('2026-04-02T11:00:00Z'),
      updated_at: new Date('2026-04-02T11:00:00Z'),
    },
    {
      _id: ObjectId(),
      account_id: 'acct_b',
      amount: NumberDecimal('99.99'),
      status: 'pending',
      created_at: new Date('2026-04-03T12:00:00Z'),
      updated_at: new Date('2026-04-03T12:00:00Z'),
    },
    {
      _id: ObjectId(),
      account_id: 'acct_b',
      amount: NumberDecimal('320.00'),
      status: 'paid',
      created_at: new Date('2026-04-04T13:00:00Z'),
      updated_at: new Date('2026-04-04T13:00:00Z'),
    },
    {
      _id: ObjectId(),
      account_id: 'acct_a',
      amount: NumberDecimal('75.25'),
      status: 'refunded',
      created_at: new Date('2026-04-05T14:00:00Z'),
      updated_at: new Date('2026-04-05T14:00:00Z'),
    },
  ]);
}

print('seed-data: mongosql_localdev seeded');
