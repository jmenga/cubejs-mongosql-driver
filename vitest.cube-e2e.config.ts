import { defineConfig } from 'vitest/config';

// Vitest config dedicated to the IMPLEMENTATION_PLAN T19 E2E test:
// brings up the cubejs/cube + atlas-local stack defined in
// `examples/docker/docker-compose.yaml`, hits the Cube HTTP API, and
// tears down. Kept separate from the unit (`vitest.config.ts`) and
// integration (`vitest.integration.config.ts`) configs so that:
//
//   * The integration globalSetup (which binds 27017 for atlas-local in
//     the unit-integration compose) does NOT run alongside the E2E
//     compose (which also binds 27017). Running both at once would
//     race on the host port.
//   * `pnpm test:cube-e2e` is its own pnpm script and CI job — failures
//     here don't shadow the integration suite.
export default defineConfig({
  test: {
    include: ['tests/cube-e2e/**/*.test.ts'],
    environment: 'node',
    // Image build + cube boot both take time; budget generously.
    testTimeout: 180_000,
    hookTimeout: 600_000,
    globalSetup: ['./tests/cube-e2e/setup.ts'],
    fileParallelism: false,
  },
});
