// Seed __sql_schemas for the `shop_sales` database. Mirrors what the Atlas
// SQL Interface sampler would write; the driver reads this in collection
// mode to translate SQL → MQL.
//
// The nested `shipping_address` document IS declared (object → properties)
// so SELECT shipping_address.country works at the SQL level — but the Cube
// model in cube/model/orders.js uses the flat `shipping_country` field to
// keep the dialect's autoPrefixWithCubeName override clean.

const db = db.getSiblingDB('shop_sales');
const schemaColl = db.getCollection('__sql_schemas');

const schemas = [
  {
    _id: 'customers',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'string' },
          name: { bsonType: 'string' },
          email: { bsonType: 'string' },
          tier: { bsonType: 'string' },
          country: { bsonType: 'string' },
          signup_date: { bsonType: 'date' },
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
          _id: { bsonType: 'objectId' },
          customer_id: { bsonType: 'string' },
          status: { bsonType: 'string' },
          amount: { bsonType: 'decimal' },
          currency: { bsonType: 'string' },
          created_at: { bsonType: 'date' },
          shipping_country: { bsonType: 'string' },
          shipping_address: {
            bsonType: 'object',
            properties: {
              city: { bsonType: 'string' },
              country: { bsonType: 'string' },
              postal_code: { bsonType: 'string' },
            },
          },
          tags: {
            bsonType: 'array',
            items: { bsonType: 'string' },
          },
        },
      },
    },
  },
  {
    _id: 'order_items',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'objectId' },
          order_id: { bsonType: 'objectId' },
          product_id: { bsonType: 'string' },
          qty: { bsonType: 'int' },
          price: { bsonType: 'decimal' },
          subtotal: { bsonType: 'decimal' },
        },
      },
    },
  },
  {
    _id: 'payments',
    schema: {
      version: NumberLong(1),
      jsonSchema: {
        bsonType: 'object',
        properties: {
          _id: { bsonType: 'objectId' },
          order_id: { bsonType: 'objectId' },
          amount: { bsonType: 'decimal' },
          method: { bsonType: 'string' },
          captured_at: { bsonType: 'date' },
        },
      },
    },
  },
];

for (const s of schemas) {
  schemaColl.replaceOne({ _id: s._id }, s, { upsert: true });
}
print(`sales-schemas: __sql_schemas now has ${schemaColl.countDocuments()} documents`);
