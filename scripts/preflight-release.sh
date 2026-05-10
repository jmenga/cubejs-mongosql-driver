#!/usr/bin/env bash
# Pre-flight checks before tagging a release. Exits non-zero on any failure.
#
# Catches the four footguns that critic v2 raised against T21:
#   1. npm install resolution untested before publish (loader / sub-package
#      name prefix mismatch).
#   2. Per-platform publish failure leaves root with broken
#      optionalDependencies — pin the optionalDependencies to the *current*
#      root version and fail loudly if any drift.
#   3. `npm publish --provenance` silently fails if repo is private. Verify
#      the GitHub repo is public.
#   4. Version bump procedure must run `pnpm exec napi version` to sync
#      sub-packages — verify all 6 sub-package versions match the root.
#
# See RELEASE.md for the full release procedure.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0
WARN=0

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }
warn() { echo "  WARN: $*"; WARN=$((WARN + 1)); }
section() { echo; echo "== $* =="; }

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required (brew install jq)"
  exit 2
fi

# ----- 1. Repo state ---------------------------------------------------------
section "Repo state"

if [ -z "$(git status --porcelain)" ]; then
  ok "working tree clean"
else
  bad "working tree dirty (commit or stash before tagging)"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "main" ]; then
  ok "on main branch"
else
  bad "not on main (currently on '$BRANCH')"
fi

# ----- 2. Version sync (footgun #4) ------------------------------------------
section "Version sync (root + 6 sub-packages)"

ROOT_VER="$(jq -r '.version' package.json)"
echo "  root version: $ROOT_VER"

for plat in npm/*/package.json; do
  SUB_VER="$(jq -r '.version' "$plat")"
  SUB_NAME="$(jq -r '.name' "$plat")"
  if [ "$SUB_VER" = "$ROOT_VER" ]; then
    ok "$SUB_NAME @ $SUB_VER"
  else
    bad "$plat version $SUB_VER does not match root $ROOT_VER (run: pnpm exec napi version)"
  fi
done

# ----- 3. optionalDependencies pin (footgun #2) ------------------------------
section "optionalDependencies pinned to root version"

OPT_KEYS="$(jq -r '.optionalDependencies | keys[]' package.json)"
EXPECTED_PREFIX="$(jq -r '.napi.package.name' package.json)"
NPM_DIR_COUNT="$(ls -1 npm | wc -l | tr -d ' ')"
OPT_COUNT="$(echo "$OPT_KEYS" | wc -l | tr -d ' ')"

if [ "$OPT_COUNT" = "$NPM_DIR_COUNT" ]; then
  ok "optionalDependencies entry count ($OPT_COUNT) matches npm/ subdir count"
else
  bad "optionalDependencies has $OPT_COUNT entries but npm/ has $NPM_DIR_COUNT subdirs"
fi

for k in $OPT_KEYS; do
  V="$(jq -r --arg k "$k" '.optionalDependencies[$k]' package.json)"
  if [ "$V" = "$ROOT_VER" ]; then
    ok "$k -> $V"
  else
    bad "optionalDependencies['$k'] = '$V' (expected '$ROOT_VER')"
  fi
  case "$k" in
    "$EXPECTED_PREFIX"-*) ok "  prefix matches napi.package.name ($EXPECTED_PREFIX)" ;;
    *) bad "  prefix does not match napi.package.name ($EXPECTED_PREFIX)" ;;
  esac
done

# ----- 4. Cargo.lock matches Cargo.toml --------------------------------------
section "Cargo.lock matches Cargo.toml workspace version"

CARGO_TOML_VER="$(grep -E '^version' Cargo.toml | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
CARGO_LOCK_VER="$(awk '/^name = "cubejs-mongosql-driver-native"/{getline; print}' Cargo.lock | sed -E 's/.*"([^"]+)".*/\1/')"

if [ "$CARGO_TOML_VER" = "$CARGO_LOCK_VER" ]; then
  ok "Cargo.toml ($CARGO_TOML_VER) == Cargo.lock ($CARGO_LOCK_VER)"
else
  bad "Cargo.toml ($CARGO_TOML_VER) differs from Cargo.lock ($CARGO_LOCK_VER) — run cargo update -p cubejs-mongosql-driver-native"
fi

if [ "$CARGO_TOML_VER" = "$ROOT_VER" ]; then
  ok "Cargo workspace version matches package.json"
else
  bad "Cargo workspace version ($CARGO_TOML_VER) != package.json ($ROOT_VER)"
fi

# ----- 5. README sanity (footgun #1) -----------------------------------------
section "README install snippet"

if grep -q "npm install mongosql-cubejs-driver" README.md; then
  ok "README contains 'npm install mongosql-cubejs-driver'"
else
  bad "README missing canonical install snippet"
fi

PKG_NAME="$(jq -r '.name' package.json)"
if [ "$PKG_NAME" = "mongosql-cubejs-driver" ]; then
  ok "package.json name is mongosql-cubejs-driver"
else
  bad "package.json name is '$PKG_NAME' (expected 'mongosql-cubejs-driver')"
fi

# ----- 6. Provenance / repo visibility (footgun #3) --------------------------
section "Repo visibility for --provenance"

REPO_URL="$(jq -r '.repository.url' package.json)"
if echo "$REPO_URL" | grep -qE 'github.com[:/]([^/]+)/([^/.]+)'; then
  GH_SLUG="$(echo "$REPO_URL" | sed -E 's@.*github.com[:/]([^/]+)/([^/.]+)\.git@\1/\2@; s@.*github.com[:/]([^/]+)/([^/.]+)$@\1/\2@')"
  echo "  repo: $GH_SLUG"
  if command -v gh >/dev/null 2>&1; then
    if VIS="$(unset GITHUB_TOKEN; gh repo view "$GH_SLUG" --json visibility -q .visibility 2>/dev/null)"; then
      if [ "$VIS" = "PUBLIC" ]; then
        ok "GitHub repo is PUBLIC (--provenance will succeed)"
      else
        bad "GitHub repo is $VIS — npm publish --provenance will silently fail. Make repo public or remove --provenance"
      fi
    else
      warn "gh CLI could not determine repo visibility (auth issue?); manually verify the repo is PUBLIC"
    fi
  else
    warn "gh CLI not installed; cannot check repo visibility automatically"
  fi
else
  warn "could not parse repo URL '$REPO_URL'; skipping visibility check"
fi

# ----- 7. Tarball shape ------------------------------------------------------
section "Tarball shape (npm pack --dry-run)"

if PACK_OUT="$(npm pack --dry-run --json 2>/dev/null)"; then
  FILES="$(echo "$PACK_OUT" | jq -r '.[0].files[].path' 2>/dev/null || echo "")"
  if [ -z "$FILES" ]; then
    # older npm: parse stderr lines instead
    FILES="$(npm pack --dry-run 2>&1 | awk '/npm notice/ && / [0-9.]+kB | [0-9]+B / { print $NF }')"
  fi

  for required in "package.json" "README.md" "LICENSE" \
                  "dist/index.js" "dist/index.d.ts" \
                  "dist/MongoSqlDriver.js" "dist/MongoSqlQuery.js" \
                  "dist/native.js" "dist/types.js"; do
    if echo "$FILES" | grep -qFx "$required" || echo "$FILES" | grep -qF "$required"; then
      ok "tarball includes $required"
    else
      bad "tarball missing $required"
    fi
  done

  for plat in darwin-arm64 darwin-x64 linux-x64-gnu linux-arm64-gnu linux-x64-musl linux-arm64-musl; do
    if echo "$FILES" | grep -qF "npm/$plat/package.json"; then
      ok "tarball includes npm/$plat/package.json"
    else
      bad "tarball missing npm/$plat/package.json"
    fi
  done

  for forbidden in "tests/" "examples/" "crates/" "target/" "node_modules/"; do
    if echo "$FILES" | grep -qF "$forbidden"; then
      bad "tarball unexpectedly includes $forbidden"
    else
      ok "tarball excludes $forbidden"
    fi
  done
else
  bad "npm pack --dry-run failed"
fi

# ----- 8. Native loader sanity (footgun #1) ----------------------------------
# The auto-generated index.js loader at the root of the package must exist
# in the *published* tarball OR be produced by the release workflow before
# `npm publish`. If neither, post-install `require('mongosql-cubejs-driver')`
# fails because dist/native.js does `require('../index.js')`.
section "Native loader (root index.js) availability"

if [ -f "index.js" ]; then
  if grep -q "require('${EXPECTED_PREFIX}-darwin-arm64')" index.js; then
    ok "root index.js exists and references current package prefix ($EXPECTED_PREFIX)"
  else
    bad "root index.js exists but does NOT reference '${EXPECTED_PREFIX}-*' sub-packages — stale; rebuild via 'pnpm build:rust:debug'"
  fi
else
  warn "root index.js not present locally — release workflow MUST rebuild it on the publish job before npm publish, or publish will succeed but post-install resolution will fail"
fi

if jq -e '.files | index("index.js")' package.json >/dev/null; then
  ok "package.json files[] includes 'index.js'"
else
  bad "package.json files[] does NOT include 'index.js' — the loader will be missing from the published tarball; add 'index.js' and 'index.d.ts' to files[] OR update release.yaml to ship it via npm/<root>/ pattern"
fi

# ----- Summary ---------------------------------------------------------------
section "Summary"
echo "  PASS: $PASS"
echo "  WARN: $WARN"
echo "  FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "preflight: FAILED ($FAIL checks)"
  exit 1
fi

echo
echo "preflight: ALL CHECKS PASSED"
exit 0
