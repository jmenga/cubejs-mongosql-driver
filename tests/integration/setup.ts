/**
 * Vitest globalSetup for integration tests.
 *
 * Brings up `tests/integration/docker-compose.test.yml`, waits for atlas-local
 * to be healthy AND for `__sql_schemas` to be populated, and exports a default
 * `TEST_MONGO_URI` for tests that don't set one.
 *
 * Tear-down: by default we destroy volumes (`down -v`) so the next run
 * starts from a fresh replica-set state. The atlas-local image embeds the
 * randomly-generated container hostname into the persisted replSet config —
 * preserving `/data/db` across container recreates results in
 * "replica set config is invalid or we are not a member of it" on the next
 * start, followed by mongod shutdown. Skipping the ~30 s replicaset bootstrap
 * on subsequent runs is not safe.
 *
 * Set `INTEGRATION_TEARDOWN=keep` to leave containers running between runs
 * (useful for iterative test development — pair with `make e2e:up`).
 * Set `INTEGRATION_TEARDOWN=stop` to keep volumes (not recommended; see above).
 *
 * Required env (with sensible defaults):
 *   - TEST_MONGO_URI       default: admin/admin@localhost:27017 directConnection
 *   - INTEGRATION_TEARDOWN default: 'destroy' ('keep' | 'stop' | 'destroy')
 */
import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const COMPOSE_FILE = './tests/integration/docker-compose.test.yml';
const DEFAULT_URI = 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true';

async function waitForHealthy(service: string, maxSeconds = 180): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(`docker compose -f ${COMPOSE_FILE} ps --format json ${service}`, {
        encoding: 'utf-8',
      });
      const lines = out.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (entry.Health === 'healthy') return;
      }
    } catch {
      // container may not be up yet
    }
    await sleep(2000);
  }
  throw new Error(`Service ${service} did not become healthy within ${maxSeconds}s`);
}

async function waitForSqlSchemas(maxSeconds = 60): Promise<void> {
  // mongodb-atlas-local runs init scripts asynchronously after the healthcheck
  // first reports green — poll __sql_schemas until it's seeded.
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `docker compose -f ${COMPOSE_FILE} exec -T atlas-local mongosh --quiet -u admin -p admin --authenticationDatabase admin --eval 'db.getSiblingDB("mongosql_test").getCollection("__sql_schemas").countDocuments()'`,
        { encoding: 'utf-8' },
      ).trim();
      const n = parseInt(out, 10);
      if (Number.isFinite(n) && n >= 3) return;
    } catch {
      // mongosh may not be ready yet
    }
    await sleep(2000);
  }
  throw new Error(`__sql_schemas was not populated within ${maxSeconds}s`);
}

/**
 * Re-apply seed scripts so existing volumes pick up new collections /
 * schema rows. The scripts are idempotent (insert guards on
 * `countDocuments() === 0`; schema upserts via `replaceOne(..., {upsert:
 * true})`), so re-running is safe even on freshly-initialized volumes.
 * Without this the cube-e2e + integration suites would silently miss
 * the newly-seeded `revenue_events` collection added in Critic v3 —
 * Issue #2 if the user's existing `atlas-data` volume predates the seed
 * change.
 */
function reseed(): void {
  // All four initdb scripts. atlas-local runs these on first volume
  // init; we re-run each setup so pre-existing volumes pick up newly
  // added collections (e.g. the `mongosql_test_secondary` Gap 8
  // tenant).
  const scripts = [
    '/docker-entrypoint-initdb.d/01-seed-data.js',
    '/docker-entrypoint-initdb.d/02-seed-schemas.js',
    '/docker-entrypoint-initdb.d/03-seed-secondary-data.js',
    '/docker-entrypoint-initdb.d/04-seed-secondary-schemas.js',
  ];
  for (const script of scripts) {
    execSync(
      `docker compose -f ${COMPOSE_FILE} exec -T atlas-local mongosh --quiet -u admin -p admin --authenticationDatabase admin --file ${script}`,
      { stdio: 'inherit' },
    );
  }
}

export default async function setup() {
  if (!process.env.TEST_MONGO_URI) process.env.TEST_MONGO_URI = DEFAULT_URI;

  const teardownMode = process.env.INTEGRATION_TEARDOWN ?? 'destroy';

  console.log('integration setup: starting docker compose...');
  spawn('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d'], { stdio: 'inherit' });

  await waitForHealthy('atlas-local');
  console.log('integration setup: atlas-local healthy');

  await waitForSqlSchemas();
  console.log('integration setup: __sql_schemas populated');

  // Re-apply seeds (idempotent) so pre-existing volumes pick up new
  // collections (revenue_events). On a fresh volume the initdb path
  // already ran them; this is a no-op there.
  console.log('integration setup: re-applying seed scripts (idempotent)...');
  reseed();

  return async () => {
    if (teardownMode === 'keep') {
      console.log('integration teardown: keeping compose stack (INTEGRATION_TEARDOWN=keep)');
      return;
    }
    console.log(`integration teardown: stopping docker compose (mode=${teardownMode})...`);
    const cmd =
      teardownMode === 'destroy'
        ? `docker compose -f ${COMPOSE_FILE} down -v`
        : `docker compose -f ${COMPOSE_FILE} down`;
    execSync(cmd, { stdio: 'inherit' });
  };
}
