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
];

for (const schema of schemas) {
  db.__sql_schemas.replaceOne({ _id: schema._id }, schema, { upsert: true });
}

print(`seed-schemas: __sql_schemas now contains ${db.__sql_schemas.countDocuments()} documents`);
