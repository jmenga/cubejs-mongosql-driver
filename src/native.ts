/**
 * Type-safe wrapper around the napi-rs `.node` module.
 *
 * Native errors carry the SPEC §6 code prefixed in the message, e.g.
 * `"MONGOSQL_CONFIG_INVALID: ..."`. This wrapper parses that prefix and
 * rethrows as `MongoSqlError` with `code`/`name` set. Errors without a
 * recognised prefix are passed through unchanged.
 */

import type { MongoSqlConfig, ErrorCode, MongoSqlError } from './types.js';
import { ERROR_CODES } from './types.js';

interface NativeMongoSqlClient {
  testConnection(): Promise<void>;
  query(sql: string): Promise<unknown>;
  tablesSchema(): Promise<unknown>;
  close(): Promise<void>;
}

interface NativeModule {
  MongoSqlClient: new (config: MongoSqlConfig) => NativeMongoSqlClient;
}

/** Column descriptor returned by `tablesSchema()`. Mirrors the Rust shape. */
export interface ColumnInfo {
  name: string;
  type: string;
  attributes: string[];
}

/** `tablesSchema()` shape: `{ <db>: { <coll>: ColumnInfo[] } }`. */
export type TablesSchema = Record<string, Record<string, ColumnInfo[]>>;

let nativeModule: NativeModule | undefined;

function loadNative(): NativeModule {
  if (nativeModule) return nativeModule;
  // napi-rs's `index.js` lives at project root. From `src/native.ts` (vitest)
  // it's `../index.js`; from `dist/src/native.js` (built consumer) it's
  // `../../index.js`. Try both.
  try {
    nativeModule = require('../index.js') as NativeModule;
  } catch {
    nativeModule = require('../../index.js') as NativeModule;
  }
  return nativeModule;
}

/** Test hook: reset the cached native-module reference. */
export function _resetNativeModuleForTests(): void {
  nativeModule = undefined;
}

/** Test hook: inject a mock native module. */
export function _setNativeModuleForTests(mod: NativeModule): void {
  nativeModule = mod;
}

/**
 * Type-safe TypeScript wrapper around the napi-rs `MongoSqlClient`.
 * One-to-one method mapping; errors are normalised into `MongoSqlError`.
 */
export class MongoSqlClient {
  private readonly inner: NativeMongoSqlClient;

  constructor(config: MongoSqlConfig) {
    const native = loadNative();
    this.inner = new native.MongoSqlClient({
      uri: config.uri,
      database: config.database,
      schemaSource: config.schemaSource,
      schemaRefreshSec: config.schemaRefreshSec,
      schemaFailOpen: config.schemaFailOpen,
      queryTimeoutMs: config.queryTimeoutMs,
      maxRows: config.maxRows,
    });
  }

  async testConnection(): Promise<void> {
    return wrapErrors(() => this.inner.testConnection());
  }

  async query<R = Record<string, unknown>>(sql: string): Promise<R[]> {
    const result = await wrapErrors(() => this.inner.query(sql));
    if (!Array.isArray(result)) {
      throw createError(
        'MONGOSQL_EXECUTE_FAILED',
        `expected query result to be an array, got ${typeof result}`,
      );
    }
    return result as R[];
  }

  async tablesSchema(): Promise<TablesSchema> {
    const result = await wrapErrors(() => this.inner.tablesSchema());
    return result as TablesSchema;
  }

  async close(): Promise<void> {
    return wrapErrors(() => this.inner.close());
  }
}

const ERROR_CODE_RE = /^(MONGOSQL_[A-Z_]+):\s*(.*)$/s;

async function wrapErrors<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof Error) {
      const match = ERROR_CODE_RE.exec(err.message);
      if (match) {
        const [, code, message] = match;
        if ((ERROR_CODES as readonly string[]).includes(code)) {
          throw createError(code as ErrorCode, message);
        }
      }
    }
    throw err;
  }
}

function createError(code: ErrorCode, message: string): MongoSqlError {
  const err = new Error(message) as MongoSqlError;
  err.code = code;
  err.name = 'MongoSqlError';
  return err;
}
