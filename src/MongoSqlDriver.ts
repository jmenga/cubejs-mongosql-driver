/**
 * MongoSqlDriver — Cube data source driver for MongoDB via MongoSQL.
 *
 * See SPEC.md FR-1 (driver protocol), FR-7 (env-var configuration), and
 * ARCHITECTURE.md §2.1.
 *
 * BaseDriver method-list audit (against
 * `@cubejs-backend/base-driver/dist/src/BaseDriver.d.ts`):
 *
 *  Required by DriverInterface (we override these):
 *   - query(sql, values?, options?)        — REQUIRED, override (delegates + flattens)
 *   - testConnection()                     — REQUIRED, override (lazy native init)
 *   - release()                            — override (closes native client)
 *   - tablesSchema()                       — override (delegate to native)
 *   - downloadQueryResults(sql, ...)       — override → query() shape; we have no streaming
 *   - capabilities()                       — override → no export bucket / streaming source
 *   - nowTimestamp()                       — INHERIT (Date.now())
 *
 *  Schema-introspection helpers (BaseDriver default reads information_schema —
 *  MongoSQL doesn't expose one, so we route to tablesSchema() / native):
 *   - getSchemas()                         — N/A — we serve via tablesSchema()
 *   - getTablesQuery(schema)               — N/A — runs SQL against information_schema
 *   - getTablesForSpecificSchemas(...)     — N/A
 *   - getColumnsForSpecificTables(...)     — N/A
 *   - informationSchemaQuery()             — N/A (protected default)
 *   - tableColumnTypes(table)              — INHERIT (uses query()); only needed for
 *                                            uploadTableWithIndexes path which we reject
 *
 *  Mutation methods (read-only driver — explicit refusal beats silent no-op):
 *   - createSchemaIfNotExists(schemaName)  — throw
 *   - dropTable(tableName, options?)       — throw
 *   - uploadTable(...)                     — throw
 *   - uploadTableWithIndexes(...)          — throw
 *   - createTable(...)                     — throw
 *   - createTableRaw(...)                  — throw
 *   - loadPreAggregationIntoTable(...)     — INHERIT default (delegates to query())
 *                                            so partitioned/incremental pre-aggs work
 *
 *  Bucket-export (no MongoDB equivalent — SPEC FR-6 says EXPORT_BUCKET unsupported):
 *   - downloadTable(...)                   — INHERIT (uses query(); fine for memory path)
 *   - parseBucketUrl / extractFilesFromS3 / extractFilesFromGCS / extractFilesFromAzure
 *                                          — N/A (only invoked via unload paths we don't expose)
 *   - readOnly()                           — override → true (signals to Cube/Cube Store)
 *
 *  SQL-shape helpers used by Cube but irrelevant to MongoSQL (the dialect class
 *  handles quoting; the driver does not echo SQL strings):
 *   - quoteIdentifier(id)                  — INHERIT (default uses '"', dialect class
 *                                            in MongoSqlQuery overrides to backticks)
 *   - param(i)                             — INHERIT
 *   - wrapQueryWithLimit({query, limit})   — INHERIT (mutates the object in place)
 *
 *  Static:
 *   - dialectClass()                       — override → MongoSqlQuery
 */

import { BaseDriver } from '@cubejs-backend/base-driver';
import type {
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  DownloadTableData,
  DriverCapabilities,
  ExternalCreateTableOptions,
  IndexesSQL,
  QueryOptions,
  TableColumn,
  TableStructure,
} from '@cubejs-backend/base-driver';

import { MongoSqlClient, type TablesSchema } from './native.js';
import { MongoSqlQuery } from './MongoSqlQuery.js';
import type { MongoSqlConfig, MongoSqlError, SchemaSource } from './types.js';

/**
 * Cube driver class. Cube instantiates this when CUBEJS_DB_TYPE=mongosql.
 *
 * Construction is cheap and pure: env vars are read and validated, but no
 * native client is created. The native client is created lazily on the first
 * `testConnection()` / `query()` / `tablesSchema()` call so that throwing in
 * the constructor reports config errors crisply (Cube wraps construction
 * exceptions less helpfully than runtime ones).
 */
export class MongoSqlDriver extends BaseDriver {
  private readonly resolvedConfig: MongoSqlConfig;

  private client: MongoSqlClient | undefined;

  constructor(config?: Partial<MongoSqlConfig>) {
    super();
    this.resolvedConfig = buildConfig(config, process.env);
  }

  /** Test hook: surface the config the driver resolved from constructor + env. */
  public _config(): Readonly<MongoSqlConfig> {
    return this.resolvedConfig;
  }

  // ---------- BaseDriver overrides ----------

  public override async testConnection(): Promise<void> {
    const client = this.ensureClient();
    await client.testConnection();
  }

  public override async query<R = unknown>(sql: string, values?: unknown[], _options?: QueryOptions): Promise<R[]> {
    // Critic v2 — Issue 4: refuse non-empty `values` explicitly. Cube
    // passes a values array on some pre-aggregation paths; mongosql v1.8.5
    // does not accept SQL parameters via the wire (no `?` / `$N`
    // placeholder substitution at the translator layer), so silently
    // ignoring `values` would produce queries that don't match the
    // intended filter — a correctness bug, not a feature gap.
    if (values !== undefined && values.length > 0) {
      throw configInvalid(
        'parameterized queries are not yet supported; mongosql v1.8.5 does not accept ' +
          'SQL parameters via the wire — substitute literals server-side or in the ' +
          "dialect (CubeJS's `BaseQuery.paramAllocator` builds the literal-substituted form).",
      );
    }
    if (projectionHasNameCollision(sql)) {
      throw translateFailed(
        'JOIN projection contains two or more qualified columns with the same name ' +
          '(e.g. `SELECT a.col, b.col` where the column names match). Mongosql ' +
          'collapses these into an empty-string envelope `{"": {col, col}}` and BSON ' +
          'document keys silently overwrite — losing data. Use `SELECT *` (returns ' +
          '`<table>__<column>` prefixes) or alias each column explicitly ' +
          '(`SELECT a.col AS a_col, b.col AS b_col`).',
      );
    }
    const client = this.ensureClient();
    const raw = await client.query<Record<string, unknown>>(sql);
    return flattenRows<R>(raw);
  }

  public override async tablesSchema(): Promise<TablesSchema> {
    const client = this.ensureClient();
    return client.tablesSchema();
  }

  public override async release(): Promise<void> {
    if (this.client) {
      const c = this.client;
      this.client = undefined;
      await c.close();
    }
  }

  public override async downloadQueryResults(
    sql: string,
    values?: unknown[],
    _options?: DownloadQueryResultsOptions,
  ): Promise<DownloadQueryResultsResult> {
    const rows = await this.query<Record<string, unknown>>(sql, values);
    // BaseDriver consumers expect `{ rows, types }`. We don't have type
    // metadata at row level (mongosql gives us a result-set schema from
    // translation but we don't currently surface it through napi); leaving
    // `types` as an empty array is the documented fallback for memory-mode
    // downloads — Cube infers types from row values.
    return { rows, types: [] };
  }

  public override capabilities(): DriverCapabilities {
    return {
      // No EXPORT_BUCKET, no streaming source, no incremental schema loading.
      unloadWithoutTempTable: false,
      streamingSource: false,
      incrementalSchemaLoading: false,
      csvImport: false,
      streamImport: false,
    };
  }

  public override readOnly(): boolean {
    return true;
  }

  // ---------- Methods CubeJS expects but MongoSQL cannot fulfil ----------

  public override async createSchemaIfNotExists(_schemaName: string): Promise<void> {
    throw notSupported('createSchemaIfNotExists');
  }

  public override async dropTable(_tableName: string, _options?: QueryOptions): Promise<unknown> {
    throw notSupported('dropTable');
  }

  public override async uploadTable(
    _table: string,
    _columns: TableStructure,
    _tableData: DownloadTableData,
  ): Promise<void> {
    throw notSupported('uploadTable');
  }

  public override async uploadTableWithIndexes(
    _table: string,
    _columns: TableStructure,
    _tableData: DownloadTableData,
    _indexesSql: IndexesSQL,
    _uniqueKeyColumns: string[] | null,
    _queryTracingObj: unknown,
    _externalOptions: ExternalCreateTableOptions,
  ): Promise<void> {
    throw notSupported('uploadTableWithIndexes');
  }

  public override async createTable(_quotedTableName: string, _columns: TableColumn[]): Promise<void> {
    throw notSupported('createTable');
  }

  public override async createTableRaw(_query: string): Promise<void> {
    throw notSupported('createTableRaw');
  }

  // ---------- Static ----------

  public static dialectClass(): typeof MongoSqlQuery {
    return MongoSqlQuery;
  }

  // ---------- Internals ----------

  private ensureClient(): MongoSqlClient {
    if (!this.client) {
      this.client = new MongoSqlClient(this.resolvedConfig);
    }
    return this.client;
  }
}

/**
 * Mongosql wraps each result row in a per-collection envelope:
 *   `[{ users: { _id, email, ... } }, ...]`
 *
 * Cube expects flat rows (`Record<string, unknown>`). Strategy:
 *  - Single top-level key whose value is a plain object → unwrap.
 *  - Multiple top-level keys (JOIN result) → merge with `<table>__<column>`.
 *  - Anything else (scalar at top level, no envelope) → pass through.
 *
 * Discovery: see IMPLEMENTATION_PLAN.md → 2026-05-09 — T08 (mongosql per-
 * collection envelope) for the pipeline-shape source.
 *
 * **Critic v2 — Issue 2: empty-string envelope collision**.
 *
 * Mongosql emits `{"": {col: ..., col: ...}}` for explicit projections in
 * JOINs (e.g. `SELECT users.col, orders.col FROM users JOIN orders ...`).
 * If both sides project a column with the same name (`account_id`,
 * `created_at`, `_id`), the BSON document keys collide and silently
 * collapse — by the time JS has parsed the row we cannot detect the loss.
 *
 * Mitigation: input-side heuristic check in `query()` — if the SQL has a
 * JOIN AND projects multiple qualified columns with the same trailing
 * name, throw `MONGOSQL_TRANSLATE_FAILED` before executing. The flatten
 * path itself stays permissive so single-collection queries with the
 * naturally-occurring empty-string envelope (`SELECT col1, col2 FROM
 * users` → `{"": {col1, col2}}`) keep working.
 *
 * Callers hitting the heuristic must either: (a) use `SELECT *` (multi-
 * key envelope preserves `<table>__<col>` prefixes), or (b) alias the
 * conflicting columns explicitly (`SELECT a.col AS a_col, b.col AS
 * b_col`).
 */
function flattenRows<R>(rows: Array<Record<string, unknown>>): R[] {
  return rows.map((row) => flattenRow<R>(row));
}

function flattenRow<R>(row: Record<string, unknown>): R {
  const keys = Object.keys(row);
  if (keys.length === 1) {
    const only = row[keys[0]];
    if (isPlainObject(only)) return only as R;
    return row as unknown as R;
  }
  const out: Record<string, unknown> = {};
  for (const [tbl, val] of Object.entries(row)) {
    if (isPlainObject(val)) {
      for (const [col, v] of Object.entries(val)) {
        out[`${tbl}__${col}`] = v;
      }
    } else {
      out[tbl] = val;
    }
  }
  return out as R;
}

/**
 * Heuristic detector for the empty-string-envelope column-collision risk
 * (Critic v2 — Issue 2). Returns true iff `sql` contains a JOIN AND
 * projects two or more *qualified* columns (`<ident>.<column>`) where
 * the trailing column name appears more than once. False negatives are
 * acceptable (we can only see source SQL, not the full algebra); false
 * positives are bounded by the JOIN gate so plain single-table queries
 * are never blocked.
 *
 * The check is deliberately conservative — it does not parse SQL,
 * doesn't strip comments, and only flags the obvious shape. Cube's own
 * generated SQL always uses aliases or `SELECT *`-via-cube-views; users
 * writing raw SQL who hit this should add `AS <alias>` and re-run.
 */
function projectionHasNameCollision(sql: string): boolean {
  if (!/\bjoin\b/i.test(sql)) return false;
  const head = sql.match(/^\s*select\s+([\s\S]+?)\s+from\b/i);
  if (!head) return false;
  const projection = head[1];
  if (projection.trim() === '*') return false;
  // Strip parenthesised expressions (function args, subqueries) so we
  // don't pick up nested column refs as projection items.
  const flat = projection.replace(/\([^()]*\)/g, '');
  const items = flat.split(',');
  const trailingNames: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    // If the projection item has an alias (`AS xxx` or bare alias),
    // collisions are no longer possible — skip.
    if (/\bas\b/i.test(item)) continue;
    // Look for `<ident>.<column>` at the end of the item.
    const m = item.match(/[A-Za-z_][\w]*\.([A-Za-z_][\w]*)\s*$/);
    if (m) trailingNames.push(m[1].toLowerCase());
  }
  const seen = new Set<string>();
  for (const n of trailingNames) {
    if (seen.has(n)) return true;
    seen.add(n);
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

// ---------- Config ----------

type EnvLike = NodeJS.ProcessEnv;

function buildConfig(override: Partial<MongoSqlConfig> | undefined, env: EnvLike): MongoSqlConfig {
  const uri = override?.uri ?? env.CUBEJS_DB_URI;
  if (!uri) throw configInvalidMissing('uri (set CUBEJS_DB_URI or pass `uri` to the constructor)');

  const database = override?.database ?? env.CUBEJS_DB_NAME;
  if (!database) {
    throw configInvalidMissing('database (set CUBEJS_DB_NAME or pass `database` to the constructor)');
  }

  const schemaSource = override?.schemaSource ?? schemaSourceFromEnv(env);

  return {
    uri,
    database,
    schemaSource,
    schemaRefreshSec: override?.schemaRefreshSec ?? numEnv(env.CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC),
    schemaFailOpen: override?.schemaFailOpen ?? boolEnv(env.CUBEJS_MONGOSQL_SCHEMA_FAIL_OPEN),
    queryTimeoutMs: override?.queryTimeoutMs ?? numEnv(env.CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS),
    maxRows: override?.maxRows ?? numEnv(env.CUBEJS_MONGOSQL_MAX_ROWS),
  };
}

function schemaSourceFromEnv(env: EnvLike): SchemaSource | undefined {
  const kind = env.CUBEJS_MONGOSQL_SCHEMA_SOURCE;
  if (!kind) return undefined;
  if (kind === 'collection') return { kind: 'collection' };
  if (kind === 'file') {
    const path = env.CUBEJS_MONGOSQL_SCHEMA_FILE;
    if (!path) {
      throw configInvalid('CUBEJS_MONGOSQL_SCHEMA_FILE must be set when CUBEJS_MONGOSQL_SCHEMA_SOURCE=file');
    }
    return { kind: 'file', path };
  }
  throw configInvalid(`CUBEJS_MONGOSQL_SCHEMA_SOURCE must be 'collection' or 'file' (got '${kind}')`);
}

function numEnv(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function boolEnv(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  return v.toLowerCase() === 'true' || v === '1';
}

function configInvalidMissing(detail: string): MongoSqlError {
  return configInvalid(`missing required config: ${detail}`);
}

function configInvalid(detail: string): MongoSqlError {
  const err = new Error(`MONGOSQL_CONFIG_INVALID: ${detail}`) as MongoSqlError;
  err.code = 'MONGOSQL_CONFIG_INVALID';
  err.name = 'MongoSqlError';
  return err;
}

function translateFailed(detail: string): MongoSqlError {
  const err = new Error(`MONGOSQL_TRANSLATE_FAILED: ${detail}`) as MongoSqlError;
  err.code = 'MONGOSQL_TRANSLATE_FAILED';
  err.name = 'MongoSqlError';
  return err;
}

function notSupported(method: string): Error {
  return new Error(
    `MongoSqlDriver: '${method}' is not supported by the MongoSQL driver (read-only / no EXPORT_BUCKET path)`,
  );
}
