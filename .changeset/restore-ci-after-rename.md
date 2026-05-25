---
---

Restore PR CI after the v1.0.0 publish rename. No runtime changes (no
package version bump).

- `pnpm-lock.yaml`: regenerate to include the six
  `@effectuate/cubejs-mongosql-driver-*` `optionalDependencies` added in
  the publish bootstrap. `pnpm install --frozen-lockfile` (every CI
  step's prerequisite) was failing with `ERR_PNPM_OUTDATED_LOCKFILE`.
- `package.json`: add trailing newline so `biome ci` passes.
- `vitest.integration.config.ts`: switch to `pool: 'forks'`. The napi-rs
  native module's tokio runtime can't be cleanly torn down inside a
  worker thread; tinypool reported "Worker exited unexpectedly" and
  failed the run with exit 1 even when every integration test passed.
- `examples/docker/`: update `Dockerfile`, `cube/cube.js`, and
  `build-driver.sh` to reference the new scoped package name
  (`@effectuate/cubejs-mongosql-driver`, tarball
  `effectuate-cubejs-mongosql-driver-*.tgz`, install path
  `node_modules/@effectuate/cubejs-mongosql-driver/`). The cube-e2e
  Docker build was failing with `lstat /examples/docker/pkg: no such
  file or directory` because the COPY glob still matched the
  pre-rename tarball name.
