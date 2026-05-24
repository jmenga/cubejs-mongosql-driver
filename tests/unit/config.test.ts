/**
 * Tests for src/config.ts — the env → URI mapping layer.
 *
 * Covers Cube-standard `CUBEJS_DB_*` and Mongo-specific
 * `CUBEJS_MONGOSQL_*` env vars, precedence between explicit override /
 * `CUBEJS_DB_URL` / `CUBEJS_DB_URI` / composed-from-parts, URI param
 * append rules (existing keys win), duration parsing, URL-encoding of
 * userinfo, and the `CUBEJS_DB_QUERY_TIMEOUT` → `queryTimeoutMs`
 * coercion path.
 *
 * Pure unit test — no native module, no docker.
 */
import { describe, expect, it } from 'vitest';
import { parseDurationToMillis, resolveUriConfig, type EnvLike } from '../../src/config.js';
import type { MongoSqlError } from '../../src/types.js';

function env(extra: Record<string, string | undefined> = {}): EnvLike {
  // Start from an empty object; vitest spawns a child env per file. The
  // resolver only reads documented keys, so we don't need to scrub
  // anything else.
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Pull `?...` query as a Map<key, value>. URI-decoded for comparison. */
function uriParams(uri: string): Map<string, string> {
  const i = uri.indexOf('?');
  if (i === -1) return new Map();
  const tail = uri.slice(i + 1);
  const m = new Map<string, string>();
  for (const part of tail.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? '' : part.slice(eq + 1);
    m.set(decodeURIComponent(k), decodeURIComponent(v));
  }
  return m;
}

describe('resolveUriConfig — base URI precedence', () => {
  it('explicit constructor uri wins over every env var', () => {
    const out = resolveUriConfig(
      'mongodb://explicit/db',
      env({
        CUBEJS_DB_URL: 'mongodb://from-url/db',
        CUBEJS_DB_URI: 'mongodb://from-uri/db',
        CUBEJS_DB_HOST: 'from-host',
      }),
    );
    expect(out.uri).toBe('mongodb://explicit/db');
  });

  it('CUBEJS_DB_URL wins over CUBEJS_DB_URI', () => {
    const out = resolveUriConfig(
      undefined,
      env({
        CUBEJS_DB_URL: 'mongodb://from-url/db',
        CUBEJS_DB_URI: 'mongodb://from-uri/db',
      }),
    );
    expect(out.uri).toBe('mongodb://from-url/db');
  });

  it('CUBEJS_DB_URI is honoured when CUBEJS_DB_URL is absent', () => {
    const out = resolveUriConfig(undefined, env({ CUBEJS_DB_URI: 'mongodb://from-uri/db' }));
    expect(out.uri).toBe('mongodb://from-uri/db');
  });

  it('composes mongodb://host:port/db from CUBEJS_DB_HOST/_PORT/_NAME when no URI is set', () => {
    const out = resolveUriConfig(
      undefined,
      env({
        CUBEJS_DB_HOST: 'mongo.internal',
        CUBEJS_DB_PORT: '27017',
        CUBEJS_DB_NAME: 'example',
      }),
    );
    expect(out.uri).toBe('mongodb://mongo.internal:27017/mongosql_test');
  });

  it('composes userinfo from _USER/_PASS when both set', () => {
    const out = resolveUriConfig(
      undefined,
      env({
        CUBEJS_DB_HOST: 'h',
        CUBEJS_DB_USER: 'reader',
        CUBEJS_DB_PASS: 'p4ssw0rd',
      }),
    );
    expect(out.uri).toBe('mongodb://reader:p4ssw0rd@h/');
  });

  it('URL-encodes user/pass with reserved characters (`@`, `:`, `/`, `?`, `#`)', () => {
    const out = resolveUriConfig(
      undefined,
      env({
        CUBEJS_DB_HOST: 'h',
        CUBEJS_DB_USER: 'user@x',
        CUBEJS_DB_PASS: 'p@ss:wo/rd?#x',
      }),
    );
    // encodeURIComponent encodes @, :, /, ?, # so the userinfo parser sees them.
    expect(out.uri).toBe('mongodb://user%40x:p%40ss%3Awo%2Frd%3F%23x@h/');
  });

  it('rejects CUBEJS_DB_PASS without CUBEJS_DB_USER (credentials require both)', () => {
    const err = (() => {
      try {
        resolveUriConfig(undefined, env({ CUBEJS_DB_HOST: 'h', CUBEJS_DB_PASS: 'pw' }));
        return undefined;
      } catch (e) {
        return e as MongoSqlError;
      }
    })();
    expect(err).toBeDefined();
    expect(err?.code).toBe('MONGOSQL_CONFIG_INVALID');
    expect(err?.message).toMatch(/CUBEJS_DB_PASS/);
  });

  it('throws MONGOSQL_CONFIG_INVALID when no URI source AND no CUBEJS_DB_HOST', () => {
    const err = (() => {
      try {
        resolveUriConfig(undefined, env({}));
        return undefined;
      } catch (e) {
        return e as MongoSqlError;
      }
    })();
    expect(err).toBeDefined();
    expect(err?.code).toBe('MONGOSQL_CONFIG_INVALID');
    expect(err?.message).toMatch(/CUBEJS_DB_URL|CUBEJS_DB_URI|CUBEJS_DB_HOST/);
  });

  it('does not append a port when CUBEJS_DB_HOST is a comma-separated seed list', () => {
    const out = resolveUriConfig(
      undefined,
      env({
        CUBEJS_DB_HOST: 'mongo-1:27017,mongo-2:27017',
        CUBEJS_DB_PORT: '27018',
        CUBEJS_DB_NAME: 'db',
      }),
    );
    // Seed list already has ports; CUBEJS_DB_PORT must not be tacked on.
    expect(out.uri).toBe('mongodb://mongo-1:27017,mongo-2:27017/db');
  });
});

describe('resolveUriConfig — env-driven URI params', () => {
  it('appends CUBEJS_DB_SSL=true as tls=true', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_SSL: 'true' }));
    expect(uriParams(out.uri).get('tls')).toBe('true');
  });

  it('accepts CUBEJS_DB_SSL=1 / 0 / false as boolean', () => {
    for (const [raw, expected] of [
      ['1', 'true'],
      ['true', 'true'],
      ['TRUE', 'true'],
      ['false', 'false'],
      ['0', 'false'],
    ] as const) {
      const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_SSL: raw }));
      expect(uriParams(out.uri).get('tls')).toBe(expected);
    }
  });

  it('rejects nonsense boolean values with a clear error', () => {
    const err = (() => {
      try {
        resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_SSL: 'maybe' }));
        return undefined;
      } catch (e) {
        return e as MongoSqlError;
      }
    })();
    expect(err?.code).toBe('MONGOSQL_CONFIG_INVALID');
    expect(err?.message).toMatch(/CUBEJS_DB_SSL/);
  });

  it('appends CUBEJS_DB_MAX_POOL → maxPoolSize and _MIN_POOL → minPoolSize', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_MAX_POOL: '50', CUBEJS_DB_MIN_POOL: '5' }));
    const p = uriParams(out.uri);
    expect(p.get('maxPoolSize')).toBe('50');
    expect(p.get('minPoolSize')).toBe('5');
  });

  it('rejects negative pool sizes', () => {
    const err = (() => {
      try {
        resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_MAX_POOL: '-1' }));
        return undefined;
      } catch (e) {
        return e as MongoSqlError;
      }
    })();
    expect(err?.code).toBe('MONGOSQL_CONFIG_INVALID');
    expect(err?.message).toMatch(/CUBEJS_DB_MAX_POOL/);
  });

  it('appends CUBEJS_DB_IDLE_TIMEOUT=60s as maxIdleTimeMS=60000', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_IDLE_TIMEOUT: '60s' }));
    expect(uriParams(out.uri).get('maxIdleTimeMS')).toBe('60000');
  });

  it('appends CUBEJS_DB_IDLE_TIMEOUT as raw ms when no suffix', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_IDLE_TIMEOUT: '90000' }));
    expect(uriParams(out.uri).get('maxIdleTimeMS')).toBe('90000');
  });

  it('appends each Mongo-specific timeout knob individually', () => {
    const cases: Array<{ envVar: string; uriKey: string; raw: string; expected: string }> = [
      { envVar: 'CUBEJS_MONGOSQL_MAX_CONNECTING', uriKey: 'maxConnecting', raw: '4', expected: '4' },
      { envVar: 'CUBEJS_MONGOSQL_WAIT_QUEUE_TIMEOUT_MS', uriKey: 'waitQueueTimeoutMS', raw: '5000', expected: '5000' },
      { envVar: 'CUBEJS_MONGOSQL_CONNECT_TIMEOUT_MS', uriKey: 'connectTimeoutMS', raw: '8000', expected: '8000' },
      { envVar: 'CUBEJS_MONGOSQL_SOCKET_TIMEOUT_MS', uriKey: 'socketTimeoutMS', raw: '60000', expected: '60000' },
      {
        envVar: 'CUBEJS_MONGOSQL_SERVER_SELECTION_TIMEOUT_MS',
        uriKey: 'serverSelectionTimeoutMS',
        raw: '15000',
        expected: '15000',
      },
      {
        envVar: 'CUBEJS_MONGOSQL_HEARTBEAT_FREQUENCY_MS',
        uriKey: 'heartbeatFrequencyMS',
        raw: '10000',
        expected: '10000',
      },
    ];
    for (const { envVar, uriKey, raw, expected } of cases) {
      const out = resolveUriConfig('mongodb://h/db', env({ [envVar]: raw }));
      const p = uriParams(out.uri);
      expect(p.get(uriKey), `${envVar} → ${uriKey}`).toBe(expected);
    }
  });

  it('appends CUBEJS_MONGOSQL_APP_NAME → appName as-is', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_MONGOSQL_APP_NAME: 'cube-e2e' }));
    expect(uriParams(out.uri).get('appName')).toBe('cube-e2e');
  });

  it('appends CUBEJS_MONGOSQL_RETRY_WRITES / _RETRY_READS as canonical booleans', () => {
    const out = resolveUriConfig(
      'mongodb://h/db',
      env({ CUBEJS_MONGOSQL_RETRY_WRITES: '0', CUBEJS_MONGOSQL_RETRY_READS: 'true' }),
    );
    const p = uriParams(out.uri);
    expect(p.get('retryWrites')).toBe('false');
    expect(p.get('retryReads')).toBe('true');
  });

  it('appends CUBEJS_MONGOSQL_COMPRESSORS as-is (mongo crate parses the comma list)', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_MONGOSQL_COMPRESSORS: 'snappy,zstd' }));
    expect(uriParams(out.uri).get('compressors')).toBe('snappy,zstd');
  });
});

describe('resolveUriConfig — user URI params always win', () => {
  it('does not override a key the URI already specifies', () => {
    const out = resolveUriConfig('mongodb://h/db?maxPoolSize=200', env({ CUBEJS_DB_MAX_POOL: '50' }));
    expect(uriParams(out.uri).get('maxPoolSize')).toBe('200');
  });

  it('match is case-insensitive (URI `MAXPOOLSIZE` blocks env append)', () => {
    const out = resolveUriConfig('mongodb://h/db?MAXPOOLSIZE=200', env({ CUBEJS_DB_MAX_POOL: '50' }));
    // No second maxPoolSize/MAXPOOLSIZE; URI is left intact.
    expect(out.uri).toBe('mongodb://h/db?MAXPOOLSIZE=200');
  });

  it('appends new keys but leaves existing keys untouched in combined runs', () => {
    const out = resolveUriConfig(
      'mongodb://h/db?retryWrites=true',
      env({ CUBEJS_DB_MAX_POOL: '50', CUBEJS_MONGOSQL_RETRY_WRITES: 'false' }),
    );
    const p = uriParams(out.uri);
    expect(p.get('retryWrites')).toBe('true');
    expect(p.get('maxPoolSize')).toBe('50');
  });
});

describe('resolveUriConfig — mongodb+srv URIs', () => {
  it('appends env-driven params after an existing query string with `&`', () => {
    const out = resolveUriConfig(
      'mongodb+srv://cluster.mongodb.net/db?retryWrites=true&w=majority',
      env({ CUBEJS_DB_MAX_POOL: '50' }),
    );
    const p = uriParams(out.uri);
    expect(p.get('retryWrites')).toBe('true');
    expect(p.get('w')).toBe('majority');
    expect(p.get('maxPoolSize')).toBe('50');
    // No double `?` or trailing `&?`.
    expect(out.uri).not.toMatch(/\?\?/);
    expect(out.uri).not.toMatch(/&\?/);
  });

  it('starts the query with `?` when the srv URI has none', () => {
    const out = resolveUriConfig('mongodb+srv://cluster.mongodb.net/db', env({ CUBEJS_DB_MAX_POOL: '50' }));
    expect(out.uri).toBe('mongodb+srv://cluster.mongodb.net/db?maxPoolSize=50');
  });
});

describe('resolveUriConfig — query timeout', () => {
  it('CUBEJS_DB_QUERY_TIMEOUT (duration string) sets queryTimeoutMs', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_QUERY_TIMEOUT: '10m' }));
    expect(out.queryTimeoutMs).toBe(600_000);
  });

  it('CUBEJS_DB_QUERY_TIMEOUT bare number is interpreted as milliseconds', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_QUERY_TIMEOUT: '15000' }));
    expect(out.queryTimeoutMs).toBe(15_000);
  });

  it('CUBEJS_DB_QUERY_TIMEOUT wins over legacy CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS', () => {
    const out = resolveUriConfig(
      'mongodb://h/db',
      env({ CUBEJS_DB_QUERY_TIMEOUT: '5s', CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS: '99999' }),
    );
    expect(out.queryTimeoutMs).toBe(5_000);
  });

  it('legacy CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS still works when CUBEJS_DB_QUERY_TIMEOUT is absent', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS: '15000' }));
    expect(out.queryTimeoutMs).toBe(15_000);
  });

  it('returns undefined queryTimeoutMs when neither var is set', () => {
    const out = resolveUriConfig('mongodb://h/db', env({}));
    expect(out.queryTimeoutMs).toBeUndefined();
  });

  it('throws MONGOSQL_CONFIG_INVALID for nonsense CUBEJS_DB_QUERY_TIMEOUT', () => {
    const err = (() => {
      try {
        resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_QUERY_TIMEOUT: 'forever' }));
        return undefined;
      } catch (e) {
        return e as MongoSqlError;
      }
    })();
    expect(err?.code).toBe('MONGOSQL_CONFIG_INVALID');
    expect(err?.message).toMatch(/CUBEJS_DB_QUERY_TIMEOUT/);
  });

  it('does NOT append queryTimeoutMs / maxTimeMS as a URI param (driver layer handles it)', () => {
    const out = resolveUriConfig('mongodb://h/db', env({ CUBEJS_DB_QUERY_TIMEOUT: '10m' }));
    expect(out.uri).toBe('mongodb://h/db');
  });
});

describe('parseDurationToMillis', () => {
  it.each([
    ['10m', 600_000],
    ['60s', 60_000],
    ['5000ms', 5000],
    ['5000', 5000],
    ['1h', 3_600_000],
    ['0', 0],
    ['0.5s', 500],
  ])('parses %s', (raw, expected) => {
    expect(parseDurationToMillis(raw, 'X')).toBe(expected);
  });

  it.each(['', 'forever', '10y', 'abc', '-1s', 'NaN'])('rejects %s', (raw) => {
    expect(() => parseDurationToMillis(raw, 'X')).toThrow(/X has invalid duration/);
  });
});

describe('resolveUriConfig — idempotence', () => {
  it('two calls with the same env produce byte-identical URIs', () => {
    const e = env({
      CUBEJS_DB_URI: 'mongodb://h/db',
      CUBEJS_DB_MAX_POOL: '50',
      CUBEJS_DB_MIN_POOL: '5',
      CUBEJS_MONGOSQL_APP_NAME: 'cube',
      CUBEJS_MONGOSQL_RETRY_WRITES: 'true',
    });
    const a = resolveUriConfig(undefined, e);
    const b = resolveUriConfig(undefined, e);
    expect(a.uri).toBe(b.uri);
  });
});
