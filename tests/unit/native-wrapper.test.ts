/**
 * Unit tests for the native binding wrapper.
 *
 * The real `.node` module is mocked via Vitest's module-injection hook
 * (`_setNativeModuleForTests`) so this suite runs without a built binary.
 * Coverage:
 *   - constructor passes config through
 *   - error code prefix is parsed and rethrown as MongoSqlError
 *   - errors without a recognised code prefix are passed through unchanged
 *   - errors with an unknown MONGOSQL_* code are passed through unchanged
 *   - testConnection() resolves to void
 *   - close() is idempotent
 *   - query() with a non-array result throws MONGOSQL_EXECUTE_FAILED
 *   - tablesSchema() returns the nested object as-is
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  MongoSqlClient,
  _resetNativeModuleForTests,
  _setNativeModuleForTests,
  type ColumnInfo,
  type TablesSchema,
} from '../../src/native.js';
import type { MongoSqlError } from '../../src/types.js';

interface FakeClient {
  config: unknown;
  testConnection: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  tablesSchema: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface FakeAbortHandle {
  abort: ReturnType<typeof vi.fn>;
  aborted: ReturnType<typeof vi.fn>;
}

let lastClient: FakeClient | undefined;
let lastAbortHandle: FakeAbortHandle | undefined;

function installMockNative(overrides: Partial<FakeClient> = {}): void {
  _setNativeModuleForTests({
    MongoSqlClient: function (config: unknown): FakeClient {
      const client: FakeClient = {
        config,
        testConnection: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([]),
        tablesSchema: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      lastClient = client;
      return client;
    } as any,
    AbortHandle: function (): FakeAbortHandle {
      const h: FakeAbortHandle = {
        abort: vi.fn(),
        aborted: vi.fn().mockReturnValue(false),
      };
      lastAbortHandle = h;
      return h;
    } as any,
  });
}

beforeEach(() => {
  _resetNativeModuleForTests();
  lastClient = undefined;
  lastAbortHandle = undefined;
});

describe('MongoSqlClient — constructor', () => {
  it('passes config through to the native module', () => {
    installMockNative();
    new MongoSqlClient({
      uri: 'mongodb://localhost',
      database: 'test',
      schemaSource: { kind: 'collection' },
      schemaRefreshSec: 60,
      schemaFailOpen: true,
      queryTimeoutMs: 5_000,
      maxRows: 1_000,
    });
    expect(lastClient).toBeDefined();
    expect(lastClient!.config).toEqual({
      uri: 'mongodb://localhost',
      database: 'test',
      schemaSource: { kind: 'collection' },
      schemaRefreshSec: 60,
      schemaFailOpen: true,
      queryTimeoutMs: 5_000,
      maxRows: 1_000,
    });
  });

  it('does not throw on construction', () => {
    installMockNative();
    expect(() => new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' })).not.toThrow();
  });
});

describe('MongoSqlClient — error normalization', () => {
  it('parses MONGOSQL_* code prefix and throws with `code` field', async () => {
    installMockNative({
      query: vi.fn().mockRejectedValue(new Error('MONGOSQL_CONFIG_INVALID: field `uri`: must not be empty')),
    });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const err = (await c.query('SELECT 1').catch((e: unknown) => e)) as MongoSqlError;
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('MONGOSQL_CONFIG_INVALID');
    expect(err.name).toBe('MongoSqlError');
    expect(err.message).toBe('field `uri`: must not be empty');
  });

  it('preserves multi-line messages after the code prefix', async () => {
    installMockNative({
      query: vi.fn().mockRejectedValue(new Error('MONGOSQL_TRANSLATE_FAILED: line one\nline two')),
    });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const err = (await c.query('SELECT 1').catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_TRANSLATE_FAILED');
    expect(err.message).toBe('line one\nline two');
  });

  it('rethrows errors without a recognised prefix unchanged', async () => {
    const original = new Error('some unrelated runtime failure');
    installMockNative({ query: vi.fn().mockRejectedValue(original) });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const err = await c.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBe(original);
    expect((err as MongoSqlError).code).toBeUndefined();
  });

  it('does not promote unknown MONGOSQL_* codes (defensive pass-through)', async () => {
    const original = new Error('MONGOSQL_TOTALLY_BOGUS_CODE: oh no');
    installMockNative({ query: vi.fn().mockRejectedValue(original) });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const err = await c.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBe(original);
    expect((err as MongoSqlError).code).toBeUndefined();
  });

  it('rethrows non-Error rejections unchanged', async () => {
    installMockNative({ query: vi.fn().mockRejectedValue('plain string') });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const err = await c.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBe('plain string');
  });
});

describe('MongoSqlClient — testConnection', () => {
  it('propagates void on success', async () => {
    installMockNative();
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    await expect(c.testConnection()).resolves.toBeUndefined();
    expect(lastClient!.testConnection).toHaveBeenCalledOnce();
  });

  it('normalises error codes from the connection probe', async () => {
    installMockNative({
      testConnection: vi.fn().mockRejectedValue(new Error('MONGOSQL_CONNECT_FAILED: ping timed out after 10s')),
    });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const err = (await c.testConnection().catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_CONNECT_FAILED');
    expect(err.message).toContain('ping timed out');
  });
});

describe('MongoSqlClient — close', () => {
  it('is idempotent (two close()s succeed)', async () => {
    installMockNative();
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    await expect(c.close()).resolves.toBeUndefined();
    await expect(c.close()).resolves.toBeUndefined();
    expect(lastClient!.close).toHaveBeenCalledTimes(2);
  });
});

describe('MongoSqlClient — query', () => {
  it('returns array results untouched', async () => {
    const rows = [{ a: 1 }, { a: 2 }];
    installMockNative({ query: vi.fn().mockResolvedValue(rows) });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    await expect(c.query('SELECT * FROM x')).resolves.toEqual(rows);
  });

  it('throws MONGOSQL_EXECUTE_FAILED when the result is not an array', async () => {
    installMockNative({ query: vi.fn().mockResolvedValue({ not: 'an array' }) });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const err = (await c.query('SELECT 1').catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_EXECUTE_FAILED');
    expect(err.name).toBe('MongoSqlError');
    expect(err.message).toContain('expected query result to be an array');
  });

  it('forwards the SQL string to the native call', async () => {
    installMockNative();
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    await c.query('SELECT 1 FROM users');
    // Second arg is the optional AbortHandle slot; without a signal we
    // pass `null` to match the napi-rs `Option<&AbortHandle>` shape.
    expect(lastClient!.query).toHaveBeenCalledWith('SELECT 1 FROM users', null);
  });
});

describe('MongoSqlClient — cancellation (AbortSignal bridge)', () => {
  it('passes a native AbortHandle when a non-aborted signal is supplied', async () => {
    installMockNative();
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const ctrl = new AbortController();
    await c.query('SELECT 1', ctrl.signal);
    // The query() second arg is the bridged AbortHandle, not null.
    expect(lastClient!.query).toHaveBeenCalledTimes(1);
    const args = lastClient!.query.mock.calls[0];
    expect(args[0]).toBe('SELECT 1');
    expect(args[1]).toBeDefined();
    expect(args[1]).not.toBeNull();
    // It is the FakeAbortHandle the mock factory installed.
    expect(args[1]).toBe(lastAbortHandle);
  });

  it('forwards `abort()` to the native handle when the signal fires mid-call', async () => {
    // The native side returns a slow promise; we abort the controller and
    // expect the bridge to call handle.abort() before/while the promise
    // is still pending. The native impl would observe this via the
    // CancelToken; the mock just records the call.
    let resolveQuery: ((v: unknown) => void) | undefined;
    const slow = new Promise((resolve) => {
      resolveQuery = resolve;
    });
    installMockNative({ query: vi.fn().mockReturnValue(slow) });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const ctrl = new AbortController();
    const p = c.query('SELECT slow', ctrl.signal);
    // Ensure the call has crossed the bridge before we abort.
    await Promise.resolve();
    ctrl.abort();
    expect(lastAbortHandle).toBeDefined();
    expect(lastAbortHandle!.abort).toHaveBeenCalledTimes(1);
    // Tidy: resolve the slow promise so the test doesn't hang.
    resolveQuery!([]);
    await p;
  });

  it('rejects with MONGOSQL_CANCELLED if signal is already aborted (no native call)', async () => {
    installMockNative();
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const ctrl = new AbortController();
    ctrl.abort();
    const err = (await c.query('SELECT 1', ctrl.signal).catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_CANCELLED');
    expect(err.name).toBe('MongoSqlError');
    // Native side never called — pre-abort is the dispatch gate.
    expect(lastClient!.query).not.toHaveBeenCalled();
    expect(lastAbortHandle).toBeUndefined();
  });

  it('removes the abort listener on success (no listener leak)', async () => {
    installMockNative();
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const ctrl = new AbortController();
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
    await c.query('SELECT 1', ctrl.signal);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('removes the abort listener even when the native call rejects', async () => {
    installMockNative({
      query: vi.fn().mockRejectedValue(new Error('MONGOSQL_EXECUTE_FAILED: boom')),
    });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const ctrl = new AbortController();
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
    await c.query('SELECT 1', ctrl.signal).catch(() => {});
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('normalises code-prefixed errors back to MongoSqlError when cancellation races a real error', async () => {
    installMockNative({
      query: vi.fn().mockRejectedValue(new Error('MONGOSQL_CANCELLED: query')),
    });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const err = (await c.query('SELECT 1').catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_CANCELLED');
    expect(err.name).toBe('MongoSqlError');
  });

  it('passes the AbortHandle through testConnection() too', async () => {
    installMockNative();
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const ctrl = new AbortController();
    await c.testConnection(ctrl.signal);
    const args = lastClient!.testConnection.mock.calls[0];
    expect(args[0]).toBe(lastAbortHandle);
  });

  it('passes the AbortHandle through tablesSchema() too', async () => {
    installMockNative();
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'db' });
    const ctrl = new AbortController();
    await c.tablesSchema(ctrl.signal);
    const args = lastClient!.tablesSchema.mock.calls[0];
    expect(args[0]).toBe(lastAbortHandle);
  });
});

describe('MongoSqlClient — tablesSchema', () => {
  it('returns the nested object as-is', async () => {
    const cols: ColumnInfo[] = [
      { name: 'id', type: 'objectid', attributes: [] },
      { name: 'email', type: 'string', attributes: [] },
    ];
    const payload: TablesSchema = { mydb: { users: cols } };
    installMockNative({ tablesSchema: vi.fn().mockResolvedValue(payload) });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'mydb' });
    await expect(c.tablesSchema()).resolves.toEqual(payload);
  });

  it('normalises code-prefixed errors from the native side', async () => {
    installMockNative({
      tablesSchema: vi.fn().mockRejectedValue(new Error('MONGOSQL_SCHEMA_NOT_FOUND: __sql_schemas empty')),
    });
    const c = new MongoSqlClient({ uri: 'mongodb://h/db', database: 'mydb' });
    const err = (await c.tablesSchema().catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_SCHEMA_NOT_FOUND');
  });
});
