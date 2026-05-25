#!/usr/bin/env node
/**
 * Wrap `napi build` to work around the cargo-name-vs-napi-name mismatch
 * (Critic v3 — Issue #13).
 *
 * Background. napi-rs's CLI (`napi build`) computes the dylib source
 * path as `target/<profile>/lib${cargoName}.<dylibExt>`, but cargo
 * itself emits `lib<cargoNameWithDashesReplacedWithUnderscores>.<ext>`.
 * For us cargoName is `cubejs-mongosql-driver-native`; cargo emits
 * `libcubejs_mongosql_driver_native.dylib` while napi-cli expects
 * `libcubejs-mongosql-driver-native.dylib`. Result: the copy step
 * inside `napi build` fails with ENOENT and no `.node` file is staged.
 *
 * Workaround. Run cargo (or `cross`) first to produce the underscored
 * dylib; copy it to the hyphenated name napi expects; then invoke
 * `napi build` which finds the right file and packages the `.node`.
 *
 * Cross-compilation. Pass `--target <triple>` to build for a non-host
 * target. Pair with `--use-cross` to drive the build via
 * [`cross`](https://github.com/cross-rs/cross) (Docker-based) instead
 * of plain cargo. `--use-cross` is required for Linux musl + arm64
 * targets on a macOS host; for cargo-supported targets you can omit
 * it. The CI release workflow at `.github/workflows/release.yml`
 * passes both flags per matrix entry.
 */
import { execSync } from 'node:child_process';
import { existsSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const release = args.includes('--release');
const profile = release ? 'release' : 'debug';
const useCross = args.includes('--use-cross');
// --target <triple> support: extract the explicit target if present.
const targetIdx = args.indexOf('--target');
const target = targetIdx >= 0 ? args[targetIdx + 1] : null;

const cargoName = 'cubejs-mongosql-driver-native';
const cargoUnderscored = cargoName.replaceAll('-', '_');

// Derive the *host* dylib extension only when no --target is set;
// cross-builds use the target triple to determine output shape.
const hostPlatform = process.platform;
const targetPlatform = target
  ? target.includes('-apple-')
    ? 'darwin'
    : target.includes('-linux-')
      ? 'linux'
      : 'win32'
  : hostPlatform;
const dylibExt = targetPlatform === 'darwin' ? 'dylib' : targetPlatform === 'linux' ? 'so' : 'dll';
const dylibPrefix = targetPlatform === 'win32' ? '' : 'lib';

// When --target is used, cargo writes output to target/<triple>/<profile>/
// instead of target/<profile>/.
const profileDir = target ? join(REPO_ROOT, 'target', target, profile) : join(REPO_ROOT, 'target', profile);
const cargoDylib = join(profileDir, `${dylibPrefix}${cargoUnderscored}.${dylibExt}`);
const napiDylib = join(profileDir, `${dylibPrefix}${cargoName}.${dylibExt}`);

// 1. Build via cargo (or cross for cross-compilation) to produce the
//    underscored .dylib/.so. We do this manually rather than letting
//    `napi build` drive it so the rename in step 2 happens between
//    builds — `napi build` would error before we could fix the name.
const buildTool = useCross ? 'cross' : 'cargo';
const targetArgs = target ? ['--target', target] : [];
const profileArgs = release ? ['--release'] : [];
const buildCmd = [buildTool, 'build', ...profileArgs, ...targetArgs, '-p', cargoName].join(' ');
console.log(`[build-rust] ${buildCmd}`);
execSync(buildCmd, { stdio: 'inherit', cwd: REPO_ROOT });

if (!existsSync(cargoDylib)) {
  console.error(`[build-rust] ${buildTool} did not produce expected output at ${cargoDylib}`);
  process.exit(1);
}

// 2. Mirror the underscored output to the hyphenated napi-expected name.
//    We copy rather than symlink so the rename survives `cargo clean`
//    cycles and the file is treated as a real artifact by downstream.
const mtimeSource = statSync(cargoDylib).mtimeMs;
const needsCopy = !existsSync(napiDylib) || statSync(napiDylib).mtimeMs < mtimeSource;
if (needsCopy) {
  console.log(`[build-rust] cp ${cargoDylib} -> ${napiDylib}`);
  copyFileSync(cargoDylib, napiDylib);
}

// 3. Stage the .node file at repo root with the platform-suffixed name
//    napi-rs's loader expects (`<cargoName>.<short>.node`).
//
//    For host builds (no --target), we delegate to `napi build`, which
//    also generates the `index.js`/`index.d.ts` loader. napi-cli 2.x
//    re-invokes cargo internally — that's a no-op cache hit after
//    step 1 above.
//
//    For cross builds (--target with --use-cross), `napi build` would
//    re-invoke cargo WITHOUT the cross toolchain (napi-cli 2.x has no
//    `--use-cross`) and the build would fail with linker errors. So we
//    manually copy the dylib to the expected `.node` path. The
//    `index.js`/`index.d.ts` loader is platform-independent — it's
//    already produced by host builds and committed; we don't need to
//    regenerate it per target.
const PLATFORM_SUFFIX = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
  'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
  'aarch64-unknown-linux-musl': 'linux-arm64-musl',
  'x86_64-unknown-linux-musl': 'linux-x64-musl',
};

if (useCross && target) {
  // Manual stage — copy `target/<triple>/<profile>/lib<cargoName>.<ext>`
  // to `<repo>/<cargoName>.<short>.node`.
  const short = PLATFORM_SUFFIX[target];
  if (!short) {
    console.error(`[build-rust] no platform suffix mapping for target ${target}`);
    process.exit(1);
  }
  const nodeDest = join(REPO_ROOT, `${cargoName}.${short}.node`);
  console.log(`[build-rust] cp ${napiDylib} -> ${nodeDest}`);
  copyFileSync(napiDylib, nodeDest);
} else {
  const napiArgs = [
    'napi',
    'build',
    '--platform',
    ...(release ? ['--release'] : []),
    ...(target ? ['--target', target] : []),
    '--cargo-cwd',
    'crates/native',
    '--cargo-name',
    cargoName,
    '-p',
    cargoName,
  ];

  execSync(['pnpm', 'exec', ...napiArgs].join(' '), {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
}

console.log('[build-rust] done');
