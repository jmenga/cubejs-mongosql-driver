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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  it('routes through query() and returns BaseDriver memory shape', async () => {
    installMockNative({
      query: vi.fn().mockResolvedValue([{ users: { a: 1 } }]),
    });
    const d = new MongoSqlDriver({ uri: 'mongodb://h/db', database: 'analytics' });
    const result = await d.downloadQueryResults('SELECT a FROM users', [], {
      highWaterMark: 100,
    });
    // BaseDriver expects DownloadQueryResultsResult: { rows, types }.
    expect(result).toMatchObject({ rows: [{ a: 1 }] });
    expect((result as { types: unknown[] }).types).toEqual([]);
  });
});
