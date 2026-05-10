/**
 * Integration tests for the SPEC §6 error contract. Reproduces every error
 * code by triggering the real failure mode against atlas-local where
 * possible; for codes that cannot be deterministically reached E2E we
 * `it.skip` with a clear reason. Covers IMPLEMENTATION_PLAN.md T17.
 *
 * Each test asserts:
 *   1. `(err as MongoSqlError).code === '<EXPECTED_CODE>'`
 *   2. `err.name === 'MongoSqlError'`
 *   3. `err.message` is a non-empty string
 *
 * No driver state is shared across tests; each test constructs (and where
 * applicable, releases) its own `MongoSqlDriver`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MongoSqlDriver } from '../../src/index.js';
import type { ErrorCode } from '../../src/types.js';

const TEST_DB = 'mongosql_test';
const VALID_URI =
  process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true';

// Bogus URI host — `.invalid` is reserved per RFC 6761 so it never resolves.
const BOGUS_URI = 'mongodb://nonexistent.invalid:27017/?directConnection=true&serverSelectionTimeoutMS=2000';

// Same auth source / host as atlas-local but with deliberately wrong creds.
const BAD_CREDS_URI =
  'mongodb://baduser:badpass@localhost:27017/?authSource=admin&directConnection=true&serverSelectionTimeoutMS=5000';

interface MaybeCoded {
  code?: string;
  name?: string;
  message?: string;
}

async function expectErrorCode<T>(fn: () => Promise<T>, expectedCode: ErrorCode): Promise<MaybeCoded> {
  let captured: unknown;
  try {
    await fn();
    throw new Error(`expected ${expectedCode} but call resolved successfully`);
  } catch (err) {
    captured = err;
  }
  expect(captured).toBeInstanceOf(Error);
  const e = captured as MaybeCoded;
  expect(e.name).toBe('MongoSqlError');
  expect(e.code).toBe(expectedCode);
  expect(typeof e.message).toBe('string');
  expect((e.message ?? '').length).toBeGreaterThan(0);
  return e;
}

describe('MongoSqlDriver — error contract (E2E)', () => {
  // Every test creates its own driver; the cleanup queue releases any drivers
  // a test failed to release on its own so we never leak the underlying
  // mongo client across tests.
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.shift();
      if (fn) {
        try {
          await fn();
        } catch {
          // best-effort cleanup; never fail a test on teardown
        }
      }
    }
  });

  function track(driver: MongoSqlDriver): MongoSqlDriver {
    cleanups.push(() => driver.release());
    return driver;
  }

  it('MONGOSQL_CONFIG_INVALID — empty database string', async () => {
    // Constructor throws synchronously via buildConfig(); wrap in async so
    // expectErrorCode's try/await catches it uniformly.
    await expectErrorCode(async () => new MongoSqlDriver({ uri: VALID_URI, database: '' }), 'MONGOSQL_CONFIG_INVALID');
  });

  it('MONGOSQL_CONNECT_FAILED — unresolvable URI host', async () => {
    const driver = track(
      new MongoSqlDriver({
        uri: BOGUS_URI,
        database: TEST_DB,
        schemaRefreshSec: 3600,
        queryTimeoutMs: 5_000,
      }),
    );
    await expectErrorCode(() => driver.testConnection(), 'MONGOSQL_CONNECT_FAILED');
  }, 30_000);

  it('MONGOSQL_AUTH_FAILED — valid host, wrong credentials', async () => {
    const driver = track(
      new MongoSqlDriver({
        uri: BAD_CREDS_URI,
        database: TEST_DB,
        schemaRefreshSec: 3600,
        queryTimeoutMs: 10_000,
      }),
    );
    await expectErrorCode(() => driver.testConnection(), 'MONGOSQL_AUTH_FAILED');
  }, 30_000);

  it('MONGOSQL_SCHEMA_NOT_FOUND — database without __sql_schemas', async () => {
    // `__sql_schemas` is only seeded into `mongosql_test`. A different
    // database name has no such collection — `find` returns an empty cursor
    // and the loader raises SchemaNotFound.
    const driver = track(
      new MongoSqlDriver({
        uri: VALID_URI,
        database: 'empty_db_for_t17',
        schemaRefreshSec: 3600,
        queryTimeoutMs: 10_000,
      }),
    );
    await expectErrorCode(() => driver.testConnection(), 'MONGOSQL_SCHEMA_NOT_FOUND');
  });

  it('MONGOSQL_SCHEMA_FILE_NOT_FOUND — file mode pointing at a missing path', async () => {
    const missingPath = join(tmpdir(), `t17-schema-does-not-exist-${Date.now()}.yaml`);
    const driver = track(
      new MongoSqlDriver({
        uri: VALID_URI,
        database: TEST_DB,
        schemaSource: { kind: 'file', path: missingPath },
        schemaRefreshSec: 3600,
        queryTimeoutMs: 10_000,
      }),
    );
    await expectErrorCode(() => driver.testConnection(), 'MONGOSQL_SCHEMA_FILE_NOT_FOUND');
  });

  it('MONGOSQL_SCHEMA_INVALID — file mode pointing at malformed YAML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't17-schema-invalid-'));
    const badPath = join(dir, 'broken.yaml');
    // Content that the YAML parser will reject (unbalanced quote + stray
    // tab indentation in a flow context). Both serde_yaml and any sane YAML
    // parser surface this as a parse error → SchemaInvalid in our taxonomy.
    writeFileSync(badPath, 'schema:\n  jsonSchema: { "unterminated: \n\tproperties: [\n');
    try {
      const driver = track(
        new MongoSqlDriver({
          uri: VALID_URI,
          database: TEST_DB,
          schemaSource: { kind: 'file', path: badPath },
          schemaRefreshSec: 3600,
          queryTimeoutMs: 10_000,
        }),
      );
      await expectErrorCode(() => driver.testConnection(), 'MONGOSQL_SCHEMA_INVALID');
    } finally {
      try {
        unlinkSync(badPath);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MONGOSQL_TRANSLATE_FAILED — query against a nonexistent table', async () => {
    // Per the 2026-05-09 — T07 discovery, mongosql's algebrizer rejects
    // unknown TABLE references with `CollectionNotFound` (unknown columns
    // in default Relaxed mode pass through). The error message must mention
    // the offending table.
    const driver = track(
      new MongoSqlDriver({
        uri: VALID_URI,
        database: TEST_DB,
        schemaRefreshSec: 3600,
        queryTimeoutMs: 10_000,
      }),
    );
    await driver.testConnection();
    const err = await expectErrorCode(
      () => driver.query('SELECT bogus FROM nonexistent_table'),
      'MONGOSQL_TRANSLATE_FAILED',
    );
    expect(err.message ?? '').toMatch(/nonexistent_table/i);
  });

  it('MONGOSQL_RESULT_TOO_LARGE — maxRows below the result row count', async () => {
    // The `users` fixture has 4 rows; a maxRows cap of 1 forces the
    // executor's row-cap branch in `crates/native/src/execute.rs::execute`.
    const driver = track(
      new MongoSqlDriver({
        uri: VALID_URI,
        database: TEST_DB,
        schemaRefreshSec: 3600,
        queryTimeoutMs: 10_000,
        maxRows: 1,
      }),
    );
    await driver.testConnection();
    await expectErrorCode(() => driver.query('SELECT * FROM users'), 'MONGOSQL_RESULT_TOO_LARGE');
  });

  // --- Best-effort / skipped paths -----------------------------------------

  it.skip('MONGOSQL_TIMEOUT — query exceeds queryTimeoutMs (skipped: not deterministic against atlas-local)', async () => {
    // Triggering `maxTimeMSExpired` (server code 50) reliably from the
    // 4-row fixture proved flaky:
    //   - aggressive `queryTimeoutMs: 1` is below the round-trip latency
    //     of the ping/translate steps, so the error often surfaces before
    //     execution even runs against the cursor.
    //   - mongosql doesn't expose a `SLEEP()` builtin for us to inject
    //     guaranteed server-side work.
    // To verify this path deterministically we'd either need (a) a much
    // larger fixture and a `$function` JavaScript stage emitting a server
    // sleep, which atlas-local enables but the seed harness does not
    // currently load, or (b) a unit test that synthesizes a `Command(50)`
    // mongodb error directly — already covered by
    // `crates/native/src/execute.rs::tests::map_mongo_error_*`.
    // Keeping this as a documented placeholder; flip to active when (a)
    // lands or when atlas-local exposes a deterministic timeout knob.
    const driver = new MongoSqlDriver({
      uri: VALID_URI,
      database: TEST_DB,
      schemaRefreshSec: 3600,
      queryTimeoutMs: 1,
    });
    try {
      await driver.testConnection();
      await expectErrorCode(
        () =>
          driver.query(
            'SELECT a._id FROM users a JOIN users b ON a.account_id = b.account_id JOIN users c ON b.account_id = c.account_id',
          ),
        'MONGOSQL_TIMEOUT',
      );
    } finally {
      await driver.release();
    }
  });

  it.skip('MONGOSQL_EXECUTE_FAILED — runtime aggregation failure (skipped: mongosql lowers most failures elsewhere)', async () => {
    // mongosql's translator catches almost every classifiable failure
    // before it reaches the cursor:
    //   - unknown table     → MONGOSQL_TRANSLATE_FAILED (algebrizer)
    //   - type mismatch     → MONGOSQL_TRANSLATE_FAILED (schema check)
    //   - divide-by-zero    → MQL `$divide` returns null (no error)
    //   - invalid date math → translator rejects (TRANSLATE_FAILED)
    // The remaining EXECUTE_FAILED surface is server-side aggregation
    // failures that aren't classified into Auth/Connect/Timeout — e.g.
    // `OperationFailure` from a bad `$collStats` argument. The mongosql
    // translator currently emits well-formed pipelines for every SQL form
    // we can express, leaving no deterministic E2E trigger from the SQL
    // layer alone. Unit-tested via the From<mongodb::error::Error>
    // fall-through arm in `crates/native/src/error.rs`.
    // Re-enable once we have a way to inject a malformed pipeline post-
    // translation (e.g. a debug knob on `MongoSqlClient`) or once the
    // executor exposes raw-pipeline ingress for tests.
  });
});
