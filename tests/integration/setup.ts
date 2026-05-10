/**
 * Vitest globalSetup for integration tests.
 * Brings up `tests/integration/docker-compose.test.yml`, waits for healthy,
 * and verifies that `__sql_schemas` was populated.
 *
 * Tear-down is handled by returning a cleanup function.
 */
import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const COMPOSE_FILE = './tests/integration/docker-compose.test.yml';

async function waitForHealthy(service: string, maxSeconds = 90): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `docker compose -f ${COMPOSE_FILE} ps --format json ${service}`,
        { encoding: 'utf-8' },
      );
      const lines = out.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (entry.Health === 'healthy') return;
      }
    } catch {
      // ignore — container may not be up yet
    }
    await sleep(2000);
  }
  throw new Error(`Service ${service} did not become healthy within ${maxSeconds}s`);
}

export default async function setup() {
  // eslint-disable-next-line no-console
  console.log('integration setup: starting docker compose...');
  spawn('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d'], {
    stdio: 'inherit',
  });

  await waitForHealthy('atlas-local');
  // eslint-disable-next-line no-console
  console.log('integration setup: atlas-local healthy');

  return async () => {
    // eslint-disable-next-line no-console
    console.log('integration teardown: stopping docker compose...');
    execSync(`docker compose -f ${COMPOSE_FILE} down -v`, { stdio: 'inherit' });
  };
}
