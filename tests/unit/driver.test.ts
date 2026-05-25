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
import { _normalizeRowShapeForTests as normalizeRowShape } from '../../src/MongoSqlDriver.js';
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

// ---------------------------------------------------------------------------
// Capability flags pinned — Cube branches on these to decide whether to
// invoke streaming / incremental-schema paths. The values are part of
// the driver's contract and any change must be paired with the path
// implementation.
// ---------------------------------------------------------------------------
describe('MongoSqlDriver — capabilities', () => {
  it('advertises streamImport=false, incrementalSchemaLoading=true (contract)', () => {
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const caps = d.capabilities();
    // streamImport: we have no Rust→Node streaming cursor; pre-agg
    // builds go through downloadQueryResults's memory path. Cube reads
    // this flag and avoids calling downloadQueryResults with
    // streamImport=true (and avoids invoking driver.stream()).
    expect(caps.streamImport).toBe(false);
    // incrementalSchemaLoading: we provide getSchemas /
    // getTablesForSpecificSchemas / getColumnsForSpecificTables so
    // Cube uses the granular three-method introspection path instead
    // of the SQL information_schema fallback.
    expect(caps.incrementalSchemaLoading).toBe(true);
    // Defence-in-depth — pin the other flags too so a future change
    // to any one of them surfaces explicitly here.
    expect(caps.streamingSource).toBe(false);
    expect(caps.unloadWithoutTempTable).toBe(false);
    expect(caps.csvImport).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 1 — `streamImport: true` on downloadQueryResults is a no-op (we
// advertise streamImport=false; Cube SHOULDN'T pass true, but the
// driver must remain compatible with the BaseDriver default which
// ignores the flag). Pin the behavior so a future "let's accept it"
// refactor cannot silently advertise streaming we don't implement.
// ---------------------------------------------------------------------------
describe('MongoSqlDriver — downloadQueryResults streaming-flag contract', () => {
  it('ignores streamImport:true and returns the memory shape', async () => {
    installMockNative({
      query: mockQueryRows([{ orders: { a: 1 } }], [{ name: 'a', type: 'int' }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT a FROM orders', [], {
      highWaterMark: 100,
      streamImport: true,
    });
    // The contract: `streamImport:true` does NOT change the response
    // shape — driver always returns memory `{rows, types}`. No
    // `rowStream` field; rows are an in-memory array.
    expect(result).not.toHaveProperty('rowStream');
    expect(result).toHaveProperty('rows');
    expect((result as { rows: unknown[] }).rows).toEqual([{ a: 1 }]);
    expect(result).toHaveProperty('types');
  });

  it('ignores streamImport:false (same memory shape)', async () => {
    installMockNative({
      query: mockQueryRows([{ orders: { a: 2 } }], [{ name: 'a', type: 'int' }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT a FROM orders', [], {
      highWaterMark: 100,
      streamImport: false,
    });
    expect(result).not.toHaveProperty('rowStream');
    expect((result as { rows: unknown[] }).rows).toEqual([{ a: 2 }]);
  });

  it('does NOT implement DriverInterface.stream() — flag advertises this', () => {
    // Belt-and-braces — confirm that `driver.stream` is not exposed.
    // Cube checks for the method's presence on some paths; advertising
    // `streamImport: false` is the contract, but having the property
    // also be absent removes any ambiguity.
    //
    // INTENT NOTE: BaseDriver itself does NOT define `stream`, so absent
    // any explicit override this assertion is trivially true. The point
    // of pinning it is to catch an accidental future override (e.g. a
    // refactor that adds `public override stream(...)` without flipping
    // `capabilities().streamImport` to `true`). Treat as a regression
    // guard against accidental implementation, not a load-bearing
    // capability check.
    installMockNative();
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    expect((d as unknown as { stream?: unknown }).stream).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — incremental-schema-loading three-method suite. Each method
// re-renders from the cached native `tablesSchema()` snapshot; here we
// stub the snapshot directly and assert filtering correctness.
// ---------------------------------------------------------------------------
describe('MongoSqlDriver — incremental schema loading (getSchemas / *ForSpecificSchemas / *ForSpecificTables)', () => {
  const fullSnapshot: TablesSchema = {
    mongosql_test: {
      orders: [
        { name: '_id', type: 'string', attributes: [] },
        { name: 'amount', type: 'decimal', attributes: [] },
        { name: 'status', type: 'string', attributes: [] },
      ],
      users: [
        { name: '_id', type: 'string', attributes: [] },
        { name: 'email', type: 'string', attributes: [] },
      ],
    },
  };

  function driverWithSnapshot(snapshot: TablesSchema): MongoSqlDriver {
    installMockNative({ tablesSchema: vi.fn().mockResolvedValue(snapshot) });
    return new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'mongosql_test' });
  }

  it('getSchemas() returns the DB list extracted from tablesSchema()', async () => {
    const d = driverWithSnapshot(fullSnapshot);
    const out = await d.getSchemas();
    expect(out).toEqual([{ schema_name: 'mongosql_test' }]);
  });

  it('getSchemas() returns empty list when the snapshot is empty', async () => {
    const d = driverWithSnapshot({});
    expect(await d.getSchemas()).toEqual([]);
  });

  it('getTablesForSpecificSchemas() returns one row per table in each requested schema', async () => {
    const d = driverWithSnapshot(fullSnapshot);
    const out = await d.getTablesForSpecificSchemas([{ schema_name: 'mongosql_test' }]);
    // Two tables in mongosql_test → two rows.
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({ schema_name: 'mongosql_test', table_name: 'orders' });
    expect(out).toContainEqual({ schema_name: 'mongosql_test', table_name: 'users' });
  });

  it('getTablesForSpecificSchemas() silently drops unknown schemas', async () => {
    const d = driverWithSnapshot(fullSnapshot);
    const out = await d.getTablesForSpecificSchemas([
      { schema_name: 'mongosql_test' },
      { schema_name: 'never_existed' },
    ]);
    // Only the known schema contributes rows; unknown silently skipped.
    expect(out).toHaveLength(2);
    for (const r of out) expect(r.schema_name).toBe('mongosql_test');
  });

  it('getTablesForSpecificSchemas() returns empty list for empty input (no native I/O)', async () => {
    const snapshotMock = vi.fn().mockResolvedValue(fullSnapshot);
    installMockNative({ tablesSchema: snapshotMock });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'mongosql_test' });
    const out = await d.getTablesForSpecificSchemas([]);
    expect(out).toEqual([]);
    // Empty input short-circuits — no need to refresh the snapshot.
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('getColumnsForSpecificTables() returns one row per (table, column)', async () => {
    const d = driverWithSnapshot(fullSnapshot);
    const out = await d.getColumnsForSpecificTables([
      { schema_name: 'mongosql_test', table_name: 'orders' },
      { schema_name: 'mongosql_test', table_name: 'users' },
    ]);
    // 3 columns in orders + 2 in users = 5 rows.
    expect(out).toHaveLength(5);
    // Each row carries (schema_name, table_name, column_name, data_type).
    const ordersAmount = out.find((r) => r.table_name === 'orders' && r.column_name === 'amount');
    expect(ordersAmount).toBeDefined();
    expect(ordersAmount).toMatchObject({
      schema_name: 'mongosql_test',
      table_name: 'orders',
      column_name: 'amount',
      data_type: 'decimal',
    });
    const usersEmail = out.find((r) => r.table_name === 'users' && r.column_name === 'email');
    expect(usersEmail).toMatchObject({
      schema_name: 'mongosql_test',
      table_name: 'users',
      column_name: 'email',
      data_type: 'string',
    });
  });

  it('getColumnsForSpecificTables() silently drops unknown tables', async () => {
    const d = driverWithSnapshot(fullSnapshot);
    const out = await d.getColumnsForSpecificTables([
      { schema_name: 'mongosql_test', table_name: 'orders' },
      { schema_name: 'mongosql_test', table_name: 'never_table' },
      { schema_name: 'never_schema', table_name: 'orders' },
    ]);
    // Only the known (schema,table) pair contributes columns.
    expect(out).toHaveLength(3);
    for (const r of out) {
      expect(r.schema_name).toBe('mongosql_test');
      expect(r.table_name).toBe('orders');
    }
  });

  it('getColumnsForSpecificTables() returns empty list for empty input (no native I/O)', async () => {
    const snapshotMock = vi.fn().mockResolvedValue(fullSnapshot);
    installMockNative({ tablesSchema: snapshotMock });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'mongosql_test' });
    const out = await d.getColumnsForSpecificTables([]);
    expect(out).toEqual([]);
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('getColumnsForSpecificTables() forwards attribute arrays verbatim (TS-layer wiring smoke test)', async () => {
    // NOTE: This test pins a TS-layer wiring path that is NEVER exercised
    // in production today. The Rust `do_tables_schema`
    // (crates/native/src/client.rs:314) hard-codes `attributes: []`, so
    // the snapshot returned from the real native binding never carries a
    // non-empty array. The test stubs `tablesSchema()` directly with a
    // synthetic `['primaryKey']` attribute to verify that IF a future
    // Rust change propagates `__sql_schemas` document attribute fields,
    // the TS forwarding path would surface them on
    // `QueryColumnsResult.attributes` for Cube's relationship inference.
    // Until that Rust change lands, treat this as a forwarding-path
    // smoke test, not a production-attribute test.
    const taggedSnapshot: TablesSchema = {
      mongosql_test: {
        orders: [{ name: '_id', type: 'string', attributes: ['primaryKey'] }],
      },
    };
    const d = driverWithSnapshot(taggedSnapshot);
    const out = await d.getColumnsForSpecificTables([{ schema_name: 'mongosql_test', table_name: 'orders' }]);
    expect(out).toHaveLength(1);
    expect(out[0].attributes).toEqual(['primaryKey']);
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

  it('null-fills keys named in the types list but missing from every row (defensive)', async () => {
    // The authoritative type list comes from mongosql's `select_order`
    // — it's the SQL projection order, not derived from row values. If
    // the rows happen to lack one of the projected keys entirely (e.g.
    // mongosql's nested-path-missing behaviour drops the column from
    // every doc), the downstream Cube Store LOAD ROWS step still
    // expects a value per (row × type) tuple. We null-fill so the
    // contract holds.
    installMockNative({
      query: mockQueryRows(
        [{ configs: { id: 'c1' } }, { configs: { id: 'c2' } }],
        [
          { name: 'id', type: 'string' },
          { name: 'agent_display_name', type: 'string' },
        ],
      ),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT id, agent_display_name FROM configs', []);
    expect((result as { rows: unknown[] }).rows).toEqual([
      { id: 'c1', agent_display_name: null },
      { id: 'c2', agent_display_name: null },
    ]);
  });

  it('null-fills sparse rows in the rows-with-types path (partial population)', async () => {
    // Mongosql drops nested-path keys from a doc when the path is
    // missing — so within a single result set some rows have a key and
    // others don't. The authoritative type list names the column on
    // BOTH the present-rows AND missing-rows; we null-fill the missing
    // ones so Cube's first-row sniff finds the column.
    installMockNative({
      query: mockQueryRows(
        [
          // Row 0 is the sparse one (would be the case under
          // ORDER BY agent_display_name ASC since missing → sorts first).
          { configs: { id: 'c1' } },
          { configs: { id: 'c2', agent_display_name: 'Alice' } },
          { configs: { id: 'c3', agent_display_name: 'Bob' } },
        ],
        [
          { name: 'id', type: 'string' },
          { name: 'agent_display_name', type: 'string' },
        ],
      ),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults(
      'SELECT id, agent_display_name FROM configs ORDER BY agent_display_name ASC',
      [],
    );
    expect((result as { rows: unknown[] }).rows).toEqual([
      { id: 'c1', agent_display_name: null },
      { id: 'c2', agent_display_name: 'Alice' },
      { id: 'c3', agent_display_name: 'Bob' },
    ]);
  });

  it('falls back to union-of-keys normalization when the types list is empty (sparse rows)', async () => {
    // Defensive: if the native binding hands back an empty `types` list
    // (no authoritative projection metadata — should be rare but is
    // representable on the type) the driver must still honor the FR-1
    // contract that "every row has the same key set". The fallback is
    // the same union-of-keys helper that `query()` uses.
    installMockNative({
      query: mockQueryRows(
        [
          // Row 0 sparse — same shape as the ORDER BY ASC case but
          // without an authoritative type list driving the fill.
          { configs: { id: 'c1' } },
          { configs: { id: 'c2', agent_display_name: 'Alice' } },
          { configs: { id: 'c3', agent_display_name: 'Bob' } },
        ],
        [], // <- empty types
      ),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT id, agent_display_name FROM configs', []);
    expect((result as { rows: unknown[] }).rows).toEqual([
      { id: 'c1', agent_display_name: null },
      { id: 'c2', agent_display_name: 'Alice' },
      { id: 'c3', agent_display_name: 'Bob' },
    ]);
    // Every row should have the union of keys.
    for (const r of (result as { rows: Array<Record<string, unknown>> }).rows) {
      expect(Object.keys(r).sort()).toEqual(['agent_display_name', 'id']);
    }
  });
});

// ---------------------------------------------------------------------------
// Row-shape normalization — see `normalizeRowShape` in src/MongoSqlDriver.ts
// for the full motivation. Net: mongosql's `$project` of a nested-path
// expression OMITS the field on rows where the source path is missing
// (does NOT emit null). With `ORDER BY <nested> ASC` the sparse rows
// sort to row 0; Cube's native `getFinalQueryResult` transform compiles
// its row→member extraction from row 0's keys and drops the column from
// every row in the response. Driver fix: union keys across all rows and
// null-fill so row 0 carries the same shape as any other row.
// ---------------------------------------------------------------------------
describe('MongoSqlDriver — query() row-shape normalization', () => {
  it('empty result set passes through unchanged', async () => {
    installMockNative({ query: mockQueryRows([]) });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT id, agent_display_name FROM configs');
    expect(rows).toEqual([]);
  });

  it('uniform-shape rows pass through unchanged (no null-fill needed)', async () => {
    installMockNative({
      query: mockQueryRows([
        { configs: { id: 'c1', agent_display_name: 'Alice' } },
        { configs: { id: 'c2', agent_display_name: 'Bob' } },
      ]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query('SELECT id, agent_display_name FROM configs');
    expect(rows).toEqual([
      { id: 'c1', agent_display_name: 'Alice' },
      { id: 'c2', agent_display_name: 'Bob' },
    ]);
  });

  it('sparse row 0 (lacks a key row 5 has) → row 0 gets null, others unchanged', async () => {
    // The exact shape of the bug — `ORDER BY agent_display_name ASC` puts
    // the missing-name row at index 0. Cube's first-row sniff would drop
    // the column from every row pre-fix.
    installMockNative({
      query: mockQueryRows([
        { configs: { id: 'c0' } }, // sparse — missing agent_display_name
        { configs: { id: 'c1', agent_display_name: 'Alice' } },
        { configs: { id: 'c2', agent_display_name: 'Bob' } },
        { configs: { id: 'c3', agent_display_name: 'Carol' } },
        { configs: { id: 'c4', agent_display_name: 'Dave' } },
        { configs: { id: 'c5', agent_display_name: 'Eve' } },
      ]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>(
      'SELECT id, agent_display_name FROM configs ORDER BY agent_display_name ASC',
    );
    expect(rows).toHaveLength(6);
    // Row 0 — the formerly-sparse one — now carries the key with `null`.
    expect(rows[0]).toEqual({ id: 'c0', agent_display_name: null });
    // Rows 1..5 unchanged.
    expect(rows[5]).toEqual({ id: 'c5', agent_display_name: 'Eve' });
    // Every row carries the same key set.
    const allKeys = rows.map((r) => Object.keys(r).sort());
    for (const keys of allKeys) {
      expect(keys).toEqual(['agent_display_name', 'id']);
    }
  });

  it('multiple sparse rows with different missing keys → union resolves; every row has every key', async () => {
    // The general case — row 0 missing one key, row 2 missing another,
    // row 4 missing a third. Union of `{a,b,c,d}` across all rows; every
    // row null-filled to carry all four.
    installMockNative({
      query: mockQueryRows([
        { configs: { a: 1, b: 2, c: 3 } }, // missing d
        { configs: { a: 1, b: 2, c: 3, d: 4 } },
        { configs: { a: 1, c: 3, d: 4 } }, // missing b
        { configs: { a: 1, b: 2, c: 3, d: 4 } },
        { configs: { b: 2, c: 3, d: 4 } }, // missing a
      ]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>('SELECT a, b, c, d FROM configs');
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['a', 'b', 'c', 'd']);
    }
    expect(rows[0]).toEqual({ a: 1, b: 2, c: 3, d: null });
    expect(rows[2]).toEqual({ a: 1, b: null, c: 3, d: 4 });
    expect(rows[4]).toEqual({ a: null, b: 2, c: 3, d: 4 });
  });

  it('JOIN-shape rows ({"": {table_a__col, table_b__col}}) normalize correctly', async () => {
    // The empty-string envelope branch is the JOIN-projection case
    // (`SELECT u.email, o.amount FROM u JOIN o ...`). Mongosql can drop
    // a nested-path field from this envelope just like any other. The
    // normalization must look at the POST-flatten keys, not pre-flatten.
    installMockNative({
      query: mockQueryRows([
        // First-row sparse — missing `amount`.
        { '': { email: 'a@b' } },
        { '': { email: 'c@d', amount: '10.00' } },
        { '': { email: 'e@f', amount: '20.00' } },
      ]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>(
      'SELECT users.email, orders.amount FROM users JOIN orders ON 1=1',
    );
    expect(rows).toEqual([
      { email: 'a@b', amount: null },
      { email: 'c@d', amount: '10.00' },
      { email: 'e@f', amount: '20.00' },
    ]);
  });

  it('multi-key JOIN envelope ({u: {...}, o: {...}}) normalizes correctly (table-prefixed keys)', async () => {
    // The multi-key envelope branch — flattenRow produces
    // `<table>__<col>` keys. If the missing-path field happens to live
    // on one side and be present on others, the prefix-flattened key
    // is what we union over.
    installMockNative({
      query: mockQueryRows([
        // Row 0 — orders side missing `amount`.
        { users: { email: 'a@b' }, orders: { id: 'o0' } },
        { users: { email: 'c@d' }, orders: { id: 'o1', amount: '10.00' } },
      ]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const rows = await d.query<Record<string, unknown>>('SELECT * FROM users JOIN orders');
    expect(rows).toEqual([
      { users__email: 'a@b', orders__id: 'o0', orders__amount: null },
      { users__email: 'c@d', orders__id: 'o1', orders__amount: '10.00' },
    ]);
  });

  // -------------------------------------------------------------------------
  // Direct normalizeRowShape function tests (no driver, no mocks).
  // -------------------------------------------------------------------------
  describe('normalizeRowShape — direct unit tests', () => {
    it('returns empty array unchanged', () => {
      const rows: Array<Record<string, unknown>> = [];
      const out = normalizeRowShape<Record<string, unknown>>(rows);
      expect(out).toEqual([]);
      expect(out).toBe(rows);
    });

    it('returns uniform-shape rows unchanged in content (no new keys)', () => {
      const rows = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
      const out = normalizeRowShape<Record<string, unknown>>(rows);
      expect(out).toEqual([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]);
    });

    it('null-fills row 0 with a key only row 5 has', () => {
      const rows = [
        { id: 'r0' }, // sparse
        { id: 'r1', name: 'A' },
        { id: 'r2', name: 'B' },
        { id: 'r3', name: 'C' },
        { id: 'r4', name: 'D' },
        { id: 'r5', name: 'E' },
      ];
      const out = normalizeRowShape<Record<string, unknown>>(rows);
      expect(out[0]).toEqual({ id: 'r0', name: null });
      expect(out[5]).toEqual({ id: 'r5', name: 'E' });
      // Every row has the same key set.
      for (const r of out) {
        expect(Object.keys(r).sort()).toEqual(['id', 'name']);
      }
    });

    it('resolves the union across multiple sparse rows with different missing keys', () => {
      const rows = [
        { a: 1, b: 2 },
        { b: 2, c: 3 },
        { a: 1, c: 3 },
      ];
      const out = normalizeRowShape<Record<string, unknown>>(rows);
      expect(out[0]).toEqual({ a: 1, b: 2, c: null });
      expect(out[1]).toEqual({ a: null, b: 2, c: 3 });
      expect(out[2]).toEqual({ a: 1, b: null, c: 3 });
    });

    it('preserves existing null values (does not overwrite null with null)', () => {
      // An explicit `null` is different from a missing key — both end up
      // as null after normalize, but the input semantics must be preserved
      // for the explicit case (no surprise rewrites).
      const rows = [
        { id: 'r0', name: null },
        { id: 'r1', name: 'A' },
      ];
      const out = normalizeRowShape<Record<string, unknown>>(rows);
      expect(out).toEqual([
        { id: 'r0', name: null },
        { id: 'r1', name: 'A' },
      ]);
    });

    it('preserves falsy non-null values (0, "", false)', () => {
      // `hasOwnProperty` handles falsy-but-present keys correctly —
      // assert that explicit `0`, `""`, `false` are not clobbered.
      const rows = [
        { a: 0, b: '', c: false },
        { a: 1, b: 'x', c: true, d: 'extra' },
      ];
      const out = normalizeRowShape<Record<string, unknown>>(rows);
      expect(out[0]).toEqual({ a: 0, b: '', c: false, d: null });
      expect(out[1]).toEqual({ a: 1, b: 'x', c: true, d: 'extra' });
    });

    it('single row is left unchanged (union = its own keys)', () => {
      const rows = [{ id: 'r0', name: 'A' }];
      const out = normalizeRowShape<Record<string, unknown>>(rows);
      expect(out).toEqual([{ id: 'r0', name: 'A' }]);
    });
  });
});

// ===========================================================================
// Gap 8 — driverFactory(ctx) multi-tenant CONSTRUCTOR-INDEPENDENCE pins.
//
// CubeJS's recommended pattern for multi-tenant data routing is:
//
//   driverFactory: (ctx) => new MongoSqlDriver({
//     uri:      lookupTenantUri(ctx.dataSource, ctx.securityContext),
//     database: lookupTenantDb(ctx.dataSource, ctx.securityContext),
//   })
//
// where `ctx.dataSource` is the cube's declared `data_source` name and
// `ctx.securityContext` carries per-request claims. Cube invokes the
// factory PER `(dataSource, securityContext)` tuple and caches the
// returned driver instance for the duration of the orchestrator window.
//
// **This unit block pins driver-side constructor independence only:**
//   1. The MongoSqlDriver constructor accepts the same config from EITHER
//      env vars OR explicit args — letting `driverFactory(ctx)` map a
//      tenant key to a driver instance without polluting process.env.
//   2. Two driver instances constructed with different configs route to
//      distinct native clients (no shared state).
//   3. Each driver's `_config()` reports the same uri/database it was
//      constructed with — so a test harness (or production diagnostic)
//      can verify the routing decision.
//
// **What this block does NOT verify:** the cube-server-side dispatch
// itself — Cube invoking `driverFactory(ctx)` with a real `dataSource`,
// caching per-tuple, and routing /load to the right driver. That contract
// is pinned end-to-end by the multi-tenant cube-e2e test:
//
//   tests/cube-e2e/cube-e2e.test.ts → "driverFactory(ctx) routes
//   `dataSource: 'secondary'` queries to mongosql_test_secondary"
//
// which seeds two databases (`mongosql_test` + `mongosql_test_secondary`),
// wires `driverFactory: (ctx) => ...` in `examples/docker/cube/cube.js`
// to branch on `ctx.dataSource`, and queries through both cubes asserting
// distinct row counts.
// ===========================================================================
describe('MongoSqlDriver — Gap 8 driverFactory(ctx) constructor-independence', () => {
  it('two drivers with distinct configs route to distinct native clients', async () => {
    installMockNative();
    // Tenant A — analytics database.
    const driverA = new MongoSqlDriver({
      uri: 'mongodb://host-a/?authSource=admin',
      database: 'tenant_a',
    });
    // Tenant B — separate database on a separate host.
    const driverB = new MongoSqlDriver({
      uri: 'mongodb://host-b/?authSource=admin',
      database: 'tenant_b',
    });
    // Force lazy client creation on both.
    await driverA.testConnection();
    const clientA = lastClient;
    await driverB.testConnection();
    const clientB = lastClient;
    // Two distinct native client instances — multi-tenant routing MUST
    // NOT alias to a shared client.
    expect(clientA).toBeDefined();
    expect(clientB).toBeDefined();
    expect(clientA).not.toBe(clientB);
    // Each client received its own config.
    expect((clientA!.config as { uri: string }).uri).toBe('mongodb://host-a/?authSource=admin');
    expect((clientA!.config as { database: string }).database).toBe('tenant_a');
    expect((clientB!.config as { uri: string }).uri).toBe('mongodb://host-b/?authSource=admin');
    expect((clientB!.config as { database: string }).database).toBe('tenant_b');
    // Reflective accessor — useful for production diagnostics and the
    // canonical hook for `driverFactory(ctx)` to verify routing.
    expect(driverA._config().database).toBe('tenant_a');
    expect(driverB._config().database).toBe('tenant_b');
  });

  it('mimics Cube driverFactory(ctx) → returns the right driver per dataSource', async () => {
    // Build a `driverFactory` like a production cube.js would: it maps
    // ctx.dataSource to a per-tenant config and returns a fresh driver.
    // Pin that the returned driver's _config matches the per-tenant
    // values — i.e. there's no accidental aliasing, no env-var bleed.
    installMockNative();
    const tenantConfig: Record<string, { uri: string; database: string }> = {
      tenant_a: { uri: 'mongodb://host-a/?authSource=admin', database: 'tenant_a_db' },
      tenant_b: { uri: 'mongodb://host-b/?authSource=admin', database: 'tenant_b_db' },
    };
    // The shape Cube actually invokes: `(ctx) => BaseDriver`. We only
    // depend on `ctx.dataSource` here; the security context shape is
    // documented in Cube docs but unused for the routing decision.
    const driverFactory = (ctx: { dataSource: string }): MongoSqlDriver => {
      const cfg = tenantConfig[ctx.dataSource];
      if (!cfg) throw new Error(`unknown dataSource ${ctx.dataSource}`);
      return new MongoSqlDriver({ uri: cfg.uri, database: cfg.database });
    };

    const driverA = driverFactory({ dataSource: 'tenant_a' });
    const driverB = driverFactory({ dataSource: 'tenant_b' });
    expect(driverA._config().database).toBe('tenant_a_db');
    expect(driverB._config().database).toBe('tenant_b_db');
    expect(driverA._config().uri).toContain('host-a');
    expect(driverB._config().uri).toContain('host-b');

    // Cube caches and reuses driver instances per `(dataSource,
    // securityContext)` tuple — for a second invocation with the same
    // dataSource the factory MUST be able to produce an equivalent
    // driver (i.e. no hidden state in the constructor).
    const driverA2 = driverFactory({ dataSource: 'tenant_a' });
    expect(driverA2._config().database).toBe('tenant_a_db');
    expect(driverA2).not.toBe(driverA); // distinct instances
  });

  it('driverFactory pattern returns distinct dialectClass-stable instances', () => {
    // Pin that dialectClass is INSTANCE-INDEPENDENT — Cube calls it via
    // the static reference `MongoSqlDriver.dialectClass()`, so even if
    // a factory hands out two driver instances they both share the
    // same dialect class. A future regression that instance-attached
    // `dialectClass` could break Cube's compile path silently.
    expect(MongoSqlDriver.dialectClass()).toBe(MongoSqlQuery);
    expect(MongoSqlDriver.dialectClass()).toBe(MongoSqlDriver.dialectClass());
  });
});
