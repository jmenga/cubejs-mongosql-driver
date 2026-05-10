/**
 * Type-safe wrapper around the napi-rs `.node` module.
 * Implementation arrives in T10. For now, throws Unimplemented.
 */
import type { MongoSqlConfig } from './types.js';

export class MongoSqlClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: MongoSqlConfig) {
    throw new Error('not implemented (T10)');
  }

  testConnection(): Promise<void> {
    throw new Error('not implemented (T10)');
  }

  query<R>(_sql: string): Promise<R[]> {
    throw new Error('not implemented (T10)');
  }

  tablesSchema(): Promise<unknown> {
    throw new Error('not implemented (T10)');
  }

  close(): Promise<void> {
    throw new Error('not implemented (T10)');
  }
}
