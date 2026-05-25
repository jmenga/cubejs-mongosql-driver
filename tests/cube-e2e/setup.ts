/**
 * Vitest globalSetup for IMPLEMENTATION_PLAN T19 — E2E against the
 * cubejs/cube image extended with our driver.
 *
 * Steps (idempotent):
 *   1. Run `examples/docker/build-driver.sh` to produce dist/ and
 *      stage `examples/docker/pkg/mongosql-cubejs-driver-*.tgz`. The
 *      tarball is what the Dockerfile's `npm install` step consumes.
 *      The Rust .node binary is rebuilt INSIDE the docker image — we
 *      don't host-build it, because cross-compiling darwin → linux
 *      requires `cross` which isn't part of the dev setup.
 *   2. `docker compose build` the cube image. First run takes ~3-5 min
 *      (Rust compile from scratch); cached layers reuse it.
 *   3. `docker compose up -d` to start atlas-local + cube.
 *   4. Wait for atlas-local healthy, `__sql_schemas` populated, and
 *      Cube `/readyz` returning 200.
 *   5. On teardown, `down -v` by default (destroys named volumes). The
 *      atlas-local image bakes its randomly-generated container hostname
 *      into the persisted replSet config on first start; preserving
 *      `/data/db` across `down` + `up` causes the next start to land in
 *      "node is not in primary or recovering state" and block
 *      `__sql_schemas` queries. Same root cause and mitigation as
 *      `tests/integration/setup.ts`.
 *
 * Tear-down policy mirrors `tests/integration/setup.ts` —
 * `CUBE_E2E_TEARDOWN=keep` skips teardown, `=stop` does `down` (no -v)
 * if you trust the replSet hostname will be stable across recreates;
 * default `destroy` does `down -v`.
 */
import { execSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'examples', 'docker', 'docker-compose.yaml');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'examples', 'docker', 'build-driver.sh');

function compose(...args: string[]): void {
  const r = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} exited ${r.status}`);
  }
}

async function waitForHealthy(service: string, maxSeconds: number): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(`docker compose -f ${COMPOSE_FILE} ps --format json ${service}`, {
        encoding: 'utf-8',
        cwd: REPO_ROOT,
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
  // Critic v3 — Issue #2: we expect at least four schemas now
  // (users, accounts, orders, revenue_events). atlas-local runs init
  // scripts on FIRST volume init only, so on existing volumes the new
  // `revenue_events` row won't appear via the auto-run path. We poll
  // for the higher count and then call `reseed()` to upsert the new
  // schema (and collection) regardless of volume state.
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `docker compose -f ${COMPOSE_FILE} exec -T atlas-local mongosh --quiet -u admin -p admin --authenticationDatabase admin --eval 'db.getSiblingDB("mongosql_test").getCollection("__sql_schemas").countDocuments()'`,
        { encoding: 'utf-8', cwd: REPO_ROOT },
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
 * Re-run the seed scripts inside atlas-local. atlas-local only auto-
 * runs `/docker-entrypoint-initdb.d/*.js` on first volume init, so
 * existing volumes won't pick up seed changes (e.g. the new
 * `revenue_events` collection added for Critic v3 — Issue #2). Calling
 * `mongosh ... --file` against the already-mounted scripts re-applies
 * them. The scripts are written to be idempotent (`countDocuments() ===
 * 0` guards for inserts; `replaceOne({_id}, ..., {upsert: true})` for
 * the schema registrations) so re-running is safe and a no-op on
 * fresh volumes.
 */
function reseed(): void {
  // Idempotent re-seed of all four initdb scripts. atlas-local only runs
  // these once on volume init; we re-run them on every setup so a
  // pre-existing volume picks up newly-added rows (e.g. the secondary
  // database introduced with Gap 8).
  const scripts = [
    '/docker-entrypoint-initdb.d/01-seed-data.js',
    '/docker-entrypoint-initdb.d/02-seed-schemas.js',
    '/docker-entrypoint-initdb.d/03-seed-secondary-data.js',
    '/docker-entrypoint-initdb.d/04-seed-secondary-schemas.js',
  ];
  for (const script of scripts) {
    const r = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        'atlas-local',
        'mongosh',
        '--quiet',
        '-u',
        'admin',
        '-p',
        'admin',
        '--authenticationDatabase',
        'admin',
        '--file',
        script,
      ],
      { stdio: 'inherit', cwd: REPO_ROOT },
    );
    if (r.status !== 0) {
      throw new Error(`reseed: ${script} exited ${r.status}`);
    }
  }
}

async function waitForSchemaIncludesSeededCollections(maxSeconds = 30): Promise<void> {
  // List of schema rows the cube-e2e suite REQUIRES to be present in
  // `__sql_schemas` before we let Cube come up. Each entry corresponds
  // to a cube model under `examples/docker/cube/model/` that the test
  // suite issues queries against. Failing to wait for any of these
  // would let Cube come up with that cube failing to compile (a
  // missing schema means mongosql can't resolve `sql_table`), which
  // surfaces as a cryptic /meta 500.
  //
  // Newly added (Gaps 4 / 6 / 7 / 10):
  //   - product_catalog (Gap 4)
  //   - granular_events (Gap 6)
  //   - tz_events       (Gap 7)
  //   - weird_types     (Gap 10)
  const required = ['revenue_events', 'configs', 'product_catalog', 'granular_events', 'tz_events', 'weird_types'];
  const inList = required.map((id) => JSON.stringify(id)).join(', ');
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `docker compose -f ${COMPOSE_FILE} exec -T atlas-local mongosh --quiet -u admin -p admin --authenticationDatabase admin --eval 'db.getSiblingDB("mongosql_test").getCollection("__sql_schemas").countDocuments({_id: {$in: [${inList}]}})'`,
        { encoding: 'utf-8', cwd: REPO_ROOT },
      ).trim();
      const n = parseInt(out, 10);
      if (n >= required.length) {
        // Also wait for the secondary-database schema (Gap 8 multi-tenant).
        // We don't fold it into the same in-list because it lives in a
        // different DB (`mongosql_test_secondary`).
        await waitForSecondaryDbSchema(maxSeconds);
        return;
      }
    } catch {
      // ignore
    }
    await sleep(1500);
  }
  throw new Error(
    `expected ${required.length} schema rows (${required.join(', ')}) but they never appeared after reseed`,
  );
}

async function waitForSecondaryDbSchema(maxSeconds: number): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `docker compose -f ${COMPOSE_FILE} exec -T atlas-local mongosh --quiet -u admin -p admin --authenticationDatabase admin --eval 'db.getSiblingDB("mongosql_test_secondary").getCollection("__sql_schemas").countDocuments({_id: "orders_secondary"})'`,
        { encoding: 'utf-8', cwd: REPO_ROOT },
      ).trim();
      const n = parseInt(out, 10);
      if (n >= 1) return;
    } catch {
      // ignore
    }
    await sleep(1500);
  }
  throw new Error(
    'expected `mongosql_test_secondary.__sql_schemas` to contain the `orders_secondary` row (Gap 8 multi-tenant)',
  );
}

async function waitForCubeReady(maxSeconds = 120): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:4000/readyz');
      if (res.ok) return;
    } catch {
      // not yet listening
    }
    await sleep(2000);
  }
  throw new Error(`Cube /readyz did not return 200 within ${maxSeconds}s`);
}

export default async function setup(): Promise<() => Promise<void>> {
  // Default to `destroy` so subsequent runs start from a fresh replica-set
  // state. atlas-local embeds the randomly-generated container hostname
  // into the persisted replSet config; preserving `/data/db` (and even
  // `/data/configdb`) across container recreates results in "node is not
  // in primary or recovering state" on the next start, blocking
  // `__sql_schemas` queries. Match `tests/integration/setup.ts`. Set
  // `CUBE_E2E_TEARDOWN=keep` for iterative dev, `=stop` if you trust
  // your replSet hostname stability.
  const teardownMode = process.env.CUBE_E2E_TEARDOWN ?? 'destroy';

  console.log('cube-e2e setup: building driver tarball (build-driver.sh)...');
  const buildResult = spawnSync('bash', [BUILD_SCRIPT], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (buildResult.status !== 0) {
    throw new Error(`build-driver.sh exited ${buildResult.status}`);
  }

  console.log('cube-e2e setup: docker compose build (Rust + Node, ~3-5 min cold)...');
  compose('build');

  console.log('cube-e2e setup: docker compose up -d');
  compose('up', '-d');

  await waitForHealthy('atlas-local', 180);
  console.log('cube-e2e setup: atlas-local healthy');

  await waitForSqlSchemas();
  console.log('cube-e2e setup: __sql_schemas populated');

  // Re-run seed scripts so existing volumes pick up newly-added
  // collections/schemas. The scripts are idempotent; on fresh volumes
  // this is a no-op (initdb has already applied them and the inserts
  // guard on `countDocuments() === 0`).
  console.log('cube-e2e setup: re-applying seed scripts (idempotent)...');
  reseed();
  await waitForSchemaIncludesSeededCollections();
  console.log('cube-e2e setup: revenue_events + configs schema rows confirmed');

  await waitForCubeReady(180);
  console.log('cube-e2e setup: cube /readyz green');

  return async () => {
    if (teardownMode === 'keep') {
      console.log('cube-e2e teardown: keeping compose stack (CUBE_E2E_TEARDOWN=keep)');
      return;
    }
    console.log(`cube-e2e teardown: stopping (mode=${teardownMode})...`);
    try {
      if (teardownMode === 'destroy') {
        compose('down', '-v');
      } else {
        compose('down');
      }
    } catch (err) {
      // Don't throw from teardown — masks the underlying test failure.
      console.error('cube-e2e teardown error (ignored):', err);
    }
  };
}
