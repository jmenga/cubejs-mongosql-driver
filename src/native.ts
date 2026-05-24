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

interface NativeAbortHandle {
  abort(): void;
  aborted(): boolean;
}

interface NativeMongoSqlClient {
  testConnection(signal?: NativeAbortHandle | null): Promise<void>;
  query(sql: string, signal?: NativeAbortHandle | null): Promise<unknown>;
  tablesSchema(signal?: NativeAbortHandle | null): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Authoritative `(name, type)` column descriptor produced by the native
 * layer from `mongosql::Translation::{select_order, result_set_schema}`.
 * Used by `downloadQueryResults` to drive Cube Store's LOAD ROWS column
 * list, replacing the old value-sniffing heuristic.
 */
export interface ColumnType {
  name: string;
  /** Cube generic-type string: `timestamp` | `int` | `bigint` | `decimal` | `boolean` | `string` | `text`. */
  type: string;
}

/** Shape returned by the native `query()` napi binding. */
export interface NativeQueryResult {
  rows: unknown[];
  types: ColumnType[];
}

interface NativeModule {
  MongoSqlClient: new (config: MongoSqlConfig) => NativeMongoSqlClient;
  // Optional in the typed surface so test mocks that only stub
  // MongoSqlClient stay valid; runtime usage requires a non-null value
  // when callers supply an AbortSignal — guarded inside `runCancellable`.
  AbortHandle?: new () => NativeAbortHandle;
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
 *
 * **Cancellation contract.** Each cancellable method takes an optional
 * `AbortSignal`. Internally we lazily allocate a native `AbortHandle` and
 * wire `signal.addEventListener('abort', () => handle.abort())`. The
 * native side races the work future against the handle's
 * `CancelToken::cancelled()` future and rejects with
 * `MONGOSQL_CANCELLED` if it fires first. Pre-aborted signals are
 * special-cased so they reject immediately without crossing the napi
 * boundary at all.
 *
 * napi-rs 2.16's first-class `AbortSignal` only integrates with
 * `AsyncTask` (libuv async-work pattern), not `#[napi] async fn`. The
 * Rust side therefore exposes its own opaque `AbortHandle` class
 * (`crates/native/src/cancel.rs`) and we bridge here.
 */
export class MongoSqlClient {
  private readonly inner: NativeMongoSqlClient;
  private readonly nativeAbortHandleCtor: (new () => NativeAbortHandle) | undefined;

  constructor(config: MongoSqlConfig) {
    const native = loadNative();
    this.nativeAbortHandleCtor = native.AbortHandle;
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

  async testConnection(signal?: AbortSignal): Promise<void> {
    return this.runCancellable(signal, (handle) => this.inner.testConnection(handle));
  }

  async query<R = Record<string, unknown>>(sql: string, signal?: AbortSignal): Promise<R[]> {
    // `query()` keeps its historical `R[]` signature for ergonomic
    // consumption — pre-aggregation paths that need the type list call
    // `queryWithTypes` instead and pay the extra unwrap.
    const { rows } = await this.queryWithTypes(sql, signal);
    return rows as R[];
  }

  /**
   * Like `query()` but returns the authoritative `(name, type)` list
   * alongside the rows. Used by `downloadQueryResults` to drive Cube
   * Store's column-list payload; replaces the value-sniffed inference
   * the driver used pre-fix.
   *
   * The shape mirrors the native binding exactly:
   *   `{ rows: R[], types: Array<{name, type}> }`.
   * `types` is empty when (and only when) `mongosql::select_order` is
   * empty — a degenerate case in practice but possible if upstream
   * doesn't parse a projection list.
   */
  async queryWithTypes<R = Record<string, unknown>>(
    sql: string,
    signal?: AbortSignal,
  ): Promise<{ rows: R[]; types: ColumnType[] }> {
    const result = await this.runCancellable(signal, (handle) => this.inner.query(sql, handle));
    if (!isQueryResult(result)) {
      throw createError(
        'MONGOSQL_EXECUTE_FAILED',
        `expected query result to be an object with rows + types arrays, got ${describe(result)}`,
      );
    }
    return { rows: result.rows as R[], types: result.types };
  }

  async tablesSchema(signal?: AbortSignal): Promise<TablesSchema> {
    const result = await this.runCancellable(signal, (handle) => this.inner.tablesSchema(handle));
    return result as TablesSchema;
  }

  async close(): Promise<void> {
    return wrapErrors(() => this.inner.close());
  }

  /**
   * Bridge a JS `AbortSignal` to a native `AbortHandle` for the duration
   * of one call. If `signal` is undefined, the call runs un-cancelled
   * (the native side still wires the parent close-token, so `close()`
   * can still cancel it). If `signal` is already aborted, we throw
   * `MONGOSQL_CANCELLED` synchronously without invoking the native side.
   */
  private async runCancellable<T>(
    signal: AbortSignal | undefined,
    op: (handle: NativeAbortHandle | null) => Promise<T>,
  ): Promise<T> {
    if (signal === undefined) {
      return wrapErrors(() => op(null));
    }
    if (signal.aborted) {
      // Pre-aborted: skip the napi round-trip entirely. Mirror the
      // wire-format of MONGOSQL_CANCELLED that the Rust side produces
      // so callers see one consistent error shape.
      throw createError('MONGOSQL_CANCELLED', 'signal was aborted before call');
    }
    if (!this.nativeAbortHandleCtor) {
      // Defensive: production builds always export AbortHandle; this
      // branch only fires under test mocks that didn't stub it. Run
      // un-cancellable rather than crashing — the caller still gets
      // their result.
      return wrapErrors(() => op(null));
    }
    const handle = new this.nativeAbortHandleCtor();
    const onAbort = (): void => handle.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await wrapErrors(() => op(handle));
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
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

function isQueryResult(value: unknown): value is NativeQueryResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.rows)) return false;
  if (!Array.isArray(v.types)) return false;
  for (const t of v.types) {
    if (typeof t !== 'object' || t === null) return false;
    const ct = t as Record<string, unknown>;
    if (typeof ct.name !== 'string' || typeof ct.type !== 'string') return false;
  }
  return true;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
