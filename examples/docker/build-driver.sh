#!/usr/bin/env bash
# Build the driver and stage the npm-pack tarball into examples/docker/pkg/
# so the Dockerfile's `COPY pkg /tmp/pkg` step can install it.
#
# Usage: examples/docker/build-driver.sh [--skip-rust]
#
# This script is invoked by the T19 E2E test (`tests/integration/cube-e2e.test.ts`)
# via the integration setup helper, but is safe to run manually.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PKG_DIR="${SCRIPT_DIR}/pkg"

cd "${REPO_ROOT}"

# We don't need a host-built .node binary — the Docker builder stage
# rebuilds the native binary inside the image (Linux target). We DO
# need `dist/` to exist so `npm pack` includes it.

echo "==> tsc build (dist/)"
pnpm exec tsc -p tsconfig.build.json

echo "==> npm pack"
mkdir -p "${PKG_DIR}"
rm -f "${PKG_DIR}"/cubejs-mongosql-driver-*.tgz
TARBALL="$(npm pack --silent)"
mv "${REPO_ROOT}/${TARBALL}" "${PKG_DIR}/"
echo "    -> ${PKG_DIR}/${TARBALL}"

echo "==> done"
