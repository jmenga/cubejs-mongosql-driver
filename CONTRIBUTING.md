# Contributing

Thanks for your interest in `@effectuate/cubejs-mongosql-driver`!

## Project shape

This is a hybrid TypeScript + Rust package: the public API surface is a Cube.js
data-source driver written in TS, backed by a Rust crate (compiled to a
napi-rs `.node` binary) that wraps the upstream
[`mongosql`](https://github.com/mongodb/mongosql) translator and the MongoDB
async client.

| Path | What |
|---|---|
| `src/` | TypeScript: Cube driver + dialect, config parsing, native loader |
| `crates/native/` | Rust: napi-rs bindings, SQL translation, schema introspection, pipeline rewrites |
| `tests/unit/` | TS unit tests (vitest, mocked native) |
| `tests/integration/` | TS integration tests (vitest, real atlas-local) |
| `tests/cube-e2e/` | Full Cube container + driver E2E tests |
| `examples/` | Reference Cube model + docker compose layouts |
| `npm/<triple>/` | Per-platform prebuilt binary sub-packages |

## Prerequisites

- Node 22+ (24 in CI)
- pnpm 10
- Rust stable + `rustfmt` + `clippy`
- Docker + Docker Compose (for integration / cube-e2e)

## Setup

```bash
pnpm install
pnpm build:rust:debug   # host target only — release builds happen in CI
pnpm build:ts
```

## Running tests

```bash
pnpm typecheck
pnpm lint              # biome + cargo fmt + clippy
pnpm test:unit         # vitest, no docker
cargo test --release   # Rust, no docker

# Docker-backed (bring up atlas-local automatically):
pnpm test:integration
pnpm test:cube-e2e
```

The integration + cube-e2e suites manage their own docker compose lifecycle.
Setup uses `INTEGRATION_TEARDOWN=destroy` by default — see
`tests/integration/setup.ts` for the rationale (atlas-local embeds the random
container hostname into the persisted replica-set config, so preserving the
volume across container recreates breaks the next start). To keep the stack
between runs during iterative development, set `INTEGRATION_TEARDOWN=keep`.

## Workflow

1. Branch off `main`.
2. Make your changes; add unit / integration / cube-e2e tests where applicable.
3. Run the full pyramid locally (see "Running tests" above).
4. **Add a changeset** describing what changed:
   ```bash
   pnpm changeset
   ```
   Pick `patch` / `minor` / `major`, write a one-line summary. Commit the
   generated `.changeset/<slug>.md`.
5. **Consume the changeset in the same branch** to bump the version and
   regenerate `CHANGELOG.md`:
   ```bash
   pnpm version
   ```
   This rewrites `package.json` + every `npm/*/package.json`, regenerates
   `CHANGELOG.md`, and deletes the consumed `.changeset/<slug>.md`. Commit all
   of these together.

   _Skip this step for chore / docs / refactor PRs that don't ship a release —
   add an empty changeset instead (`pnpm changeset --empty`)._

6. Push and open a PR. CI verifies lint, tests, and the changeset state.
7. After merge, the release workflow publishes the new version automatically.
   See [`PUBLISH.md`](./PUBLISH.md) for the publish flow.

## Coding conventions

- **TypeScript**: ESM, strict TypeScript, biome for lint + format.
- **Rust**: stable edition 2021, rustfmt-clean, clippy `-D warnings`.
- **Comments** carry the WHY, not the WHAT. Keep them tight; reach for them
  when a future maintainer would otherwise guess wrong.
- **Tests**: prefer integration / cube-e2e over unit when validating actual
  driver behaviour. Unit tests are valuable for dialect SQL fragments,
  config-parsing edge cases, and TS-layer plumbing that doesn't need a DB.

## Reporting issues

Open an issue at <https://github.com/jmenga/cubejs-mongosql-driver/issues>
with:

- The driver version (`@effectuate/cubejs-mongosql-driver`).
- The Cube version.
- The MongoDB version + topology (Atlas SQL endpoint? Atlas-local? Self-hosted?).
- A minimal repro — ideally the SQL the dialect emits (capture via Cube's
  `/cubejs-api/v1/sql` endpoint) AND the driver's behaviour against it.
- The exact error code (`MONGOSQL_*`) when applicable.

## Security

For security-sensitive issues, please use GitHub's
[private vulnerability reporting](https://github.com/jmenga/cubejs-mongosql-driver/security/advisories)
rather than a public issue.

## License

Apache-2.0. By contributing, you agree your contributions will be licensed
under the same terms.
