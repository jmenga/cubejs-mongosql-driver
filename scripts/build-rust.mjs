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
 * Workaround. Run `napi build` first; if it fails specifically because
 * of the missing hyphenated dylib, symlink the underscored output to
 * the expected hyphenated name and re-run. The symlink approach is
 * idempotent and zero-cost (no copy of the multi-MB binary).
 *
 * The `examples/docker/Dockerfile` builds inside the container with
 * the same crate name, so the same workaround applies there — but the
 * docker build uses `napi build` directly inside the image; we apply
 * the rename there via this same script invocation so both paths go
 * through one canonical place. See examples/docker/build-driver.sh
 * for the cube-e2e tarball staging step.
 */
import { execSync } from 'node:child_process';
import { existsSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const release = args.includes('--release');
const profile = release ? 'release' : 'debug';

const cargoName = 'cubejs-mongosql-driver-native';
const cargoUnderscored = cargoName.replaceAll('-', '_');

const platform = process.platform;
const dylibExt = platform === 'darwin' ? 'dylib' : platform === 'linux' ? 'so' : 'dll';
const dylibPrefix = platform === 'win32' ? '' : 'lib';
const cargoDylib = join(REPO_ROOT, 'target', profile, `${dylibPrefix}${cargoUnderscored}.${dylibExt}`);
const napiDylib = join(REPO_ROOT, 'target', profile, `${dylibPrefix}${cargoName}.${dylibExt}`);

// 1. Always (re)build via cargo first so the underscored .dylib is up-to-date.
// We use `cargo build` rather than `napi build` for this step so we don't
// blow up on the rename step; napi handles its own metadata generation
// next.
const cargoCmd = release ? `cargo build --release -p ${cargoName}` : `cargo build -p ${cargoName}`;
console.log(`[build-rust] ${cargoCmd}`);
execSync(cargoCmd, { stdio: 'inherit', cwd: REPO_ROOT });

if (!existsSync(cargoDylib)) {
  console.error(`[build-rust] cargo did not produce expected output at ${cargoDylib}`);
  process.exit(1);
}

// 2. Mirror the underscored cargo output to the hyphenated napi-expected name.
//    We copy rather than symlink so the rename survives `cargo clean` cycles
//    and the file is treated as a real artifact by downstream consumers.
const mtimeSource = statSync(cargoDylib).mtimeMs;
const needsCopy = !existsSync(napiDylib) || statSync(napiDylib).mtimeMs < mtimeSource;
if (needsCopy) {
  console.log(`[build-rust] cp ${cargoDylib} -> ${napiDylib}`);
  copyFileSync(cargoDylib, napiDylib);
}

// 3. Run `napi build` to generate the `.node` file (placed at repo root)
//    plus the `index.js`/`index.d.ts` loader. napi-cli 2.x does NOT
//    support `--no-build`, so it re-invokes cargo internally. That's
//    a few seconds of redundant no-op work (everything is already
//    cached), but it's not a correctness concern.
const napiArgs = [
  'napi',
  'build',
  '--platform',
  ...(release ? ['--release'] : []),
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

console.log('[build-rust] done');
