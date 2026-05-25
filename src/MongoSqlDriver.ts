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
 *   - downloadQueryResults(sql, ...)       — override → memory shape; streamImport ignored
 *                                            (capabilities().streamImport=false; see below)
 *   - capabilities()                       — override → no export bucket / streaming source
 *   - nowTimestamp()                       — INHERIT (Date.now())
 *   - stream(table, values, opts)          — NOT implemented; `streamImport: false`
 *                                            advertises this. Cube routes the
 *                                            pre-agg upload path through
 *                                            `downloadQueryResults` instead.
 *
 *  Schema-introspection helpers (BaseDriver default reads information_schema —
 *  MongoSQL doesn't expose one, so we route every shape through the native
 *  cached `tablesSchema()` rendering):
 *   - tablesSchema()                       — override (full snapshot, bulk path)
 *   - getSchemas()                         — override (DB list from tablesSchema)
 *   - getTablesForSpecificSchemas(...)     — override (filter tablesSchema by db)
 *   - getColumnsForSpecificTables(...)     — override (filter tablesSchema by table)
 *   - capabilities().incrementalSchemaLoading=true — opts Cube into the
 *                                            granular three-method path; SQL
 *                                            information_schema queries are
 *                                            never issued against mongosql.
 *   - getTablesQuery(schema)               — N/A — runs SQL against information_schema
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
  QueryColumnsResult,
  QueryOptions,
  QuerySchemasResult,
  QueryTablesResult,
  TableColumn,
  TableStructure,
} from '@cubejs-backend/base-driver';

import { MongoSqlClient, type ColumnType, type TablesSchema } from './native.js';
import { MongoSqlQuery } from './MongoSqlQuery.js';
import { resolveUriConfig } from './config.js';
import type { MongoSqlConfig, MongoSqlError, SchemaSource } from './types.js';

/**
 * Cube driver class. Cube instantiates this when CUBEJS_DB_TYPE=mongosql.
 *
 * Construction is cheap and pure: env vars are read and validated, but no
 * native client is created. The native client is created lazily on the first
 * `testConnection()` / `query()` / `tablesSchema()` call so that throwing in
 * the constructor reports config errors crisply (Cube wraps construction
 * exceptions less helpfully than runtime ones).
 *
 * **Configuration env vars (see `./config.ts` and README "Configuration"):**
 *
 *   Cube-standard (`CUBEJS_DB_*`):
 *     - `CUBEJS_DB_URL` / `CUBEJS_DB_URI` — full MongoDB connection string
 *     - `CUBEJS_DB_HOST` / `_PORT` / `_USER` / `_PASS` / `_NAME` — composed URI parts
 *     - `CUBEJS_DB_NAME` — database (also required separately by the driver)
 *     - `CUBEJS_DB_SSL` — `tls=true|false`
 *     - `CUBEJS_DB_MAX_POOL` / `_MIN_POOL` — `maxPoolSize` / `minPoolSize`
 *     - `CUBEJS_DB_QUERY_TIMEOUT` — per-query `maxTimeMS` (duration string or ms)
 *     - `CUBEJS_DB_IDLE_TIMEOUT` — `maxIdleTimeMS` (duration string or ms)
 *
 *   MongoDB-specific (`CUBEJS_MONGOSQL_*`):
 *     - `_SCHEMA_SOURCE` — `collection` (default), `file`, or `atlas-sql`
 *     - `_SCHEMA_FILE` — path (required if `_SCHEMA_SOURCE=file`)
 *     - `_SCHEMA_REFRESH_SEC` — background refresh cadence in seconds
 *     - `_SCHEMA_FAIL_OPEN` — `true` to soft-fail initial schema load
 *     - `_QUERY_TIMEOUT_MS` — (legacy) bare-ms timeout; overridden by
 *       `CUBEJS_DB_QUERY_TIMEOUT` when both set
 *     - `_MAX_ROWS` — row cap per query
 *     - `_APP_NAME` — `appName` (shows up in `serverStatus().connections`)
 *     - `_MAX_CONNECTING` — `maxConnecting`
 *     - `_WAIT_QUEUE_TIMEOUT_MS` — `waitQueueTimeoutMS`
 *     - `_CONNECT_TIMEOUT_MS` — `connectTimeoutMS`
 *     - `_SOCKET_TIMEOUT_MS` — `socketTimeoutMS`
 *     - `_SERVER_SELECTION_TIMEOUT_MS` — `serverSelectionTimeoutMS`
 *     - `_HEARTBEAT_FREQUENCY_MS` — `heartbeatFrequencyMS`
 *     - `_RETRY_WRITES` / `_RETRY_READS` — `retryWrites` / `retryReads`
 *     - `_COMPRESSORS` — `compressors`
 *
 *   User-set URI params (those already encoded in `CUBEJS_DB_URL/URI`) ALWAYS
 *   win — we only append env-driven params for keys the URI doesn't already
 *   specify.
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

  public override async query<R = unknown>(sql: string, values?: unknown[], options?: QueryOptions): Promise<R[]> {
    // Mongosql v1.8.5 does not accept SQL parameters via the wire (no
    // `?` / `$N` placeholder substitution at the translator layer). Cube
    // passes a values array on pre-aggregation build paths
    // (partitioned/incremental rollups with `WHERE created_at >= CAST(? AS TIMESTAMP)`).
    // We substitute the values into the SQL as quoted literals BEFORE
    // sending to mongosql — equivalent to what CubeJS's `BaseQuery.paramAllocator`
    // would emit when the dialect declares no param support.
    const finalSql = values !== undefined && values.length > 0 ? substituteParameters(sql, values) : sql;
    if (projectionHasNameCollision(finalSql)) {
      throw translateFailed(
        'JOIN projection contains two or more qualified columns with the same name ' +
          '(e.g. `SELECT a.col, b.col` where the column names match). Mongosql ' +
          'collapses these into an empty-string envelope `{"": {col, col}}` and BSON ' +
          'document keys silently overwrite — losing data. Use `SELECT *` (returns ' +
          '`<table>__<column>` prefixes) or alias each column explicitly ' +
          '(`SELECT a.col AS a_col, b.col AS b_col`).',
      );
    }
    // Cube's QueryOptions is `{ [key: string]: any }`; consumers that want
    // cancellation can pass a plain AbortSignal via `options.signal`.
    // Cube core does not pass one today, but `release()` cancellation flows
    // through the parent close-token on the native side regardless — so
    // SIGTERM cleanup works whether or not Cube ever wires this up.
    const signal = extractAbortSignal(options);
    const client = this.ensureClient();
    const raw = await client.query<Record<string, unknown>>(finalSql, signal);
    const flat = flattenRows<Record<string, unknown>>(raw);
    return normalizeRowShape<R>(flat);
  }

  public override async tablesSchema(): Promise<TablesSchema> {
    const client = this.ensureClient();
    return client.tablesSchema();
  }

  /**
   * Cube's incremental-schema-loading entry point #1.
   *
   * Returns the list of schemas (databases) we expose. BaseDriver's
   * default issues `SELECT table_schema ... FROM information_schema.tables`,
   * which MongoSQL has no equivalent for. We re-render from the cached
   * `tablesSchema()` snapshot — which the native side already keeps
   * fresh via the background refresh task (SPEC FR-3 / ARCHITECTURE §3.2).
   * Each call into `client.tablesSchema()` returns a fresh clone of the
   * cached snapshot, so the cost is O(N) in catalog column count — for
   * the typical few-thousand-cell catalog this is sub-millisecond on the
   * hot path (no native I/O, no `__sql_schemas` round-trip).
   *
   * Driver only ever exposes the database configured at construction
   * (FR-7 — `CUBEJS_DB_NAME`), so the returned list has at most one
   * entry. An empty list is possible if no schemas have been loaded
   * yet (e.g. `testConnection()` was never called or the schema source
   * is empty); Cube handles that case the same way it would for the
   * SQL path's empty resultset.
   */
  public override async getSchemas(): Promise<QuerySchemasResult[]> {
    const snapshot = await this.tablesSchema();
    return Object.keys(snapshot).map((schema_name) => ({ schema_name }));
  }

  /**
   * Cube's incremental-schema-loading entry point #2.
   *
   * For each requested schema, returns its table list from the cached
   * `tablesSchema()`. Schemas the snapshot doesn't know about are
   * silently dropped — mirrors the SQL path's "WHERE schema IN (...)"
   * which would naturally exclude unknown names. Passing an empty
   * `schemas` array returns an empty result with no native I/O cost
   * beyond a single cache read.
   */
  public override async getTablesForSpecificSchemas(schemas: QuerySchemasResult[]): Promise<QueryTablesResult[]> {
    if (schemas.length === 0) return [];
    const snapshot = await this.tablesSchema();
    const out: QueryTablesResult[] = [];
    for (const { schema_name } of schemas) {
      const tables = snapshot[schema_name];
      if (!tables) continue;
      for (const table_name of Object.keys(tables)) {
        out.push({ schema_name, table_name });
      }
    }
    return out;
  }

  /**
   * Cube's incremental-schema-loading entry point #3.
   *
   * For each requested `(schema_name, table_name)`, returns one row
   * per column with `column_name` and `data_type`. `data_type` is the
   * Cube generic-type string emitted by the native side (`string`,
   * `int`, `bigint`, `decimal`, `boolean`, `timestamp`, `text`) — the
   * same values that surface in `tablesSchema()`. Unknown tables are
   * silently dropped, same contract as `getTablesForSpecificSchemas`.
   *
   * `attributes` is forwarded verbatim from the column descriptor IF
   * a future native version supplies one — but the Rust `do_tables_schema`
   * (crates/native/src/client.rs:314) always emits `attributes: []` today,
   * so in production this is effectively always an empty array. We do
   * not emit `primaryKey` automatically — MongoDB's implicit `_id` IS a
   * primary key, but tagging it without explicit schema annotation would
   * surface as a foreign-key target in Cube's relationship inference and
   * break heuristic joins. The TS-side forwarding path exists for a
   * future Rust change where `__sql_schemas` documents' attribute fields
   * are propagated; callers that need the tag today still must encode
   * it explicitly in their __sql_schemas document AND in a Rust patch
   * that surfaces it through `ColumnSchema::attributes`.
   *
   * `foreign_keys` is not derivable from MongoDB schema documents — the
   * field is omitted (Cube's `QueryColumnsResult` declares it as
   * optional via the spread of `TableColumnQueryResult`).
   */
  public override async getColumnsForSpecificTables(tables: QueryTablesResult[]): Promise<QueryColumnsResult[]> {
    if (tables.length === 0) return [];
    const snapshot = await this.tablesSchema();
    const out: QueryColumnsResult[] = [];
    for (const { schema_name, table_name } of tables) {
      const cols = snapshot[schema_name]?.[table_name];
      if (!cols) continue;
      for (const col of cols) {
        out.push({
          schema_name,
          table_name,
          column_name: col.name,
          data_type: col.type,
          attributes: col.attributes,
        });
      }
    }
    return out;
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
    options?: DownloadQueryResultsOptions,
  ): Promise<DownloadQueryResultsResult> {
    // Pass through any caller-supplied AbortSignal so downloadQueryResults
    // is cancellable on the same terms as query().
    const signal = extractAbortSignal(options as Record<string, unknown> | undefined);
    // The DownloadQueryResultsOptions interface includes `streamImport`
    // (driver advertises whether it can stream rows during pre-aggregation
    // builds). We advertise `streamImport: false` in `capabilities()` —
    // mongosql v1.8.5 has no streaming cursor wired through napi-rs
    // (napi-rs's ThreadsafeFunction round-trip is post-MVP per SPEC
    // NFR-1) and the result is buffered up to `CUBEJS_MONGOSQL_MAX_ROWS`.
    //
    // Cube's contract: when a driver advertises `streamImport: false`,
    // Cube does NOT call `downloadQueryResults` with `streamImport:
    // true` (the option is reserved for `streamImport: true` drivers).
    // We honor the contract by ignoring the flag entirely: callers that
    // pass `streamImport: true` get the same memory `{rows, types}`
    // shape — the option has no effect. This mirrors the BaseDriver
    // default (`base-driver/dist/src/BaseDriver.js`), which also ignores
    // `streamImport`.
    //
    // If a future caller wants streaming, the right shape is for the
    // driver to ALSO implement the optional `stream(table, values,
    // options) -> StreamTableData` method on `DriverInterface` (see
    // `driver.interface.d.ts`). We do not implement it; until we do,
    // `streamImport: false` is the right capability flag and the only
    // honest answer is to keep returning the memory shape.
    // Cube's pre-aggregation upload path passes `types` (a `[{name, type},
    // ...]` list) to Cube Store to drive the LOAD ROWS column list. The
    // types come from `mongosql::Translation::{select_order, result_set_schema}`
    // — the authoritative projection order and BSON type mapping. We no
    // longer sniff from row values: that path was non-deterministic in
    // multi-partition pre-aggregations because mongosql constructs its
    // `$project` stage by iterating a HashMap-backed `Schema::Document`,
    // so two translations of the same SQL produced different field
    // orders. Divergent column orders across partition rebuilds caused
    // Cube Store UNIONs to fail with `type_coercion ... Timestamp ... Int64`.
    const finalSql = values !== undefined && values.length > 0 ? substituteParameters(sql, values) : sql;
    if (projectionHasNameCollision(finalSql)) {
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
    const { rows, types } = await client.queryWithTypes<Record<string, unknown>>(finalSql, signal);
    // Use the authoritative type list (from `mongosql::Translation::select_order`)
    // to null-fill any key that's expected by the projection but missing
    // from some/all rows. Same root cause as `normalizeRowShape` — see its
    // doc-comment. Here we prefer the type list over union-of-keys because
    // (a) it's deterministic, and (b) it covers the edge case where a
    // column is missing from EVERY row (a union would miss it; the type
    // list still names it).
    const flat = flattenRows<Record<string, unknown>>(rows);
    const expected = types.map((t) => t.name);
    // NOTE: Mutates `flat` in place (see `normalizeRowShape` doc-comment for the
    // mutation contract). First pass: null-fill every projected column named in
    // the authoritative type list — covers the rare case where a column is
    // missing from EVERY row (a pure union-of-keys would miss it). If `expected`
    // is empty (e.g. an empty native response with no types), the for-loop is a
    // no-op and the union pass below alone honors the FR-1 contract.
    for (const k of expected) {
      for (const r of flat) {
        if (!Object.hasOwn(r, k)) r[k] = null;
      }
    }
    // Belt-and-braces union-of-keys pass — handles any row keys outside
    // `expected` (e.g. a future mongosql version emitting an extra envelope
    // field) so this path honors the FR-1 "every row has the same key set"
    // contract symmetrically with `query()`.
    normalizeRowShape<Record<string, unknown>>(flat);
    return { rows: flat, types: types.map(normalizeColumnType) };
  }

  public override capabilities(): DriverCapabilities {
    return {
      // No EXPORT_BUCKET, no streaming source, no CSV/stream import path.
      unloadWithoutTempTable: false,
      streamingSource: false,
      // We implement getSchemas / getTablesForSpecificSchemas /
      // getColumnsForSpecificTables on top of the cached native
      // `tablesSchema()` snapshot. Cube uses the granular three-method
      // path when this flag is true, which means it never falls back to
      // the BaseDriver default that issues SQL against
      // `information_schema.*` (MongoSQL has no such schema).
      incrementalSchemaLoading: true,
      csvImport: false,
      // Driver has no streaming cursor wired through napi-rs
      // (ThreadsafeFunction round-trip is post-MVP per SPEC NFR-1) so
      // pre-aggregation builds use `downloadQueryResults`'s memory shape
      // capped at `CUBEJS_MONGOSQL_MAX_ROWS`. The option is honored by
      // `downloadQueryResults` as a no-op — see that method's comment.
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

/**
 * Make every row's key set identical by null-filling missing keys.
 *
 * **Mutates `rows` in place** — callers must not retain references to
 * the pre-normalize array if they need the original sparse shape. The
 * returned reference is the same array.
 *
 * **Why this exists.** Mongosql's `$project` stage that references a
 * nested-path expression (e.g. `agent.displayName` on a docs collection)
 * OMITS the field entirely when the source path is missing on the
 * underlying document — it does not emit `null`. This bites downstream
 * consumers whenever the row at index 0 happens to be sparser than later
 * rows; `ORDER BY <nested-field> ASC` is the most common way this
 * surfaces, but any query whose row 0 lacks a key that later rows have
 * triggers the same.
 *
 * Downstream consumers (notably Cube's native `getFinalQueryResult`
 * transform in `@cubejs-backend/native`) compile their row→member
 * extraction plan from the keys present in **row 0**. A sparse row 0
 * causes Cube to drop the column from every row in the response — even
 * rows that DO have the value. Reproduced empirically against the
 * `configs` collection (`SELECT id, agent_display_name FROM configs ...
 * ORDER BY agent_display_name ASC LIMIT 500` → 500 rows, all missing
 * `configs.agent_display_name`, even though 497/500 source docs have it).
 *
 * **Fix shape.** Take the union of keys across all rows and null-fill
 * each row so every row has every key. We can't simply look at `row[0]`
 * because that's the symptom. Iteration is O(rows × cols). At the
 * `MAX_ROWS=100000` pre-agg cap with a ~20-column projection this is
 * roughly 2M property-existence checks and stays under 100ms in practice.
 *
 * `downloadQueryResults` uses the authoritative type list instead of
 * a key union (the union would miss columns absent from every row); that
 * variant is implemented inline at the call site, not via this helper.
 */
function normalizeRowShape<R>(rows: Array<Record<string, unknown>>): R[] {
  if (rows.length === 0) return rows as unknown as R[];
  const union = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) union.add(k);
  }
  for (const r of rows) {
    for (const k of union) {
      // `Object.hasOwn` over `k in r` — the `in` operator traverses
      // the prototype chain, which would diverge from `Object.keys(r)`
      // above (own enumerable keys only) on rows that inherit through a
      // non-default prototype.
      if (!Object.hasOwn(r, k)) r[k] = null;
    }
  }
  return rows as unknown as R[];
}

/**
 * Test-only export. Lets `tests/unit/driver.test.ts` exercise the
 * key-union null-fill in isolation without spinning up the driver.
 * Not part of the public API.
 */
export const _normalizeRowShapeForTests = normalizeRowShape;

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

/**
 * Substitute `?` placeholders in `sql` with literal values from `values`.
 *
 * Mongosql v1.8.5 has no wire-level parameter protocol, so Cube's
 * pre-aggregation paths (which emit `WHERE col >= CAST(? AS TIMESTAMP)` +
 * `[Date, Date]`) need their placeholders inlined before translation.
 *
 * Skips `?` that appear inside single-quoted string literals. Doubled
 * single-quote (`''`) is treated as a literal `'` inside the current
 * string — matches the standard SQL escape convention.
 *
 * Throws `MONGOSQL_CONFIG_INVALID` on placeholder/value count mismatch.
 */
function substituteParameters(sql: string, values: readonly unknown[]): string {
  let out = '';
  let inString = false;
  let idx = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      // Doubled single-quote inside a string is an escaped quote — pass
      // through both characters and stay in-string.
      if (inString && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inString = !inString;
      out += c;
    } else if (c === '?' && !inString) {
      if (idx >= values.length) {
        throw configInvalid(`SQL has more '?' placeholders than provided values (consumed ${idx} of ${values.length})`);
      }
      out += formatSqlLiteral(values[idx]);
      idx++;
    } else {
      out += c;
    }
  }
  if (idx < values.length) {
    throw configInvalid(`parameter list has more values (${values.length}) than '?' placeholders in SQL (${idx})`);
  }
  return out;
}

function formatSqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return 'NULL';
    // ISO-8601, no quoting wrapper — callers usually wrap with `CAST(... AS TIMESTAMP)`.
    return `'${v.toISOString()}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Defensive passthrough for the native-side `(name, type)` entry.
 *
 * The Rust layer already returns one of Cube's documented generic-type
 * strings (`timestamp`, `int`, `bigint`, `decimal`, `boolean`, `string`,
 * `text`). We re-shape into a plain object so consumers depending on
 * structural typing don't end up with the napi-rs deserialised view.
 */
function normalizeColumnType(c: ColumnType): { name: string; type: string } {
  return { name: c.name, type: c.type };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Extract a caller-supplied AbortSignal from Cube's open `QueryOptions`
 * shape. Cube core does not currently pass one, but the contract is
 * `[key: string]: any`, so any caller that wires `options.signal` will
 * have it propagate through to the native cancel token. Returns
 * `undefined` if no signal is present or the value is not an AbortSignal.
 */
function extractAbortSignal(options: Record<string, unknown> | undefined): AbortSignal | undefined {
  if (!options) return undefined;
  const candidate = options.signal;
  // Defensive check: AbortSignal is the standard browser/Node API.
  // Reject plain objects so we don't crash inside the native bridge.
  if (typeof AbortSignal !== 'undefined' && candidate instanceof AbortSignal) {
    return candidate;
  }
  return undefined;
}

// ---------- Config ----------

type EnvLike = NodeJS.ProcessEnv;

/**
 * Resolve the runtime `MongoSqlConfig` from constructor overrides + env.
 *
 * URI building lives in `./config.ts` — see that module's header for
 * the env vars honoured, the precedence rules (constructor uri >
 * `CUBEJS_DB_URL` > `CUBEJS_DB_URI` > composed from `CUBEJS_DB_HOST`
 * + parts), and the duration-string format accepted by
 * `CUBEJS_DB_QUERY_TIMEOUT` / `CUBEJS_DB_IDLE_TIMEOUT`.
 *
 * Everything else stays here:
 *   - `database` (required): explicit > `CUBEJS_DB_NAME`.
 *   - `schemaSource`, `schemaRefreshSec`, `schemaFailOpen`, `maxRows`:
 *     existing `CUBEJS_MONGOSQL_*` semantics, unchanged.
 *   - `queryTimeoutMs`: explicit > `CUBEJS_DB_QUERY_TIMEOUT` >
 *     `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS` (resolved in config.ts).
 */
function buildConfig(override: Partial<MongoSqlConfig> | undefined, env: EnvLike): MongoSqlConfig {
  const { uri, queryTimeoutMs: envQueryTimeoutMs } = resolveUriConfig(override?.uri, env);

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
    queryTimeoutMs: override?.queryTimeoutMs ?? envQueryTimeoutMs,
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
  // Atlas SQL endpoints (`*.a.query.mongodb.net`) do not expose
  // `__sql_schemas` as a queryable collection — schemas live in an
  // internal store reachable only via the `sqlGetSchema` admin command.
  // See https://www.mongodb.com/docs/sql-interface/schema/view/ and
  // `crates/native/src/schema.rs` module docs.
  if (kind === 'atlas-sql') return { kind: 'atlas-sql' };
  throw configInvalid(`CUBEJS_MONGOSQL_SCHEMA_SOURCE must be 'collection', 'file', or 'atlas-sql' (got '${kind}')`);
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
