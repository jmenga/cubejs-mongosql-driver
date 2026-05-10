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

  // eslint-disable-next-line no-console
  console.log('cube-e2e setup: building driver tarball (build-driver.sh)...');
  const buildResult = spawnSync('bash', [BUILD_SCRIPT], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (buildResult.status !== 0) {
    throw new Error(`build-driver.sh exited ${buildResult.status}`);
  }

  // eslint-disable-next-line no-console
  console.log('cube-e2e setup: docker compose build (Rust + Node, ~3-5 min cold)...');
  compose('build');

  // eslint-disable-next-line no-console
  console.log('cube-e2e setup: docker compose up -d');
  compose('up', '-d');

  await waitForHealthy('atlas-local', 180);
  // eslint-disable-next-line no-console
  console.log('cube-e2e setup: atlas-local healthy');

  await waitForSqlSchemas();
  // eslint-disable-next-line no-console
  console.log('cube-e2e setup: __sql_schemas populated');

  await waitForCubeReady(180);
  // eslint-disable-next-line no-console
  console.log('cube-e2e setup: cube /readyz green');

  return async () => {
    if (teardownMode === 'keep') {
      // eslint-disable-next-line no-console
      console.log('cube-e2e teardown: keeping compose stack (CUBE_E2E_TEARDOWN=keep)');
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`cube-e2e teardown: stopping (mode=${teardownMode})...`);
    try {
      if (teardownMode === 'destroy') {
        compose('down', '-v');
      } else {
        compose('down');
      }
    } catch (err) {
      // Don't throw from teardown — masks the underlying test failure.
      // eslint-disable-next-line no-console
      console.error('cube-e2e teardown error (ignored):', err);
    }
  };
}
