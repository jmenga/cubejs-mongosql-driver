// Seed __sql_schemas with documents matching the collections seeded by seed-data.js.
// Mirrors what the Atlas SQL Interface sampler would write in production.

const db = db.getSiblingDB('mongosql_test');

const schemas = [
  {
    _id: 'users',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id:        { bsonType: 'objectId' },
          email:      { bsonType: 'string'   },
          name:       { bsonType: 'string'   },
          account_id: { bsonType: 'string'   },
          created_at: { bsonType: 'date'     },
        },
      },
    },
  },
  {
    _id: 'accounts',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id:        { bsonType: 'string'   },
          name:       { bsonType: 'string'   },
          tier:       { bsonType: 'string'   },
          created_at: { bsonType: 'date'     },
        },
      },
    },
  },
  {
    _id: 'orders',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id:        { bsonType: 'objectId' },
          account_id: { bsonType: 'string'   },
          amount:     { bsonType: 'decimal'  },
          status:     { bsonType: 'string'   },
          created_at: { bsonType: 'date'     },
          updated_at: { bsonType: 'date'     },
        },
      },
    },
  },
  // Multi-month revenue dataset used by the cube-e2e rollup-partition
  // test (Critic v3 — Issue #2). The schema mirrors `orders` but with
  // an `occurred_at` time dimension; the partitioned pre-aggregation
  // on this cube buckets monthly so a query spanning 2026-01..2026-03
  // forces Cube Store to UNION three partitions — the exact codepath
  // that broke with the old value-sniffed types.
  {
    _id: 'revenue_events',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id:         { bsonType: 'objectId' },
          account_id:  { bsonType: 'string'   },
          amount:      { bsonType: 'decimal'  },
          category:    { bsonType: 'string'   },
          occurred_at: { bsonType: 'date'     },
        },
      },
    },
  },
  // `configs` is the sparse-nested-path harness for the row-shape
  // normalization fix. `agent` is an embedded document with a
  // `displayName` field — but a subset of docs OMIT the `agent` field
  // entirely. With `SELECT id, agent.displayName ... ORDER BY
  // agent.displayName ASC`, mongosql emits no `agent_display_name`-shaped
  // key on the rows lacking the source path, and those rows sort to
  // row 0 (nulls-first). The driver's `normalizeRowShape` (TS) +
  // `downloadQueryResults` types-list null-fill (TS) keep the column
  // present on every row so Cube's first-row sniff doesn't drop it.
  {
    _id: 'configs',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'objectId' },
          id:  { bsonType: 'string'   },
          agent: {
            bsonType: 'object',
            properties: {
              displayName: { bsonType: 'string' },
            },
          },
        },
      },
    },
  },
];

// Use bracket-property access; mongosh's `db` proxy chokes on the dot-form
// for collection names that start with `_` (reads them as a missing property
// and returns `undefined`).
const schemaColl = db.getCollection('__sql_schemas');

for (const schema of schemas) {
  schemaColl.replaceOne({ _id: schema._id }, schema, { upsert: true });
}

print(`seed-schemas: __sql_schemas now contains ${schemaColl.countDocuments()} documents`);
