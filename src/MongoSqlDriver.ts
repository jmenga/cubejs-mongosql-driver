/**
 * MongoSqlDriver — Cube data source driver for MongoDB via MongoSQL.
 * See SPEC.md FR-1 and ARCHITECTURE.md §2.1.
 *
 * Implementation arrives in T11. For now, throws Unimplemented from each method
 * to satisfy the failing-test phase of TDD.
 */
import { MongoSqlClient } from './native.js';
import { MongoSqlQuery } from './MongoSqlQuery.js';
import type { MongoSqlConfig } from './types.js';

/**
 * Cube driver class. Cube instantiates this when CUBEJS_DB_TYPE=mongosql.
 *
 * Note: this stub doesn't extend `@cubejs-backend/base-driver`'s BaseDriver
 * yet — that wiring is T11. Keeping this loosely typed here to unblock T01 → T10
 * without pulling the Cube dep into the type-check step.
 */
export class MongoSqlDriver {
  private readonly client: MongoSqlClient;

  constructor(config?: MongoSqlConfig) {
    this.client = new MongoSqlClient(config ?? this.configFromEnv());
  }

  private configFromEnv(): MongoSqlConfig {
    throw new Error('not implemented (T11)');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  query<R = unknown>(_sql: string, _values?: unknown[]): Promise<R[]> {
    throw new Error('not implemented (T11)');
  }

  testConnection(): Promise<void> {
    throw new Error('not implemented (T11)');
  }

  tablesSchema(): Promise<unknown> {
    throw new Error('not implemented (T11)');
  }

  release(): Promise<void> {
    return this.client.close();
  }

  static dialectClass(): typeof MongoSqlQuery {
    return MongoSqlQuery;
  }
}
