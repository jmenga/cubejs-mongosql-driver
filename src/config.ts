/**
 * Connection-string building for `MongoSqlDriver`.
 *
 * This module is the *single* place that translates Cube-standard
 * `CUBEJS_DB_*` and Mongo-specific `CUBEJS_MONGOSQL_*` env vars into a
 * MongoDB connection URI. The Rust client (`crates/native/src/client.rs`)
 * accepts the URI verbatim and hands it to `mongodb::Client::with_uri_str`,
 * which parses every option the `mongodb` crate supports — see
 * `~/.cargo/registry/.../mongodb-3.7.0/src/client/options.rs:2262-2790`
 * for the canonical match-arm list. We do not validate parameter
 * values here; the crate raises a parse error on the Rust side if
 * something is malformed.
 *
 * ## Precedence (highest → lowest)
 *
 *   1. Explicit constructor `uri` argument (programmatic embed of Cube).
 *   2. `CUBEJS_DB_URL` (Cube's documented "full URL" var).
 *   3. `CUBEJS_DB_URI` (legacy / pre-this-change usage).
 *   4. Composed from `CUBEJS_DB_HOST` (+ optional `_PORT`, `_USER`,
 *      `_PASS`, `_NAME`). `CUBEJS_DB_HOST` must be set; otherwise we
 *      throw `MONGOSQL_CONFIG_INVALID`.
 *
 * Once the base URI is determined, env-driven URI parameters are
 * APPENDED only if the key is not already present in the URI's query
 * string. User-set parameters in the URI always win — this avoids
 * surprising overrides for operators who already encoded e.g.
 * `?retryWrites=true&w=majority` directly into their connection
 * string.
 *
 * ## Mappings honoured
 *
 * | Env var | URI param | Source |
 * |---|---|---|
 * | `CUBEJS_DB_SSL`                            | `tls`                      | Cube-standard |
 * | `CUBEJS_DB_MAX_POOL`                       | `maxPoolSize`              | Cube-standard |
 * | `CUBEJS_DB_MIN_POOL`                       | `minPoolSize`              | Cube-standard |
 * | `CUBEJS_DB_QUERY_TIMEOUT`                  | (server-side, see below)   | Cube-standard |
 * | `CUBEJS_DB_IDLE_TIMEOUT`                   | `maxIdleTimeMS`            | this driver   |
 * | `CUBEJS_MONGOSQL_MAX_CONNECTING`           | `maxConnecting`            | this driver   |
 * | `CUBEJS_MONGOSQL_WAIT_QUEUE_TIMEOUT_MS`    | `waitQueueTimeoutMS`       | this driver   |
 * | `CUBEJS_MONGOSQL_CONNECT_TIMEOUT_MS`       | `connectTimeoutMS`         | this driver   |
 * | `CUBEJS_MONGOSQL_SOCKET_TIMEOUT_MS`        | `socketTimeoutMS`          | this driver   |
 * | `CUBEJS_MONGOSQL_SERVER_SELECTION_TIMEOUT_MS` | `serverSelectionTimeoutMS` | this driver |
 * | `CUBEJS_MONGOSQL_HEARTBEAT_FREQUENCY_MS`   | `heartbeatFrequencyMS`     | this driver   |
 * | `CUBEJS_MONGOSQL_APP_NAME`                 | `appName`                  | this driver   |
 * | `CUBEJS_MONGOSQL_RETRY_WRITES`             | `retryWrites`              | this driver   |
 * | `CUBEJS_MONGOSQL_RETRY_READS`              | `retryReads`               | this driver   |
 * | `CUBEJS_MONGOSQL_COMPRESSORS`              | `compressors`              | this driver   |
 *
 * `CUBEJS_DB_QUERY_TIMEOUT` is NOT appended to the URI — it controls
 * the per-query `maxTimeMS` we already pass to the aggregation
 * pipeline. The driver layer reads it and stores it on
 * `MongoSqlConfig.queryTimeoutMs`, taking precedence over the legacy
 * `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS`. See
 * https://cube.dev/docs/product/configuration/reference/environment-variables
 * for the Cube-documented `10m` default + "Duration string or seconds"
 * format (we accept both).
 *
 * ## Duration parsing
 *
 * Both `CUBEJS_DB_QUERY_TIMEOUT` and `CUBEJS_DB_IDLE_TIMEOUT` accept
 * either a bare number (interpreted as **milliseconds** — the unit
 * MongoDB URI params already use, so consistent across this module)
 * or a duration suffix: `ms`, `s`, `m`, `h`. Examples:
 *
 *   - `"60000"`  → 60_000 ms
 *   - `"60000ms"` → 60_000 ms
 *   - `"60s"`    → 60_000 ms
 *   - `"10m"`    → 600_000 ms
 *   - `"1h"`     → 3_600_000 ms
 */
import type { MongoSqlError } from './types.js';

/** Subset of `process.env` we depend on. */
export type EnvLike = NodeJS.ProcessEnv;

/** Result of resolving env vars + overrides into a connection-string + driver options. */
export interface ResolvedUriConfig {
  /** Final URI to hand to the Rust client. Always contains all env-driven params. */
  uri: string;
  /**
   * Effective per-query timeout in milliseconds (drives the aggregation
   * pipeline's `maxTimeMS`). Resolved precedence:
   *   1. `override.queryTimeoutMs` (constructor arg)
   *   2. `CUBEJS_DB_QUERY_TIMEOUT` (Cube-standard, duration-aware)
   *   3. `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS` (legacy, bare number)
   * Undefined if none set; the native side then uses its built-in default.
   */
  queryTimeoutMs: number | undefined;
}

interface UriParamSpec {
  envVar: string;
  uriParam: string;
  /** Optional value coercion (e.g. duration → milliseconds). Returns `undefined` to skip. */
  parse?: (raw: string) => string | undefined;
}

const TLS_ENV: UriParamSpec = {
  envVar: 'CUBEJS_DB_SSL',
  uriParam: 'tls',
  parse: parseBoolToString,
};

/**
 * Mongo-specific tunables. The mongodb Rust crate matches URI keys
 * case-insensitively (`options.rs:2262` `key.to_lowercase()`), but we
 * emit standard MongoDB camelCase per
 * https://www.mongodb.com/docs/manual/reference/connection-string-options/
 * for readability and to match what users find in MongoDB docs.
 */
const URI_PARAM_SPECS: readonly UriParamSpec[] = [
  TLS_ENV,
  { envVar: 'CUBEJS_DB_MAX_POOL', uriParam: 'maxPoolSize', parse: parsePositiveInteger },
  { envVar: 'CUBEJS_DB_MIN_POOL', uriParam: 'minPoolSize', parse: parseNonNegativeInteger },
  { envVar: 'CUBEJS_DB_IDLE_TIMEOUT', uriParam: 'maxIdleTimeMS', parse: parseDurationToMillisString },
  { envVar: 'CUBEJS_MONGOSQL_MAX_CONNECTING', uriParam: 'maxConnecting', parse: parsePositiveInteger },
  { envVar: 'CUBEJS_MONGOSQL_WAIT_QUEUE_TIMEOUT_MS', uriParam: 'waitQueueTimeoutMS', parse: parseNonNegativeInteger },
  { envVar: 'CUBEJS_MONGOSQL_CONNECT_TIMEOUT_MS', uriParam: 'connectTimeoutMS', parse: parseNonNegativeInteger },
  { envVar: 'CUBEJS_MONGOSQL_SOCKET_TIMEOUT_MS', uriParam: 'socketTimeoutMS', parse: parseNonNegativeInteger },
  {
    envVar: 'CUBEJS_MONGOSQL_SERVER_SELECTION_TIMEOUT_MS',
    uriParam: 'serverSelectionTimeoutMS',
    parse: parseNonNegativeInteger,
  },
  {
    envVar: 'CUBEJS_MONGOSQL_HEARTBEAT_FREQUENCY_MS',
    uriParam: 'heartbeatFrequencyMS',
    parse: parseNonNegativeInteger,
  },
  { envVar: 'CUBEJS_MONGOSQL_APP_NAME', uriParam: 'appName', parse: parseNonEmpty },
  { envVar: 'CUBEJS_MONGOSQL_RETRY_WRITES', uriParam: 'retryWrites', parse: parseBoolToString },
  { envVar: 'CUBEJS_MONGOSQL_RETRY_READS', uriParam: 'retryReads', parse: parseBoolToString },
  { envVar: 'CUBEJS_MONGOSQL_COMPRESSORS', uriParam: 'compressors', parse: parseNonEmpty },
];

/**
 * Resolve `(uri, queryTimeoutMs)` from constructor overrides + env.
 *
 * Throws `MONGOSQL_CONFIG_INVALID` when:
 *   - neither explicit uri / `CUBEJS_DB_URL` / `CUBEJS_DB_URI` is set
 *     AND `CUBEJS_DB_HOST` is also unset;
 *   - a duration env var is malformed (e.g. `"forever"`);
 *   - a numeric env var fails to parse.
 */
export function resolveUriConfig(overrideUri: string | undefined, env: EnvLike): ResolvedUriConfig {
  // Step 1: pick the base URI.
  const baseUri = overrideUri ?? env.CUBEJS_DB_URL ?? env.CUBEJS_DB_URI ?? composeUriFromParts(env);

  // Step 2: enrich with env-driven URI params (only if not already in URI).
  const finalUri = applyUriParams(baseUri, env);

  // Step 3: resolve effective query-timeout-ms. CUBEJS_DB_QUERY_TIMEOUT
  // (duration-aware) wins over the legacy CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS
  // (bare number). Both still recognised for back-compat.
  const cubeStandardTimeout = env.CUBEJS_DB_QUERY_TIMEOUT;
  const queryTimeoutMs =
    cubeStandardTimeout !== undefined && cubeStandardTimeout !== ''
      ? parseDurationToMillis(cubeStandardTimeout, 'CUBEJS_DB_QUERY_TIMEOUT')
      : parseLegacyTimeoutMs(env.CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS);

  return { uri: finalUri, queryTimeoutMs };
}

/**
 * Build `mongodb://[user:pass@]host[:port]/[db]` from discrete env
 * pieces. Used when neither `CUBEJS_DB_URL` nor `CUBEJS_DB_URI` is set.
 *
 * - `CUBEJS_DB_HOST` is required (clear error if missing).
 * - `CUBEJS_DB_PORT` appended if set.
 * - `CUBEJS_DB_USER` / `CUBEJS_DB_PASS` URL-encoded so `@` `:` `/`
 *   `?` `#` in passwords don't break the userinfo parser.
 * - `CUBEJS_DB_NAME` appended as the path segment. Not load-bearing
 *   (the driver also reads it separately into `MongoSqlConfig.database`),
 *   but the mongodb crate parses it so we include it for consistency
 *   with the URL/URI shape — and any auth-database fallback the crate
 *   does.
 *
 * Host strings with commas (replica-set seed lists like `a:27017,b:27017`)
 * pass through verbatim.
 */
function composeUriFromParts(env: EnvLike): string {
  const host = env.CUBEJS_DB_HOST;
  if (!host) {
    throw configInvalid(
      'missing required config: uri (set CUBEJS_DB_URL / CUBEJS_DB_URI or pass `uri` to the constructor; or set CUBEJS_DB_HOST to compose one)',
    );
  }
  const port = env.CUBEJS_DB_PORT;
  const user = env.CUBEJS_DB_USER;
  const pass = env.CUBEJS_DB_PASS;
  const db = env.CUBEJS_DB_NAME;

  let userinfo = '';
  if (user !== undefined && user !== '') {
    userinfo = encodeURIComponent(user);
    if (pass !== undefined && pass !== '') {
      userinfo += `:${encodeURIComponent(pass)}`;
    }
    userinfo += '@';
  } else if (pass !== undefined && pass !== '') {
    throw configInvalid('CUBEJS_DB_PASS is set but CUBEJS_DB_USER is not — credentials require both');
  }

  // host may itself be a seed list ("h1,h2:27017") or a hostname.
  // Port is only meaningful when host is a single hostname; we append
  // it conservatively if the host string has no ':' AND no ','.
  let hostPart = host;
  if (port !== undefined && port !== '' && !host.includes(':') && !host.includes(',')) {
    hostPart = `${host}:${port}`;
  }

  const dbPart = db !== undefined && db !== '' ? `/${encodeURIComponent(db)}` : '/';

  return `mongodb://${userinfo}${hostPart}${dbPart}`;
}

/**
 * Append env-driven URI params to the base URI, skipping any key that
 * already appears in the URI's query string.
 *
 * Implemented via `new URL` — Node's parser handles both `mongodb://`
 * and `mongodb+srv://` schemes correctly (verified: see commit message).
 * We reconstruct the URI by string concatenation rather than reading
 * `URL.href` back because Node's URL normalisation otherwise drops
 * authentication-related characters (e.g. `+` in passwords) and we
 * want byte-identical pass-through of any URI the user provides.
 */
function applyUriParams(baseUri: string, env: EnvLike): string {
  const existingKeys = extractExistingParamKeys(baseUri);

  const additions: Array<[string, string]> = [];
  for (const spec of URI_PARAM_SPECS) {
    const raw = env[spec.envVar];
    if (raw === undefined || raw === '') continue;
    if (existingKeys.has(spec.uriParam.toLowerCase())) continue;
    const value = spec.parse ? spec.parse(raw) : raw;
    if (value === undefined) {
      throw configInvalid(`${spec.envVar} has invalid value: '${raw}'`);
    }
    additions.push([spec.uriParam, value]);
  }

  if (additions.length === 0) return baseUri;

  // Determine separator: `?` if URI has no query, else `&`.
  // `existingKeys.size > 0` is equivalent to "URI has a `?`" except for
  // the empty-query-string edge case (`mongodb://h/db?`) which is not
  // produced by us and would be parsed as a query by `new URL` anyway.
  const queryStart = findQueryStart(baseUri);
  const separator = queryStart === -1 ? '?' : '&';
  const tail = additions.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  // Insert before any URL fragment (`#...`), although MongoDB URIs do
  // not normally have one — defensive only.
  const hashAt = baseUri.indexOf('#');
  if (hashAt === -1) return `${baseUri}${separator}${tail}`;
  return `${baseUri.slice(0, hashAt)}${separator}${tail}${baseUri.slice(hashAt)}`;
}

/**
 * Pull the set of param keys (lowercased) already present in the URI's
 * query string. Returns an empty set for URIs with no query.
 */
function extractExistingParamKeys(uri: string): Set<string> {
  const start = findQueryStart(uri);
  if (start === -1) return new Set();
  const end = uri.indexOf('#', start + 1);
  const query = uri.slice(start + 1, end === -1 ? undefined : end);
  if (!query) return new Set();
  const keys = new Set<string>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    // URI keys aren't expected to be percent-encoded, but be tolerant.
    try {
      keys.add(decodeURIComponent(rawKey).toLowerCase());
    } catch {
      keys.add(rawKey.toLowerCase());
    }
  }
  return keys;
}

function findQueryStart(uri: string): number {
  // Skip the protocol-relative `//` — those are not the query.
  return uri.indexOf('?');
}

// ---------- value parsers ----------

/**
 * Accepts `"true"` / `"false"` (case-insensitive) or `"1"` / `"0"`.
 * Returns the canonical `"true"` / `"false"` MongoDB URI form.
 */
function parseBoolToString(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return 'true';
  if (v === 'false' || v === '0') return 'false';
  return undefined;
}

function parseNonEmpty(raw: string): string | undefined {
  const v = raw.trim();
  return v === '' ? undefined : v;
}

function parsePositiveInteger(raw: string): string | undefined {
  const n = parseStrictInteger(raw);
  if (n === undefined || n <= 0) return undefined;
  return String(n);
}

function parseNonNegativeInteger(raw: string): string | undefined {
  const n = parseStrictInteger(raw);
  if (n === undefined || n < 0) return undefined;
  return String(n);
}

function parseStrictInteger(raw: string): number | undefined {
  const v = raw.trim();
  if (!/^-?\d+$/.test(v)) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
}

/**
 * Convert a duration-or-number string to a millisecond integer string.
 *
 * Accepts a bare number (treated as **milliseconds**) or a unit
 * suffix: `ms`, `s`, `m`, `h`. Whitespace inside is trimmed.
 *
 * Returns the canonical `"<N>"` ms representation as a string (URI
 * param values are strings). Returns `undefined` for unparseable
 * input so the caller can produce a `MONGOSQL_CONFIG_INVALID` error
 * naming the offending env var.
 */
function parseDurationToMillisString(raw: string): string | undefined {
  const ms = parseDurationToMillisOrUndefined(raw);
  return ms === undefined ? undefined : String(ms);
}

/** Same as `parseDurationToMillisString` but returns the integer directly. Throws on malformed input. */
export function parseDurationToMillis(raw: string, envVarName: string): number {
  const ms = parseDurationToMillisOrUndefined(raw);
  if (ms === undefined) {
    throw configInvalid(
      `${envVarName} has invalid duration: '${raw}'. Accepted: bare ms (e.g. '60000'), or with unit suffix '<N>ms' / '<N>s' / '<N>m' / '<N>h'`,
    );
  }
  return ms;
}

function parseDurationToMillisOrUndefined(raw: string): number | undefined {
  const v = raw.trim();
  if (v === '') return undefined;
  // Most specific suffix first so `"500ms"` doesn't match the `s`
  // branch — `ms` must be tested before bare `s`.
  const match = v.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (match[2] ?? 'ms').toLowerCase();
  let multiplier: number;
  switch (unit) {
    case 'ms':
      multiplier = 1;
      break;
    case 's':
      multiplier = 1_000;
      break;
    case 'm':
      multiplier = 60_000;
      break;
    case 'h':
      multiplier = 3_600_000;
      break;
    default:
      return undefined;
  }
  // Round to nearest ms to keep fractional inputs (`0.5s`) usable.
  return Math.round(n * multiplier);
}

/**
 * Legacy `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS` is documented as a bare
 * number-of-milliseconds. Preserve the old behaviour: empty/invalid
 * returns `undefined` (so the native default takes over) — we do NOT
 * throw on invalid here, matching the pre-this-change behaviour where
 * `numEnv` silently returned `undefined`.
 */
function parseLegacyTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function configInvalid(detail: string): MongoSqlError {
  const err = new Error(`MONGOSQL_CONFIG_INVALID: ${detail}`) as MongoSqlError;
  err.code = 'MONGOSQL_CONFIG_INVALID';
  err.name = 'MongoSqlError';
  return err;
}
