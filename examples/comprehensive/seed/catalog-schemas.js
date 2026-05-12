// Seed __sql_schemas for the `shop_catalog` database.

const db = db.getSiblingDB('shop_catalog');
const schemaColl = db.getCollection('__sql_schemas');

const schemas = [
  {
    _id: 'categories',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'string' },
          name: { bsonType: 'string' },
          parent_id: { bsonType: 'string' },
        },
      },
    },
  },
  {
    _id: 'products',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'string' },
          name: { bsonType: 'string' },
          category_id: { bsonType: 'string' },
          supplier: { bsonType: 'string' },
          list_price: { bsonType: 'decimal' },
        },
      },
    },
  },
  {
    _id: 'inventory_snapshots',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'objectId' },
          product_id: { bsonType: 'string' },
          warehouse: { bsonType: 'string' },
          snapshot_date: { bsonType: 'date' },
          qty_on_hand: { bsonType: 'int' },
        },
      },
    },
  },
];

for (const s of schemas) {
  schemaColl.replaceOne({ _id: s._id }, s, { upsert: true });
}
print(`catalog-schemas: __sql_schemas now has ${schemaColl.countDocuments()} documents`);
