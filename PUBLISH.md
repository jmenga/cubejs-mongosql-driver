# Publishing

This package ships to npm as **`@effectuate/cubejs-mongosql-driver`**, plus six
prebuilt-binary sub-packages — one per supported target:

| npm package | Target triple |
|---|---|
| `@effectuate/cubejs-mongosql-driver-linux-x64-gnu` | `x86_64-unknown-linux-gnu` |
| `@effectuate/cubejs-mongosql-driver-linux-arm64-gnu` | `aarch64-unknown-linux-gnu` |
| `@effectuate/cubejs-mongosql-driver-linux-x64-musl` | `x86_64-unknown-linux-musl` |
| `@effectuate/cubejs-mongosql-driver-linux-arm64-musl` | `aarch64-unknown-linux-musl` |
| `@effectuate/cubejs-mongosql-driver-darwin-x64` | `x86_64-apple-darwin` |
| `@effectuate/cubejs-mongosql-driver-darwin-arm64` | `aarch64-apple-darwin` |

The main package's `optionalDependencies` references each sub-package by name +
version. At install time, npm picks the one matching `process.platform` /
`process.arch` (and `libc` for linux); the loader in `index.js` requires it at
runtime.

Versioning uses [Changesets](https://github.com/changesets/changesets);
publishing runs automatically on push to `main` via
`.github/workflows/release.yml`. Authentication uses
[**Trusted Publishing**](https://docs.npmjs.com/trusted-publishers) — short-lived
OIDC tokens minted per-run by GitHub Actions. No `NPM_TOKEN` secret.

## Day-to-day flow

1. **Branch off `main`** and make your changes.

2. **Add a changeset** describing what changed:

   ```bash
   pnpm changeset
   ```

   Pick `patch` / `minor` / `major`, write a one-line summary. The CLI writes
   `.changeset/<slug>.md`.

3. **Consume it in the same branch** to bump version + regenerate `CHANGELOG.md`:

   ```bash
   pnpm version       # = changeset version
   ```

   This rewrites `package.json`, every `npm/*/package.json`, and `CHANGELOG.md`,
   and deletes the consumed `.changeset/<slug>.md`.

4. **Commit both edits together**, push, open PR.

5. **CI runs** (`.github/workflows/ci.yml`):
   - Lint (biome + cargo fmt + clippy)
   - Build (Rust host target + TypeScript)
   - Type check
   - Rust + TS unit + TS integration + cube-e2e tests
   - **Enforces** that any release-declaring changesets have been consumed in
     the same PR (no follow-up bot PRs).
   - **Requires** either a changeset or a version bump from base.

6. **Merge to `main`**. Release workflow takes over.

## What the release workflow does

`.github/workflows/release.yml` on push to `main`:

1. **Detect** — compares `package.json` version against
   `npm view @effectuate/cubejs-mongosql-driver@latest version`. If unchanged,
   exits early (a chore PR with no version bump).

2. **Build matrix** — parallel jobs across all six targets, each runs
   `napi build --release --target <triple>`. Linux arm64 + musl targets use
   `cross` for cross-compilation; macOS targets use native runners
   (`macos-13` for x64, `macos-14` for arm64). Each job uploads its `.node`
   binary as a GitHub artifact.

3. **Publish** — combine job downloads all artifacts, stages each into the
   right `npm/<triple>/` directory, then publishes:
   - Sub-packages first (six `npm publish --provenance --access public`).
   - Main package second. **Order matters** — the main package's
     `optionalDependencies` resolve only after the sub-packages exist on the
     registry.

4. **Tag + GitHub Release** — `vX.Y.Z` annotated tag pushed to `main`, GH
   Release created with auto-generated notes (`--notes-start-tag` linking back
   to the previous release).

## One-time npm setup

Before the first release, both the npm scope and each package must exist on
the registry, and each package must be configured to trust this repo +
workflow:

### 1. Create the `effectuate` npm org

Sign in at <https://www.npmjs.com> as `jmenga` and create the
[**`effectuate`**](https://www.npmjs.com/org/create) organization.

### 2. First publish for each of the 7 packages

Trusted Publishing requires the package to exist on npm before OIDC trust can
be configured. Bootstrap by publishing manually once:

```bash
npm login                            # interactive, with 2FA OTP
pnpm install
pnpm build                           # Rust host + TS
# Stage prebuilts you have locally; for a full first release, run the
# full matrix locally OR cherry-pick a single platform and publish from
# the release workflow after configuring Trusted Publishing.
cd npm/linux-x64-gnu && npm publish --access public --otp <code>
# … repeat for each sub-package …
cd ../.. && npm publish --access public --otp <code>
```

(Alternatively: create a one-time npm
[granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
scoped to `@effectuate/*` write, plug it into the workflow via the `NPM_TOKEN`
env var for the first run, then revoke it after step 3.)

### 3. Configure Trusted Publishing per package

For each of the 7 packages, visit
`https://www.npmjs.com/package/@effectuate/<name>/access` and add a Trusted
Publisher:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `jmenga` |
| Repository | `cubejs-mongosql-driver` |
| Workflow filename | `release.yml` |
| Environment name | (leave blank) |

After this, every CI release run mints a per-run OIDC token; no long-lived
secret needs to live in GitHub.

## Manual publishing (if needed)

```bash
git checkout main && git pull --ff-only
pnpm changeset                       # if no changeset yet
pnpm version                         # consume changesets
git commit -am "chore: version packages"
pnpm install --frozen-lockfile=false # refresh lockfile
pnpm build                           # Rust host target + TS
# Build other targets locally if shipping multi-platform manually
# (otherwise rely on the release workflow).
pnpm release                         # build + changeset publish
git push --follow-tags
```

Trusted Publishing is CI-only — local publish still needs `npm login` + 2FA.

## Adding or dropping a platform

To add a target (e.g. `aarch64-pc-windows-msvc`):

1. Add to `package.json` → `napi.triples.additional`.
2. Add to `package.json` → `optionalDependencies`.
3. Create `npm/<short>/package.json` (mirror an existing one — adjust `os`,
   `cpu`, `libc`).
4. Add a matrix entry to `.github/workflows/release.yml` `build.strategy.matrix.settings`.
5. Configure the new sub-package on npm (steps 2 + 3 above).

To drop a target: reverse the above. Existing published sub-packages stay on
the registry — they just stop receiving updates.
