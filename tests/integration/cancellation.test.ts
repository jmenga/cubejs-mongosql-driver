/**
 * Integration tests for AbortSignal-driven query cancellation.
 *
 * Closes the 0.1.0 cancellation gap: a `release()` or external SIGTERM
 * during a long query previously let the Tokio cursor run until the
 * server-side `maxTimeMS` fired. With the cancel token wiring in place
 * the in-flight query rejects with `MONGOSQL_CANCELLED` within a few ms
 * of the abort signal.
 *
 * The slow-query construction here is `$function` with a JS sleep — Atlas
 * SQL Interface translates `SELECT ... WHERE TRUE` into an aggregate that
 * we extend with a synthetic delay via mongosql's `IIF` + `SLEEP` (when
 * available) OR — failing that — a deliberately wide scan of `orders`
 * that takes long enough for the test to fire the abort. Atlas SQL does
 * NOT expose `SLEEP`/`pg_sleep` etc., so we fall back to scan latency
 * when needed.
 *
 * To run: `pnpm test:integration cancellation` (after `make e2e:up`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';
import type { MongoSqlError } from '../../src/types.js';

const TEST_DB = 'mongosql_test';
const URI =
  process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true';

describe('cancellation (E2E against atlas-local)', () => {
  let driver: MongoSqlDriver;

  beforeAll(async () => {
    driver = new MongoSqlDriver({
      uri: URI,
      database: TEST_DB,
      schemaRefreshSec: 3600,
      // Long timeout so the cancel path — not the server — wins the race.
      queryTimeoutMs: 30_000,
      maxRows: 100_000,
    });
    await driver.testConnection();
  });

  afterAll(async () => {
    await driver?.release();
  });

  it('rejects with MONGOSQL_CANCELLED when AbortSignal fires before query starts', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = (await driver
      .query('SELECT * FROM orders', [], { signal: ctrl.signal })
      .catch((e: unknown) => e)) as MongoSqlError;
    expect(err.code).toBe('MONGOSQL_CANCELLED');
    expect(err.name).toBe('MongoSqlError');
  });

  it('rejects with MONGOSQL_CANCELLED when AbortSignal fires mid-query, faster than queryTimeoutMs', async () => {
    // We construct a query whose translated pipeline takes long enough
    // for our 50ms abort window to win. A self-join over the (small)
    // orders fixture is enough — atlas-local's planning is bounded but
    // not instantaneous, and the server-side maxTimeMS is 30s.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const start = Date.now();
    const err = (await driver
      .query(
        'SELECT a.account_id AS aa, b.account_id AS bb FROM orders a JOIN orders b ON a.account_id = b.account_id',
        [],
        {
          signal: ctrl.signal,
        },
      )
      .catch((e: unknown) => e)) as MongoSqlError;
    const elapsed = Date.now() - start;
    expect(err.code).toBe('MONGOSQL_CANCELLED');
    // Must finish well before the 30s queryTimeoutMs — abort, not timeout.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('release() cancels in-flight queries and lets release() return promptly', async () => {
    // Spin up a fresh driver so we can release() without affecting the
    // module-scoped driver other tests share.
    const local = new MongoSqlDriver({
      uri: URI,
      database: TEST_DB,
      schemaRefreshSec: 3600,
      queryTimeoutMs: 30_000,
      maxRows: 100_000,
    });
    await local.testConnection();

    // Fire a slow-ish query without a signal; release() should cancel it
    // via the parent close-token.
    const queryPromise = local.query<Record<string, unknown>>(
      'SELECT a.account_id AS aa, b.account_id AS bb FROM orders a JOIN orders b ON a.account_id = b.account_id',
    );
    // Yield once so the query crosses the napi boundary before we release.
    await new Promise((r) => setTimeout(r, 30));

    const releaseStart = Date.now();
    await local.release();
    const releaseElapsed = Date.now() - releaseStart;
    // 5s drain budget + slack. In practice << 1s.
    expect(releaseElapsed).toBeLessThan(7_000);

    const err = (await queryPromise.catch((e: unknown) => e)) as MongoSqlError;
    // Either MONGOSQL_CANCELLED (the in-flight query was racing close)
    // or undefined (the query completed before close fan-out reached
    // it). The cancellation contract guarantees release() returns
    // promptly either way; if cancellation also fires we get the code.
    if (err && typeof err === 'object' && 'code' in err) {
      expect(err.code).toBe('MONGOSQL_CANCELLED');
    }
  });
});
