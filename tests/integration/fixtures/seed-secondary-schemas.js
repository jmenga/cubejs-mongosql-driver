// Seed `__sql_schemas` for the secondary database
// (`mongosql_test_secondary`). Pairs with `seed-secondary-data.js`.
//
// The driver's `tablesSchema()` scans `__sql_schemas` in the database
// it's connected to — so the secondary DB needs its own schema entries
// (the primary's `mongosql_test.__sql_schemas` is NOT shared).

const db2 = db.getSiblingDB('mongosql_test_secondary');

const schemas = [
  {
    _id: 'orders_secondary',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'objectId' },
          account_id: { bsonType: 'string' },
          amount: { bsonType: 'decimal' },
          status: { bsonType: 'string' },
          created_at: { bsonType: 'date' },
        },
      },
    },
  },
];

const schemaColl = db2.getCollection('__sql_schemas');
for (const schema of schemas) {
  schemaColl.replaceOne({ _id: schema._id }, schema, { upsert: true });
}

print(
  `seed-secondary-schemas: mongosql_test_secondary.__sql_schemas now contains ${schemaColl.countDocuments()} documents`,
);
