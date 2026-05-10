# syntax=docker/dockerfile:1.6
#
# Cube image extended with cubejs-mongosql-driver.
#
# Strategy:
#   * Stage 1 (`builder`): native-Linux Rust toolchain compiles the
#     napi-rs `.node` binary INSIDE the image. We can't ship a host-built
#     darwin-arm64 .node into a Linux container, and we can't rely on
#     prebuilt npm sub-packages until T21 publishes them. Building inside
#     the image avoids cross-compile setup on the host.
#   * Stage 2 (final): `FROM cubejs/cube:v1.6.x` + the npm pack tarball +
#     the freshly built `.node`. Files outside `dist/` (the napi loader
#     `index.js`/`index.d.ts`) aren't included in the published tarball
#     yet (T18 follow-up), so we copy them in by hand.
#
# Cube driver-name resolution (verified against
# `packages/cubejs-server-core/src/core/DriverResolvers.ts` at v1.6.44):
#   `CUBEJS_DB_TYPE=<type>` is fed through `driverDependencies(<type>)`,
#   which checks (in order):
#     1. The closed `DriverDependencies` map — `mongosql` is NOT listed.
#     2. `@cubejs-backend/${type}-driver` — we are not under that scope.
#     3. `${type}-cubejs-driver` — our package is `cubejs-mongosql-driver`.
#   None match. We bypass the lookup entirely with a custom `cube.js`
#   `driverFactory` that explicitly `require()`s our package — see
#   `cube/cube.js`. This is the same approach Cube documents for any
#   community/third-party driver not yet in the closed map.

ARG CUBE_VERSION=v1.6.44
ARG TARGETARCH

###############################################################################
# Stage 1 — build the napi-rs native binary inside the image                  #
###############################################################################
FROM node:22-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
      pkg-config \
      libssl-dev \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    # 1.85+ required: a transitive dep (`idna_adapter` 1.2.x) declares
    # `edition = "2024"`. Bumped from 1.83 (the host project's pin) to
    # the latest stable available at the time T19 was written.
    RUST_VERSION=1.89.0

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION} \
    && rustup --version && cargo --version && rustc --version

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /build

# Build context is the repo root (set in docker-compose.yaml). Copy
# only what's needed for the native build — keeping the COPY layers
# tight lets Docker cache the dep fetch step independently.
COPY package.json pnpm-lock.yaml ./
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Install dev deps (napi cli, typescript). `--no-frozen-lockfile` is
# used because `optionalDependencies` (the per-platform npm sub-package
# stubs added in T18) aren't in the committed pnpm-lock.yaml yet —
# they'd need a `pnpm install` refresh which is out of T19's scope.
# The optional sub-packages are not required by the build (they only
# matter post-publish for prebuilt-binary distribution), so install
# proceeds fine without them.
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Build the .node binary in release mode for the container's native arch
# (arm64 or amd64 — matches the docker buildx target).
#
# Known napi-rs CLI 2.18.4 quirk (documented in T10's discoveries +
# T18's `Stayed on @napi-rs/cli@2.18.4`): cargo emits the dylib as
# `libcubejs_mongosql_driver_native.{so,dylib}` (underscores from
# cargo's normalisation) but the napi CLI looks for the hyphenated
# form `libcubejs-mongosql-driver-native.{so,dylib}` matching the
# `name` field. The first `napi build` therefore fails with ENOENT
# during its post-cargo copy step. We pre-empt by running the cargo
# build directly, then aliasing the artefact, then re-invoking
# `napi build` so its post-cargo file move succeeds (the cargo step
# is now a no-op rebuild against the warm target/).
RUN cargo build --release -p cubejs-mongosql-driver-native --manifest-path crates/native/Cargo.toml \
    && cp target/release/libcubejs_mongosql_driver_native.so target/release/libcubejs-mongosql-driver-native.so \
    && pnpm exec napi build --platform --release \
        --cargo-cwd crates/native \
        --cargo-name cubejs-mongosql-driver-native \
        -p cubejs-mongosql-driver-native

# Build the TypeScript dist/.
RUN pnpm exec tsc -p tsconfig.build.json

# Sanity check: list produced artefacts.
RUN ls -la /build/*.node /build/index.js /build/index.d.ts /build/dist


###############################################################################
# Stage 2 — extend cubejs/cube and install the driver                         #
###############################################################################
FROM cubejs/cube:${CUBE_VERSION}

# /cube/conf is the documented mount point for cube.js + model files.
WORKDIR /cube/conf

# Copy the npm-pack tarball produced by the build script. The tarball
# carries `dist/`, `package.json`, README, LICENSE — but not the napi
# loader (root `index.js`/`index.d.ts`) nor the .node binary, both of
# which are excluded by `package.json#files`. We add them manually
# below.
# Path relative to the repo-root build context.
COPY examples/docker/pkg/cubejs-mongosql-driver-*.tgz /tmp/

# Install the tarball into /cube/conf/node_modules. `npm install --no-save`
# avoids editing any package.json.
RUN cd /cube/conf \
    && npm init -y >/dev/null \
    && npm install --no-save /tmp/cubejs-mongosql-driver-*.tgz

# Create an alias install at `mongosql-cubejs-driver` so Cube's
# `packageExists('${dbType}-cubejs-driver')` resolution path
# (`@cubejs-backend/server-core`'s DriverResolvers.ts) finds *something*.
# Required because `OptsHandler.getDriverConcurrency` (v1.6.44 OptsHandler.ts:288)
# calls `lookupDriverClass(dbType)` UNCONDITIONALLY — even when the user
# sets `driverFactory`/`dialectFactory` in cube.js. The alias is a copy
# (not a symlink, because `require.resolve` of a relative `index.js`
# inside a symlinked dir + the napi loader's `..` path arithmetic
# resolves to the real path, not the alias path, so the loader still
# finds the .node binary). The actual driver/dialect instances Cube
# uses come from cube.js's factories, not this alias.
RUN cp -r /cube/conf/node_modules/cubejs-mongosql-driver \
         /cube/conf/node_modules/mongosql-cubejs-driver

# Splice in the napi loader + native binary that the tarball misses.
# Path the loader expects at runtime:
#   /cube/conf/node_modules/cubejs-mongosql-driver/index.js
#   /cube/conf/node_modules/cubejs-mongosql-driver/index.d.ts
#   /cube/conf/node_modules/cubejs-mongosql-driver/cubejs-mongosql-driver-native.<triple>.node
#
# `dist/src/native.js` does `require('../../index.js')` first then
# `require('../index.js')` — copying to the package root satisfies the
# second branch (consumed via `dist/index.js` → `dist/src/native.js`).
COPY --from=builder /build/index.js     /cube/conf/node_modules/cubejs-mongosql-driver/index.js
COPY --from=builder /build/index.d.ts   /cube/conf/node_modules/cubejs-mongosql-driver/index.d.ts
COPY --from=builder /build/cubejs-mongosql-driver-native.*.node \
                   /cube/conf/node_modules/cubejs-mongosql-driver/

# Mirror the same files into the alias install so its native loader
# can find the .node binary. Cube only needs the constructor surface
# (`MongoSqlDriver` from dist/MongoSqlDriver.js) for the concurrency
# probe, but `lookupDriverClass` does `require()` the package's
# `main`, which transitively loads the native binary.
COPY --from=builder /build/index.js     /cube/conf/node_modules/mongosql-cubejs-driver/index.js
COPY --from=builder /build/index.d.ts   /cube/conf/node_modules/mongosql-cubejs-driver/index.d.ts
COPY --from=builder /build/cubejs-mongosql-driver-native.*.node \
                   /cube/conf/node_modules/mongosql-cubejs-driver/

# Drop the cube.js + model in place. These are bind-mounted at run time
# in docker-compose for iterative dev, but baking them in lets
# `docker run` work standalone too.
COPY examples/docker/cube/cube.js  /cube/conf/cube.js
COPY examples/docker/cube/model    /cube/conf/model

# /cube/conf/.env is generated by env vars at run time — nothing to
# bake. Cube's default entrypoint reads CUBEJS_* from the process env.

EXPOSE 4000
