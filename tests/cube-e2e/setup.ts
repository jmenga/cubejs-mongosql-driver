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
 *   5. On teardown, `down` (no -v) — preserves the seeded volume so
 *      iterative runs skip the ~30 s mongod-replicaset bootstrap.
 *
 * Tear-down policy mirrors `tests/integration/setup.ts` —
 * `CUBE_E2E_TEARDOWN=destroy` for `down -v`, `keep` to skip teardown,
 * default `stop`.
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
  const scripts = ['/docker-entrypoint-initdb.d/01-seed-data.js', '/docker-entrypoint-initdb.d/02-seed-schemas.js'];
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

async function waitForSchemaIncludesRevenueEvents(maxSeconds = 30): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `docker compose -f ${COMPOSE_FILE} exec -T atlas-local mongosh --quiet -u admin -p admin --authenticationDatabase admin --eval 'db.getSiblingDB("mongosql_test").getCollection("__sql_schemas").countDocuments({_id: "revenue_events"})'`,
        { encoding: 'utf-8', cwd: REPO_ROOT },
      ).trim();
      const n = parseInt(out, 10);
      if (n >= 1) return;
    } catch {
      // ignore
    }
    await sleep(1500);
  }
  throw new Error('revenue_events row never appeared in __sql_schemas after reseed');
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
  const teardownMode = process.env.CUBE_E2E_TEARDOWN ?? 'stop';

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
  await waitForSchemaIncludesRevenueEvents();
  console.log('cube-e2e setup: revenue_events schema row confirmed');

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
