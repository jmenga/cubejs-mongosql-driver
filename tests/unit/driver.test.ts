/**
 * Failing tests for MongoSqlDriver. Pin the contract — implementation arrives in T11.
 * Run: pnpm test:unit driver
 */
import { describe, it, expect } from 'vitest';
import { MongoSqlDriver, MongoSqlQuery } from '../../src/index.js';

describe('MongoSqlDriver', () => {
  it('exposes MongoSqlQuery as its dialectClass', () => {
    expect(MongoSqlDriver.dialectClass()).toBe(MongoSqlQuery);
  });

  it.todo('parses config from CUBEJS_DB_URI / CUBEJS_DB_NAME env (T11)');
  it.todo('throws MONGOSQL_CONFIG_INVALID when required config is missing (T11)');
  it.todo('testConnection() loads schema and starts refresh task (T11)');
  it.todo('query() propagates MONGOSQL_TRANSLATE_FAILED with code field (T11)');
  it.todo('query() propagates MONGOSQL_EXECUTE_FAILED with code field (T11)');
  it.todo('release() closes the underlying client (T11)');
  it.todo('tablesSchema() returns Cube-shaped table-introspection (T11)');
});
