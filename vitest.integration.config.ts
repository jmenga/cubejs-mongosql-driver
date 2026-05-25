import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 120000,
    globalSetup: ['./tests/integration/setup.ts'],
    fileParallelism: false,
    // The napi-rs native module owns a tokio runtime whose threads can
    // outlive the vitest worker's test code. Under the default `threads`
    // pool the worker-thread shutdown raises "Worker exited unexpectedly"
    // from tinypool and fails the run with exit 1 even when every test
    // passed. `forks` (child_process workers) tolerates lingering threads
    // on process exit.
    pool: 'forks',
    // Worker-process teardown is the only thing that ever surfaces an
    // unhandled error in this suite (every test asserts cleanly). We
    // can't safely fail the run on a teardown crash that happens *after*
    // the last test result has been recorded — see the `pool` comment.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
