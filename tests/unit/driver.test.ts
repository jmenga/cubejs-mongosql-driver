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

/**
 * Build a fake native `query()` mock from a list of plain rows. Wraps each
 * call's return value in the new `{rows, types}` shape the wrapper expects.
 *
 * `types` defaults to an empty list; tests that exercise
 * `downloadQueryResults` override it explicitly.
 */
function mockQueryRows<R>(rows: R[], types: Array<{ name: string; type: string }> = []): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ rows, types });
}

function installMockNative(overrides: Partial<FakeClient> = {}): void {
  _setNativeModuleForTests({
    MongoSqlClient: function (config: unknown): FakeClient {
      const client: FakeClient = {
        config,
        testConnection: vi.fn().mockResolvedValue(undefined),
        query: mockQueryRows([]),
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

  it('parses atlas-sql schema source from env (Atlas SQL endpoint mode)', async () => {
    // Atlas SQL endpoints (`*.a.query.mongodb.net`) discover schemas via
    // the `sqlGetSchema` admin command rather than `__sql_schemas`. The
    // env-var value mirrors the docs nomenclature ("Atlas SQL").
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_MONGOSQL_SCHEMA_SOURCE = 'atlas-sql';
    installMockNative();
    const d = new MongoSqlDriver();
    await d.testConnection();
    const cfg = lastClient!.config as Record<string, unknown>;
    expect(cfg.schemaSource).toEqual({ kind: 'atlas-sql' });
  });

  it('atlas-sql schema source does NOT require CUBEJS_MONGOSQL_SCHEMA_FILE', async () => {
    // Defence-in-depth: the file-only env-var must not leak its
    // "required" check into atlas-sql mode.
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_MONGOSQL_SCHEMA_SOURCE = 'atlas-sql';
    installMockNative();
    expect(() => new MongoSqlDriver()).not.toThrow();
  });

  it('rejects unknown CUBEJS_MONGOSQL_SCHEMA_SOURCE values; error enumerates all three valid kinds', async () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_MONGOSQL_SCHEMA_SOURCE = 'mystery-mode';
    installMockNative();
    let thrown: unknown;
    try {
      new MongoSqlDriver();
    } catch (e) {
      thrown = e;
    }
    expect((thrown as MongoSqlError).code).toBe('MONGOSQL_CONFIG_INVALID');
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/collection/);
    expect(msg).toMatch(/file/);
    expect(msg).toMatch(/atlas-sql/);
    expect(msg).toMatch(/mystery-mode/);
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

  // ---------- Cube-standard env var integration (see src/config.ts) ----------

  it('reads CUBEJS_DB_URL when CUBEJS_DB_URI is not set', async () => {
    process.env.CUBEJS_DB_URL = 'mongodb://from-url/x';
    process.env.CUBEJS_DB_NAME = 'analytics';
    installMockNative();
    const d = new MongoSqlDriver();
    await d.testConnection();
    expect((lastClient!.config as { uri: string }).uri).toBe('mongodb://from-url/x');
  });

  it('appends env-driven Mongo URI params to the configured URI', async () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_DB_MAX_POOL = '50';
    process.env.CUBEJS_DB_IDLE_TIMEOUT = '60s';
    process.env.CUBEJS_MONGOSQL_APP_NAME = 'cube-test';
    installMockNative();
    const d = new MongoSqlDriver();
    await d.testConnection();
    const uri = (lastClient!.config as { uri: string }).uri;
    expect(uri).toMatch(/maxPoolSize=50/);
    expect(uri).toMatch(/maxIdleTimeMS=60000/);
    expect(uri).toMatch(/appName=cube-test/);
  });

  it('CUBEJS_DB_QUERY_TIMEOUT (duration) maps to queryTimeoutMs', async () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_DB_QUERY_TIMEOUT = '5s';
    installMockNative();
    const d = new MongoSqlDriver();
    await d.testConnection();
    expect((lastClient!.config as { queryTimeoutMs: number }).queryTimeoutMs).toBe(5_000);
  });

  it('CUBEJS_DB_QUERY_TIMEOUT takes precedence over CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS', async () => {
    process.env.CUBEJS_DB_URI = 'mongodb://h/db';
    process.env.CUBEJS_DB_NAME = 'analytics';
    process.env.CUBEJS_DB_QUERY_TIMEOUT = '5s';
    process.env.CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS = '99999';
    installMockNative();
    const d = new MongoSqlDriver();
    await d.testConnection();
    expect((lastClient!.config as { queryTimeoutMs: number }).queryTimeoutMs).toBe(5_000);
  });
});

describe('MongoSqlDriver — query() row flattening', () => {
  it('unwraps single-key envelope: [{users: {a:1}}] -> [{a:1}]', async () => {
    installMockNative({
      query: mockQueryRows([{ users: { a: 1, b: 'x' } }, { users: { a: 2, b: 'y' } }]),
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
      query: mockQueryRows([{ a: 1 }, { a: 2 }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT a FROM users');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('handles empty result set', async () => {
    installMockNative({ query: mockQueryRows([]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT * FROM users WHERE 1=0');
    expect(rows).toEqual([]);
  });

  it('merges multi-table JOIN envelope with table-prefixed keys', async () => {
    installMockNative({
      query: mockQueryRows([
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
      query: mockQueryRows([{ count: 42 }]),
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
    installMockNative({ query: mockQueryRows([{ '': { u_id: 'u1', o_id: 'o1' } }]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>(
      'SELECT users.account_id AS u_id, orders.account_id AS o_id FROM users JOIN orders ON 1=1',
    );
    expect(rows).toEqual([{ u_id: 'u1', o_id: 'o1' }]);
  });

  it('allows JOIN projections with non-colliding qualified column names (Issue 2)', async () => {
    // Two qualified columns with different trailing names → no collision risk.
    installMockNative({ query: mockQueryRows([{ '': { email: 'a@b', amount: '1.0' } }]) });
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
    installMockNative({ query: mockQueryRows([{ '': { email: 'a@b', name: 'A' } }]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>('SELECT email, name FROM users');
    expect(rows).toEqual([{ email: 'a@b', name: 'A' }]);
  });

  it('regression: non-empty single-key envelope still unwraps cleanly', async () => {
    installMockNative({
      query: mockQueryRows([{ users: { id: 'u1', email: 'a@b' } }]),
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
    const queryMock = mockQueryRows([]);
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
    const queryMock = mockQueryRows([]);
    installMockNative({ query: queryMock });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.query("SELECT * FROM users WHERE comment = 'is this a ?' AND id = ?", [7]);
    const sentSql = queryMock.mock.calls[0][0] as string;
    expect(sentSql).toBe("SELECT * FROM users WHERE comment = 'is this a ?' AND id = 7");
  });

  it('parameter substitution rejects placeholder/value count mismatch', async () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const err = (await d
      .query('SELECT * FROM users WHERE id = ? AND name = ?', [1])
      .catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_CONFIG_INVALID');
    expect(err.message).toMatch(/more '\?' placeholders than provided values/i);
  });

  it('quotes string values and doubles embedded single quotes', async () => {
    const queryMock = mockQueryRows([]);
    installMockNative({ query: queryMock });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await d.query('SELECT * FROM users WHERE name = ?', ["O'Brien"]);
    const sentSql = queryMock.mock.calls[0][0] as string;
    expect(sentSql).toBe("SELECT * FROM users WHERE name = 'O''Brien'");
  });

  it('accepts query() with no values argument (Issue 4)', async () => {
    installMockNative({ query: mockQueryRows([]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    await expect(d.query('SELECT * FROM users')).resolves.toEqual([]);
  });

  it('accepts query() with explicit empty-array values (Issue 4)', async () => {
    installMockNative({ query: mockQueryRows([]) });
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
  it('routes through query() and returns BaseDriver memory shape with authoritative types', async () => {
    // Native binding returns the `(name, type)` list derived from
    // mongosql's select_order + result_set_schema. The driver passes the
    // list through unchanged; we no longer sniff types from row values.
    installMockNative({
      query: mockQueryRows([{ users: { a: 1 } }], [{ name: 'a', type: 'int' }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT a FROM users', [], {
      highWaterMark: 100,
    });
    expect(result).toMatchObject({ rows: [{ a: 1 }] });
    expect((result as { types: Array<{ name: string; type: string }> }).types).toEqual([{ name: 'a', type: 'int' }]);
  });

  it('passes through decimal type tagged by mongosql for fixed-point columns', async () => {
    installMockNative({
      query: mockQueryRows([{ orders: { total: '1234.56' } }], [{ name: 'total', type: 'decimal' }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT total FROM orders', []);
    expect((result as { types: Array<{ name: string; type: string }> }).types).toEqual([
      { name: 'total', type: 'decimal' },
    ]);
  });

  it('passes through timestamp type tagged by mongosql for date columns', async () => {
    installMockNative({
      query: mockQueryRows(
        [{ orders: { created_at: '2026-03-01T10:00:00.000Z' } }],
        [{ name: 'created_at', type: 'timestamp' }],
      ),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT created_at FROM orders', []);
    expect((result as { types: Array<{ name: string; type: string }> }).types).toEqual([
      { name: 'created_at', type: 'timestamp' },
    ]);
  });

  it('returns an empty types list when the native binding does (e.g. empty result set)', async () => {
    installMockNative({ query: mockQueryRows([], []) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT a FROM users', []);
    expect(result).toMatchObject({ rows: [], types: [] });
  });

  it('returns authoritative types even for an empty row set (no value-sniffing required)', async () => {
    // Pre-fix this case would have returned `types: []` because the row
    // set is empty. Post-fix the native side derives types from the SQL
    // metadata, so Cube Store always gets a real column list.
    installMockNative({
      query: mockQueryRows(
        [],
        [
          { name: 'paid_amount', type: 'decimal' },
          { name: 'status', type: 'string' },
        ],
      ),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT paid_amount, status FROM orders', []);
    expect((result as { types: Array<{ name: string; type: string }> }).types).toEqual([
      { name: 'paid_amount', type: 'decimal' },
      { name: 'status', type: 'string' },
    ]);
  });

  it('column type list is stable when row JS-object key order differs between calls', async () => {
    // Regression test for the multi-partition UNION failure: mongosql's
    // `$project` stage is built by iterating a HashMap-backed
    // `Schema::Document`, so the projected field order in each returned
    // row is not stable across translations of the same SQL. The OLD
    // value-sniffing path keyed off `Object.keys(firstRow)` and so
    // produced column lists in different orders across partition
    // rebuilds. The driver now sources types from the native (mongosql)
    // metadata (`select_order`, a deterministic `Vec`) — so two calls
    // with the SAME `types` argument but DIFFERENT row key orders both
    // produce the same (column order, type) tuple.
    const types = [
      { name: 'agent_hangup_count', type: 'timestamp' },
      { name: 'agent_id', type: 'string' },
    ];
    installMockNative({
      query: mockQueryRows([{ call_logs: { agent_hangup_count: '2026-01-01T00:00:00Z', agent_id: 'a1' } }], types),
    });
    const d1 = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const r1 = await d1.downloadQueryResults('SELECT agent_hangup_count, agent_id FROM call_logs', []);
    expect((r1 as { types: Array<{ name: string; type: string }> }).types).toEqual(types);

    // Second "partition" with the row keys reversed but the SAME types.
    installMockNative({
      query: mockQueryRows([{ call_logs: { agent_id: 'a1', agent_hangup_count: '2026-01-01T00:00:00Z' } }], types),
    });
    const d2 = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const r2 = await d2.downloadQueryResults('SELECT agent_hangup_count, agent_id FROM call_logs', []);
    expect((r2 as { types: Array<{ name: string; type: string }> }).types).toEqual(types);
  });

  it('applies flattenRow to the rows the same way query() does', async () => {
    // Multi-key envelope (JOIN-shape) — rows flatten to `<ns>__<col>`.
    installMockNative({
      query: mockQueryRows(
        [
          {
            users: { id: 'u1' },
            orders: { id: 'o1' },
          },
        ],
        [
          { name: 'users__id', type: 'string' },
          { name: 'orders__id', type: 'string' },
        ],
      ),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT * FROM users JOIN orders ON 1=1', []);
    expect(result).toMatchObject({
      rows: [{ users__id: 'u1', orders__id: 'o1' }],
      types: [
        { name: 'users__id', type: 'string' },
        { name: 'orders__id', type: 'string' },
      ],
    });
  });

  it('rejects ambiguous JOIN projections at the SQL gate (matches query() behaviour)', async () => {
    // The empty-string-envelope collision check that the regular query()
    // path enforces also applies here — both go through the same SQL.
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const err = (await d
      .downloadQueryResults('SELECT users.account_id, orders.account_id FROM users JOIN orders ON 1=1', [])
      .catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_TRANSLATE_FAILED');
    expect(createdClients).toBe(0);
  });
});
