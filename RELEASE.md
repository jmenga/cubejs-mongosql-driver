# Release procedure

This document is the canonical source of truth for shipping `mongosql-cubejs-driver` to npm. The release workflow is **manually triggered by pushing a `vX.Y.Z` tag** — there is no automatic release on merge.

## Prerequisites (one-time)

1. **`NPM_TOKEN` repo secret** — automation token with `publish` scope on the `mongosql-cubejs-driver` package and each per-platform sub-package (`mongosql-cubejs-driver-darwin-arm64`, etc.). Create at <https://www.npmjs.com/settings/{user}/tokens> with type "Granular access token, automation" and grant `Read and write` on every package in scope.
2. **Repo must be PUBLIC** — `npm publish --provenance` requires a public GitHub repo to attach Sigstore-signed provenance attestations. On a private repo the publish step **silently** drops the provenance and the package ships unsigned. The preflight script (below) verifies repo visibility via `gh repo view` and fails if the repo is private.
3. **Latest `pnpm exec napi --help` reports v2.18.4** — this project pins `@napi-rs/cli@^2.18.4` and the workflow file references that surface; v3 is a breaking migration.
4. **First-time loader gap (RELEASE-BLOCKER)** — the napi-generated `index.js` / `index.d.ts` at the project root are required by `dist/native.js` (`require('../index.js')`) at runtime. They are currently `.gitignore`d AND not present in `package.json#files`. Until one of the two fixes below is applied, the published package will fail to load post-install:
   - Option A (recommended) — add a step to `.github/workflows/release.yaml`'s `publish` job that runs `pnpm build:rust --target x86_64-unknown-linux-gnu` (or any one platform) on the publish runner before `npm publish`, AND add `index.js` + `index.d.ts` to `package.json#files`.
   - Option B — commit `index.js` / `index.d.ts` to git (remove from `.gitignore`), keep them up to date manually, AND add them to `package.json#files`.

   The preflight script flags this gap; do not push a tag until it is resolved.

## Procedure

### 1. Bump version

The napi-rs CLI's `version` command **reads the version from root `package.json` (not the CLI argv)** and propagates it to the 6 per-platform `npm/<short>/package.json` stubs. To bump:

```bash
# Edit root package.json: set "version" to the target value (e.g. "0.1.0").
# Then sync the sub-packages:
pnpm exec napi version

# napi version does NOT update root.optionalDependencies — that happens at
# publish time inside `napi prepublish`. The preflight script asserts they
# match the root version manually; if you skip prepublish locally, run:
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const v = p.version;
  for (const k of Object.keys(p.optionalDependencies)) p.optionalDependencies[k] = v;
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'

# Sync Cargo workspace version:
# Edit Cargo.toml: [workspace.package] version = "<X.Y.Z>"
cargo update -p cubejs-mongosql-driver-native

git add -A
git commit -m "chore: release X.Y.Z"
```

### 2. Pre-flight

```bash
./scripts/preflight-release.sh
```

If any check fails, fix and retry. The script catches the four critic-v2 footguns:

1. **npm install resolution** — verifies `index.js` loader presence + correct sub-package name prefix
2. **Per-platform publish atomicity** — verifies `optionalDependencies` versions exactly match root
3. **`--provenance` silent failure** — verifies repo is public via `gh`
4. **Sub-package version drift** — verifies all 6 `npm/<short>/package.json` versions match root

### 3. Tag and push

```bash
git tag v0.X.Y
git push origin main v0.X.Y
```

### 4. Watch the release workflow

`.github/workflows/release.yaml` will:

1. Build napi-rs binaries for 6 platforms in parallel (`build` matrix). Each job uploads its `.node` as a workflow artifact.
2. The `publish` job:
   1. Downloads all artifacts.
   2. Runs `pnpm build:ts`.
   3. `napi prepublish` — copies each `.node` into its matching `npm/<short>/`, rewrites `npm/<short>/package.json` with the root version + binary path, and rewrites root `optionalDependencies` to pin the just-built sub-package versions.
   4. Publishes each `mongosql-cubejs-driver-<short>` sub-package to npm with `--provenance`.
   5. Publishes the root `mongosql-cubejs-driver` package with `--provenance`.
   6. Creates a GitHub Release with all `.node` files attached.

**If a per-platform publish fails**, the loop in `release.yaml` continues to the next platform (treats "already published" as non-fatal). The root publish step still runs. This means the root's `optionalDependencies` could point at a sub-package version that npm doesn't have — `npm install` on a user's machine would log a warning like:

```
npm warn optional dep failed, continuing mongosql-cubejs-driver-linux-x64-gnu@0.1.0
```

…and the loader at runtime would fall back to `loadError` with no working binary. **This is critic v2 risk #2.** Mitigation: watch the workflow log; if any sub-package failed, manually re-trigger the failed job via `workflow_dispatch` once the underlying issue is fixed, before announcing the release.

### 5. Post-release verification

On a clean machine matching one of the published platforms:

```bash
mkdir /tmp/install-check && cd /tmp/install-check
npm init -y
npm install mongosql-cubejs-driver@0.X.Y
node -e "const { MongoSqlDriver } = require('mongosql-cubejs-driver'); console.log(MongoSqlDriver);"
```

Expected: prints `[class MongoSqlDriver extends BaseDriver]`. The platform-specific `.node` is auto-installed via `optionalDependencies` and resolved by the root `index.js`.

If you see `Cannot find module '../index.js'`, the prerequisite #4 ("first-time loader gap") was not applied.

If you see `Failed to load native binding`, the matching `optionalDependencies` package failed to install — check `npm install` output for an `optional dep failed` warning.

### 6. Submit to Cube's third-party drivers list

Open a PR against <https://github.com/cube-js/cube> modifying `docs/pages/product/configuration/data-sources` (path may have shifted upstream — see the existing community-drivers list for the right file). Add `mongosql-cubejs-driver` with a one-line description, link to this repo, and call out the MongoDB driver-name resolution convention (`CUBEJS_DB_TYPE=mongosql` resolves to `mongosql-cubejs-driver` via Cube's `${dbType}-cubejs-driver` lookup path).

## Rollback

There is no `npm unpublish` after 72 hours. To recover from a bad release:

1. Bump the patch version (`0.X.Y` → `0.X.Y+1`) with the fix.
2. Mark the bad version deprecated: `npm deprecate mongosql-cubejs-driver@0.X.Y "use 0.X.(Y+1) — see release notes"`.
3. Repeat for each per-platform sub-package.

## Open release-time questions

- **Linux arm64-musl as canary** — the napi-rs Discovery log notes that this triple has historically had cross-rs/openssl issues. Our `mongodb` crate uses `rustls-tls` so OpenSSL is not on the link path; if a future dep change reintroduces it, this triple is the first to fail. The workflow `fail-fast: false` keeps the other 5 platforms going so a clean release can ship without arm64-musl while you investigate. Decide per-release: ship a 5-platform release or block on arm64-musl.
- **Apple notarization** — `.node` files do not currently round-trip through Apple's notary service. macOS Sonoma+ users may see a Gatekeeper warning on first import. If users report it, wire `xcrun notarytool` into the `darwin-*` matrix entries in a follow-up PR.
