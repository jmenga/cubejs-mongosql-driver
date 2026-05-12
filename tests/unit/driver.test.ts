/**
 * Tests for MongoSqlDriver — Cube data source driver.
 * Run: pnpm test:unit driver
 *
 * The native module is mocked via the dependency-injection hooks exported
 * from src/native.ts so this suite runs without a built `.node` binary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _resetNativeModuleForTests, _setNativeModuleForTests, type TablesSchema } from '../../src/native.js';
import { MongoSqlDriver, MongoSqlQuery } from '../../src/index.js';
import type { MongoSqlError } from '../../src/types.js';

interface FakeClient {
  config: unknown;
  testConnection: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  tablesSchema: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let lastClient: FakeClient | undefined;
let createdClients = 0;

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
      createdClients += 1;
      return client;
    } as any,
    AbortHandle: function (): { abort: () => void; aborted: () => boolean } {
      // Minimal stub — driver tests don't inspect the handle, only that
      // it gets passed through. Tests in native-wrapper.test.ts cover the
      // bridge wiring in detail.
      return { abort: vi.fn(), aborted: vi.fn().mockReturnValue(false) };
    } as any,
  });
}

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  _resetNativeModuleForTests();
  lastClient = undefined;
  createdClients = 0;
  // Strip any caller env so configFromEnv is deterministic.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CUBEJS_')) delete process.env[k];
  }
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe('MongoSqlDriver — static dialectClass', () => {
  it('exposes MongoSqlQuery as its dialectClass', () => {
    expect(MongoSqlDriver.dialectClass()).toBe(MongoSqlQuery);
  });
});

describe('MongoSqlDriver — constructor / config', () => {
  it('parses CUBEJS_DB_URI / CUBEJS_DB_NAME from env when no args provided', async () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    installMockNative();
    const d = new MongoSqlDriver();
    // Construction is allowed to be lazy; force client creation.
    await d.testConnection();
    expect(lastClient).toBeDefined();
    expect((lastClient!.config as { uri: string }).uri).toBe('mongodb://h/db');
    expect((lastClient!.config as { database: string }).database).toBe('analytics');
  });

  it('honours explicit constructor args over env', async () => {
    process.env.CUBEJS_DB_URI = 'mongodb://from-env/x';
    process.env.CUBEJS_DB_NAME = 'env-db';
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://explicit/y', database: 'override-db' });
    await d.testConnection();
    expect((lastClient!.config as { uri: string }).uri).toBe('mongodb://explicit/y');
    expect((lastClient!.config as { database: string }).database).toBe('override-db');
  });

  it('parses CUBEJS_MONGOSQL_* tunables from env', async () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC = '120';
    process.env.CUBEJS_MONGOSQL_SCHEMA_FAIL_OPEN = 'true';
    process.env.CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS = '15000';
    process.env.CUBEJS_MONGOSQL_MAX_ROWS = '500';
    process.env.CUBEJS_MONGOSQL_SCHEMA_SOURCE = 'collection';
    installMockNative();
    const d = new MongoSqlDriver();
    await d.testConnection();
    const cfg = lastClient!.config as Record<string, unknown>;
    expect(cfg.schemaRefreshSec).toBe(120);
    expect(cfg.schemaFailOpen).toBe(true);
    expect(cfg.queryTimeoutMs).toBe(15000);
    expect(cfg.maxRows).toBe(500);
    expect(cfg.schemaSource).toEqual({ kind: 'collection' });
  });

  it('parses file schema source from env', async () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_MONGOSQL_SCHEMA_SOURCE = 'file';
    process.env.CUBEJS_MONGOSQL_SCHEMA_FILE = '/tmp/schema.yaml';
    installMockNative();
    const d = new MongoSqlDriver();
    await d.testConnection();
    const cfg = lastClient!.config as Record<string, unknown>;
    expect(cfg.schemaSource).toEqual({ kind: 'file', path: '/tmp/schema.yaml' });
  });

  it('throws MONGOSQL_CONFIG_INVALID when uri is missing', () => {
    process.env.CUBEJS_DB_NAME = 'analytics';
    installMockNative();
    let thrown: unknown;
    try {
      new MongoSqlDriver();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as MongoSqlError).code).toBe('MONGOSQL_CONFIG_INVALID');
    expect((thrown as Error).message).toMatch(/uri/);
  });

  it('throws MONGOSQL_CONFIG_INVALID when database is missing', () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    installMockNative();
    let thrown: unknown;
    try {
      new MongoSqlDriver();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as MongoSqlError).code).toBe('MONGOSQL_CONFIG_INVALID');
    expect((thrown as Error).message).toMatch(/database/);
  });

  it('throws MONGOSQL_CONFIG_INVALID for file schema source without path', () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_MONGOSQL_SCHEMA_SOURCE = 'file';
    installMockNative();
    let thrown: unknown;
    try {
      new MongoSqlDriver();
    } catch (e) {
      thrown = e;
    }
    expect((thrown as MongoSqlError).code).toBe('MONGOSQL_CONFIG_INVALID');
    expect((thrown as Error).message).toMatch(/CUBEJS_MONGOSQL_SCHEMA_FILE/);
  });

  it('does not eagerly construct the native client (lazy testConnection)', () => {
    installMockNative();
    new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    expect(createdClients).toBe(0);
  });
});

describe('MongoSqlDriver — query() row flattening', () => {
  it('unwraps single-key envelope: [{users: {a:1}}] -> [{a:1}]', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([{ users: { a: 1, b: 'x' } }, { users: { a: 2, b: 'y' } }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT a, b FROM users');
    expect(rows).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });

  it('passes through rows that lack the envelope', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([{ a: 1 }, { a: 2 }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT a FROM users');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('handles empty result set', async () => {
    installMockNative({ query: vi.fn().mockResolvedValue([]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT * FROM users WHERE 1=0');
    expect(rows).toEqual([]);
  });

  it('merges multi-table JOIN envelope with table-prefixed keys', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([
        {
          users: { id: 'u1', email: 'a@b' },
          orders: { id: 'o1', total: 100 },
        },
      ]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT * FROM users JOIN orders');
    expect(rows).toEqual([
      {
        users__id: 'u1',
        users__email: 'a@b',
        orders__id: 'o1',
        orders__total: 100,
      },
    ]);
  });

  it('passes scalar top-level values through unchanged', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([{ count: 42 }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT COUNT(*) AS count FROM users');
    expect(rows).toEqual([{ count: 42 }]);
  });

  it('propagates code-bearing errors with their `code` field intact', async () => {
    installMockNative({
      query: vi.fn().mockRejectedValue(new Error('MONGOSQL_TRANSLATE_FAILED: bad column foo')),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const err = (await d.query('SELECT foo FROM users').catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_TRANSLATE_FAILED');
    expect(err.name).toBe('MongoSqlError');
  });

  it('propagates execution errors with their `code` field intact', async () => {
    installMockNative({
      query: vi.fn().mockRejectedValue(new Error('MONGOSQL_EXECUTE_FAILED: pipeline blew up')),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const err = (await d.query('SELECT 1 FROM users').catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_EXECUTE_FAILED');
  });

  it('rejects JOIN projections with colliding qualified column names (Critic v2 — Issue 2)', async () => {
    // mongosql emits `{"": {col: ..., col: ...}}` for explicit-projection
    // JOINs without aliases. Two columns sharing a name silently collapse
    // to one in the JS object. The driver detects the risk from the SQL
    // pre-execution and throws MONGOSQL_TRANSLATE_FAILED so callers know
    // to use `SELECT *` or aliased columns.
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const err = (await d
      .query('SELECT users.account_id, orders.account_id FROM users JOIN orders ON 1=1')
      .catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_TRANSLATE_FAILED');
    expect(err.message).toMatch(/SELECT \*/);
    expect(err.message).toMatch(/alias/i);
    // Bypassed at the SQL gate — native client never created.
    expect(createdClients).toBe(0);
  });

  it('allows JOIN projections where the colliding columns are aliased (Issue 2)', async () => {
    installMockNative({ query: vi.fn().mockResolvedValue([{ '': { u_id: 'u1', o_id: 'o1' } }]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>(
      'SELECT users.account_id AS u_id, orders.account_id AS o_id FROM users JOIN orders ON 1=1',
    );
    expect(rows).toEqual([{ u_id: 'u1', o_id: 'o1' }]);
  });

  it('allows JOIN projections with non-colliding qualified column names (Issue 2)', async () => {
    // Two qualified columns with different trailing names → no collision risk.
    installMockNative({ query: vi.fn().mockResolvedValue([{ '': { email: 'a@b', amount: '1.0' } }]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>(
      'SELECT users.email, orders.amount FROM users JOIN orders ON 1=1',
    );
    expect(rows).toEqual([{ email: 'a@b', amount: '1.0' }]);
  });

  it('allows single-table empty-string envelope queries (no JOIN, no collision risk)', async () => {
    // `SELECT col, col2 FROM users` produces a `{"": {col, col2}}` envelope
    // but cannot collide because mongosql guarantees uniqueness within a
    // single-table projection. The flatten path keeps unwrapping it.
    installMockNative({ query: vi.fn().mockResolvedValue([{ '': { email: 'a@b', name: 'A' } }]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>('SELECT email, name FROM users');
    expect(rows).toEqual([{ email: 'a@b', name: 'A' }]);
  });

  it('regression: non-empty single-key envelope still unwraps cleanly', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([{ users: { id: 'u1', email: 'a@b' } }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<{ id: string; email: string }>('SELECT * FROM users');
    expect(rows).toEqual([{ id: 'u1', email: 'a@b' }]);
  });

  // Mongosql v1.8.5 has no wire-level parameter protocol, but Cube's
  // pre-aggregation paths emit `WHERE col >= CAST(? AS TIMESTAMP)` with a
  // values array. The driver inlines literal substitution before passing
  // the SQL to mongosql — equivalent to what `BaseQuery.paramAllocator`
  // would emit when the dialect declares no param support.
  it('inlines ? placeholders from non-empty values into the SQL sent to mongosql', async () => {
    const queryMock = vi.fn().mockResolvedValue([]);
    installMockNative({ query: queryMock });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.query('SELECT * FROM users WHERE id = ? AND created_at >= CAST(? AS TIMESTAMP)', [
      42,
      new Date('2026-03-01T00:00:00.000Z'),
    ]);
    const sentSql = queryMock.mock.calls[0][0] as string;
    expect(sentSql).toBe(
      "SELECT * FROM users WHERE id = 42 AND created_at >= CAST('2026-03-01T00:00:00.000Z' AS TIMESTAMP)",
    );
  });

  it('parameter substitution skips ? characters inside string literals', async () => {
    const queryMock = vi.fn().mockResolvedValue([]);
    installMockNative({ query: queryMock });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.query("SELECT * FROM users WHERE comment = 'is this a ?' AND id = ?", [7]);
    const sentSql = queryMock.mock.calls[0][0] as string;
    expect(sentSql).toBe("SELECT * FROM users WHERE comment = 'is this a ?' AND id = 7");
  });

  it('parameter substitution rejects placeholder/value count mismatch', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const err = (await d.query('SELECT * FROM users WHERE id = ? AND name = ?', [1]).catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_CONFIG_INVALID');
    expect(err.message).toMatch(/more '\?' placeholders than provided values/i);
  });

  it('quotes string values and doubles embedded single quotes', async () => {
    const queryMock = vi.fn().mockResolvedValue([]);
    installMockNative({ query: queryMock });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.query("SELECT * FROM users WHERE name = ?", ["O'Brien"]);
    const sentSql = queryMock.mock.calls[0][0] as string;
    expect(sentSql).toBe("SELECT * FROM users WHERE name = 'O''Brien'");
  });

  it('accepts query() with no values argument (Issue 4)', async () => {
    installMockNative({ query: vi.fn().mockResolvedValue([]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await expect(d.query('SELECT * FROM users')).resolves.toEqual([]);
  });

  it('accepts query() with explicit empty-array values (Issue 4)', async () => {
    installMockNative({ query: vi.fn().mockResolvedValue([]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await expect(d.query('SELECT * FROM users', [])).resolves.toEqual([]);
  });
});

describe('MongoSqlDriver — query() cancellation (Cube release-during-pre-agg flow)', () => {
  it('forwards options.signal through the wrapper which bridges it to a native AbortHandle', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const ctrl = new AbortController();
    await d.query('SELECT * FROM users', [], { signal: ctrl.signal });
    const args = lastClient!.query.mock.calls[0];
    // The driver hands the AbortSignal to the wrapper, which constructs a
    // native AbortHandle and passes that. Our mock impersonates the
    // native module directly — args[1] is the FakeAbortHandle, not the
    // raw AbortSignal.
    expect(args[1]).toBeDefined();
    expect(args[1]).not.toBeNull();
  });

  it('passes null to the native side when options.signal is missing (fast path)', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.query('SELECT * FROM users');
    const args = lastClient!.query.mock.calls[0];
    // No signal → wrapper's runCancellable fast-paths with `null` so the
    // napi-rs `Option<&AbortHandle>` slot is explicit.
    expect(args[1]).toBeNull();
  });

  it('ignores non-AbortSignal values in options.signal (defensive)', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.query('SELECT * FROM users', [], { signal: 'not a signal' as unknown as AbortSignal });
    const args = lastClient!.query.mock.calls[0];
    // extractAbortSignal rejects non-AbortSignal values → wrapper sees
    // undefined → fast-paths to null.
    expect(args[1]).toBeNull();
  });

  it('release() cancels in-flight queries by triggering the underlying client.close()', async () => {
    // Cube's `release()` is the SIGTERM-during-pre-agg entry point. The
    // driver layer just calls client.close(); the native side fans the
    // close-token out to in-flight queries. This test confirms the call
    // shape — cancellation behaviour itself is covered by the Rust
    // integration tests (close_cancels_in_flight_queries).
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.testConnection();
    const queryPromise = d.query('SELECT 1');
    await d.release();
    expect(lastClient!.close).toHaveBeenCalledTimes(1);
    await queryPromise;
  });
});

describe('MongoSqlDriver — testConnection / lifecycle', () => {
  it('lazily creates the native client on first testConnection()', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    expect(createdClients).toBe(0);
    await d.testConnection();
    expect(createdClients).toBe(1);
    expect(lastClient!.testConnection).toHaveBeenCalled();
  });

  it('does not re-create the native client across multiple calls', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.testConnection();
    await d.query('SELECT 1');
    await d.tablesSchema();
    expect(createdClients).toBe(1);
  });

  it('release() closes the underlying client', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.testConnection();
    expect(lastClient!.close).not.toHaveBeenCalled();
    await d.release();
    expect(lastClient!.close).toHaveBeenCalledTimes(1);
  });

  it('release() is idempotent (no client) and safe to call before testConnection', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await expect(d.release()).resolves.toBeUndefined();
    await expect(d.release()).resolves.toBeUndefined();
  });

  it('release() is idempotent after init: second call no-ops', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.testConnection();
    await d.release();
    await d.release();
    expect(lastClient!.close).toHaveBeenCalledTimes(1);
  });
});

describe('MongoSqlDriver — tablesSchema', () => {
  it('returns the native shape unchanged', async () => {
    const payload: TablesSchema = {
      analytics: {
        users: [
          { name: 'id', type: 'objectid', attributes: [] },
          { name: 'email', type: 'string', attributes: [] },
        ],
      },
    };
    installMockNative({ tablesSchema: vi.fn().mockResolvedValue(payload) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await expect(d.tablesSchema()).resolves.toEqual(payload);
  });
});

describe('MongoSqlDriver — unsupported BaseDriver methods', () => {
  it('createSchemaIfNotExists throws (read-only driver)', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await expect(d.createSchemaIfNotExists('s')).rejects.toThrow(/not supported/i);
  });

  it('dropTable throws (read-only driver)', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await expect(d.dropTable('t')).rejects.toThrow(/not supported/i);
  });

  it('uploadTable throws (read-only driver)', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await expect(d.uploadTable('t', [], { rows: [] })).rejects.toThrow(/not supported/i);
  });

  it('readOnly() returns true', () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    expect(d.readOnly()).toBe(true);
  });
});

describe('MongoSqlDriver — downloadQueryResults', () => {
  it('routes through query() and returns BaseDriver memory shape with sniffed types', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([{ users: { a: 1 } }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT a FROM users', [], {
      highWaterMark: 100,
    });
    // BaseDriver expects DownloadQueryResultsResult: { rows, types }.
    // Types are inferred from the row shape — required by Cube Store ingest
    // (empty types throws "empty columns. introspection has failed.").
    expect(result).toMatchObject({ rows: [{ a: 1 }] });
    // Mirrors @cubejs-backend/base-driver's DbTypeValueMatcher: small
    // integers classify as 'int', large ones as 'bigint'.
    expect((result as { types: Array<{ name: string; type: string }> }).types).toEqual([
      { name: 'a', type: 'int' },
    ]);
  });

  it('infers decimal type from fixed-point string values (Decimal128 round-trip)', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([{ orders: { total: '1234.56' } }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT total FROM orders', []);
    expect((result as { types: Array<{ name: string; type: string }> }).types).toEqual([
      { name: 'total', type: 'decimal' },
    ]);
  });

  it('infers timestamp type from ISO-8601 string values', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([{ orders: { created_at: '2026-03-01T10:00:00.000Z' } }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT created_at FROM orders', []);
    expect((result as { types: Array<{ name: string; type: string }> }).types).toEqual([
      { name: 'created_at', type: 'timestamp' },
    ]);
  });

  it('returns empty types for empty row sets (vs throwing)', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT a FROM users', []);
    expect(result).toMatchObject({ rows: [], types: [] });
  });

  it('classifies mixed int + decimal-string column as decimal (filtered SUM case)', async () => {
    // Reproduces the byStatus pre-agg shape: a filtered SUM yields 0 (int)
    // for rows that don't match the filter and a decimal string for rows
    // that do. Cube Store rejects a column typed `int` if any row has a
    // decimal-shaped value, so the column must classify as `decimal`.
    installMockNative({
      query: vi.fn().mockResolvedValue([
        { orders: { paid_amount: 0 } },
        { orders: { paid_amount: '400.00' } },
      ]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT paid_amount FROM orders', []);
    expect((result as { types: Array<{ name: string; type: string }> }).types).toEqual([
      { name: 'paid_amount', type: 'decimal' },
    ]);
  });
});
