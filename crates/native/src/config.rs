//! Client configuration. See SPEC.md §5.2 and FR-7.
//!
//! The wire shape is what crosses the napi-rs boundary; defaults are filled
//! in at the napi-rs layer (TS side reads `process.env`). Validation runs at
//! `MongoSqlClient::new` time but is also exposed on its own so callers can
//! pre-flight a config before constructing a client.

use std::fmt;

use crate::error::{Error, Result};

/// Default schema refresh interval in seconds (SPEC FR-7).
pub const DEFAULT_SCHEMA_REFRESH_SEC: u32 = 300;
/// Default per-query timeout in milliseconds (SPEC FR-7).
pub const DEFAULT_QUERY_TIMEOUT_MS: u32 = 60_000;
/// Default row cap for buffered results (SPEC NFR-1, FR-7).
pub const DEFAULT_MAX_ROWS: u32 = 100_000;

/// Schema source — Collection mode, File mode, or Atlas SQL mode.
///
/// Wire shape across napi-rs is a tagged object. `kind` is one of
/// `"collection"`, `"file"`, or `"atlas-sql"`; `path` is required for
/// `"file"`. See `schema.rs` module docs for the per-mode loading
/// strategy.
#[napi(object)]
#[derive(Clone)]
pub struct SchemaSource {
    /// Discriminant: `"collection"`, `"file"`, or `"atlas-sql"`.
    pub kind: String,
    /// Path to schema file (file mode only).
    pub path: Option<String>,
}

/// Client configuration object passed across the napi-rs boundary.
///
/// `Debug` is hand-rolled to **redact the URI** because it may contain
/// credentials (SPEC NFR-4).
#[napi(object)]
#[derive(Clone)]
pub struct ClientConfig {
    /// MongoDB connection URI. **Sensitive: contains credentials.**
    pub uri: String,
    /// Database name to query.
    pub database: String,
    /// Schema source. None defaults to Collection (handled by `with_defaults_applied`).
    pub schema_source: Option<SchemaSource>,
    /// Refresh interval in seconds. None defaults to 300.
    pub schema_refresh_sec: Option<u32>,
    /// If true, testConnection succeeds even on initial schema load failure. None defaults to false.
    pub schema_fail_open: Option<bool>,
    /// Per-query timeout in milliseconds. None defaults to 60000.
    pub query_timeout_ms: Option<u32>,
    /// Max rows returned per query (buffered). None defaults to 100000.
    pub max_rows: Option<u32>,
}

impl fmt::Debug for ClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientConfig")
            .field("uri", &redact_uri(&self.uri))
            .field("database", &self.database)
            .field(
                "schema_source",
                &self.schema_source.as_ref().map(SchemaSource::kind_str),
            )
            .field("schema_refresh_sec", &self.schema_refresh_sec)
            .field("schema_fail_open", &self.schema_fail_open)
            .field("query_timeout_ms", &self.query_timeout_ms)
            .field("max_rows", &self.max_rows)
            .finish()
    }
}

impl SchemaSource {
    /// Returns the discriminant as a string slice.
    pub fn kind_str(&self) -> &str {
        self.kind.as_str()
    }
}

impl ClientConfig {
    /// Returns the schema source kind, defaulting to `"collection"` if unset.
    pub fn schema_source_kind(&self) -> &str {
        self.schema_source
            .as_ref()
            .map(SchemaSource::kind_str)
            .unwrap_or("collection")
    }

    /// Validates the config. Returns `Err(Error::ConfigInvalid { .. })` on the
    /// first failure encountered.
    pub fn validate(&self) -> Result<()> {
        if self.uri.trim().is_empty() {
            return Err(Error::ConfigInvalid {
                field: "uri",
                reason: "must not be empty".to_string(),
            });
        }
        if !(self.uri.starts_with("mongodb://") || self.uri.starts_with("mongodb+srv://")) {
            return Err(Error::ConfigInvalid {
                field: "uri",
                reason: "must start with `mongodb://` or `mongodb+srv://`".to_string(),
            });
        }
        if self.database.trim().is_empty() {
            return Err(Error::ConfigInvalid {
                field: "database",
                reason: "must not be empty".to_string(),
            });
        }

        if let Some(src) = &self.schema_source {
            match src.kind.as_str() {
                "collection" | "atlas-sql" => {}
                "file" => match &src.path {
                    Some(p) if !p.trim().is_empty() => {}
                    _ => {
                        return Err(Error::ConfigInvalid {
                            field: "schema_source.path",
                            reason: "required when schema_source.kind = \"file\"".to_string(),
                        });
                    }
                },
                other => {
                    return Err(Error::ConfigInvalid {
                        field: "schema_source.kind",
                        reason: format!(
                            "must be \"collection\", \"file\", or \"atlas-sql\"; got \"{other}\""
                        ),
                    });
                }
            }
        }

        if let Some(0) = self.schema_refresh_sec {
            return Err(Error::ConfigInvalid {
                field: "schema_refresh_sec",
                reason: "must be > 0".to_string(),
            });
        }
        if let Some(0) = self.query_timeout_ms {
            return Err(Error::ConfigInvalid {
                field: "query_timeout_ms",
                reason: "must be > 0".to_string(),
            });
        }
        if let Some(0) = self.max_rows {
            return Err(Error::ConfigInvalid {
                field: "max_rows",
                reason: "must be > 0".to_string(),
            });
        }

        Ok(())
    }

    /// Returns the config with defaults applied for any unset / zero fields.
    /// This is the "effective config" the rest of the driver uses.
    pub fn with_defaults_applied(mut self) -> Self {
        if self.schema_source.is_none() {
            self.schema_source = Some(SchemaSource {
                kind: "collection".to_string(),
                path: None,
            });
        }
        if self.schema_refresh_sec.unwrap_or(0) == 0 {
            self.schema_refresh_sec = Some(DEFAULT_SCHEMA_REFRESH_SEC);
        }
        if self.schema_fail_open.is_none() {
            self.schema_fail_open = Some(false);
        }
        if self.query_timeout_ms.unwrap_or(0) == 0 {
            self.query_timeout_ms = Some(DEFAULT_QUERY_TIMEOUT_MS);
        }
        if self.max_rows.unwrap_or(0) == 0 {
            self.max_rows = Some(DEFAULT_MAX_ROWS);
        }
        self
    }
}

/// Reduce a connection URI down to its scheme so that logs and Debug output
/// never carry credentials. Anything with `://` keeps the prefix and is
/// otherwise replaced with `[REDACTED]`. Strings without `://` are also
/// fully redacted as a defensive default.
fn redact_uri(uri: &str) -> String {
    if let Some(scheme_end) = uri.find("://") {
        let scheme = &uri[..scheme_end];
        format!("{scheme}://[REDACTED]")
    } else {
        "[REDACTED]".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_config() -> ClientConfig {
        ClientConfig {
            uri: "mongodb://host/db".to_string(),
            database: "db".to_string(),
            schema_source: Some(SchemaSource {
                kind: "collection".to_string(),
                path: None,
            }),
            schema_refresh_sec: Some(300),
            schema_fail_open: Some(false),
            query_timeout_ms: Some(60_000),
            max_rows: Some(100_000),
        }
    }

    #[test]
    fn validate_accepts_full_valid_config() {
        valid_config().validate().expect("valid config must pass");
    }

    #[test]
    fn validate_accepts_srv_scheme() {
        let mut c = valid_config();
        c.uri = "mongodb+srv://atlas.example.com/db".to_string();
        c.validate().expect("srv scheme is valid");
    }

    #[test]
    fn validate_rejects_empty_uri() {
        let mut c = valid_config();
        c.uri = String::new();
        match c.validate() {
            Err(Error::ConfigInvalid { field, .. }) => assert_eq!(field, "uri"),
            other => panic!("expected ConfigInvalid(uri), got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_whitespace_uri() {
        let mut c = valid_config();
        c.uri = "   ".to_string();
        match c.validate() {
            Err(Error::ConfigInvalid { field, .. }) => assert_eq!(field, "uri"),
            other => panic!("expected ConfigInvalid(uri), got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_bad_scheme() {
        let mut c = valid_config();
        c.uri = "http://example.com/db".to_string();
        match c.validate() {
            Err(Error::ConfigInvalid { field, reason }) => {
                assert_eq!(field, "uri");
                assert!(reason.contains("mongodb"));
            }
            other => panic!("expected ConfigInvalid(uri), got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_empty_database() {
        let mut c = valid_config();
        c.database = String::new();
        match c.validate() {
            Err(Error::ConfigInvalid { field, .. }) => assert_eq!(field, "database"),
            other => panic!("expected ConfigInvalid(database), got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_file_schema_without_path() {
        let mut c = valid_config();
        c.schema_source = Some(SchemaSource {
            kind: "file".to_string(),
            path: None,
        });
        match c.validate() {
            Err(Error::ConfigInvalid { field, .. }) => {
                assert_eq!(field, "schema_source.path")
            }
            other => panic!("expected ConfigInvalid(schema_source.path), got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_file_schema_with_empty_path() {
        let mut c = valid_config();
        c.schema_source = Some(SchemaSource {
            kind: "file".to_string(),
            path: Some(String::new()),
        });
        match c.validate() {
            Err(Error::ConfigInvalid { field, .. }) => {
                assert_eq!(field, "schema_source.path")
            }
            other => panic!("expected ConfigInvalid(schema_source.path), got {other:?}"),
        }
    }

    #[test]
    fn validate_accepts_file_schema_with_path() {
        let mut c = valid_config();
        c.schema_source = Some(SchemaSource {
            kind: "file".to_string(),
            path: Some("/etc/cube/schema.yaml".to_string()),
        });
        c.validate().expect("file mode with path is valid");
    }

    #[test]
    fn validate_rejects_unknown_schema_kind() {
        let mut c = valid_config();
        c.schema_source = Some(SchemaSource {
            kind: "wat".to_string(),
            path: None,
        });
        match c.validate() {
            Err(Error::ConfigInvalid { field, reason }) => {
                assert_eq!(field, "schema_source.kind");
                // Error message must enumerate all three valid modes so
                // operators can self-correct without consulting docs.
                assert!(reason.contains("collection"), "reason: {reason}");
                assert!(reason.contains("file"), "reason: {reason}");
                assert!(reason.contains("atlas-sql"), "reason: {reason}");
            }
            other => panic!("expected ConfigInvalid(schema_source.kind), got {other:?}"),
        }
    }

    #[test]
    fn validate_accepts_atlas_sql_schema_source() {
        let mut c = valid_config();
        c.schema_source = Some(SchemaSource {
            kind: "atlas-sql".to_string(),
            path: None,
        });
        c.validate().expect("atlas-sql is a valid kind");
    }

    #[test]
    fn validate_accepts_atlas_sql_with_ignored_path() {
        // atlas-sql does NOT require `path`; defensive policy is to ignore
        // a stray path rather than reject it (mirrors collection mode).
        let mut c = valid_config();
        c.schema_source = Some(SchemaSource {
            kind: "atlas-sql".to_string(),
            path: Some("/tmp/ignored.yaml".to_string()),
        });
        c.validate().expect("atlas-sql + spurious path still valid");
    }

    #[test]
    fn with_defaults_applied_preserves_atlas_sql_kind() {
        let c = ClientConfig {
            uri: "mongodb://host/db".to_string(),
            database: "db".to_string(),
            schema_source: Some(SchemaSource {
                kind: "atlas-sql".to_string(),
                path: None,
            }),
            schema_refresh_sec: None,
            schema_fail_open: None,
            query_timeout_ms: None,
            max_rows: None,
        }
        .with_defaults_applied();
        assert_eq!(c.schema_source_kind(), "atlas-sql");
    }

    #[test]
    fn validate_rejects_zero_refresh_sec() {
        let mut c = valid_config();
        c.schema_refresh_sec = Some(0);
        match c.validate() {
            Err(Error::ConfigInvalid { field, .. }) => {
                assert_eq!(field, "schema_refresh_sec")
            }
            other => panic!("expected ConfigInvalid(schema_refresh_sec), got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_zero_query_timeout() {
        let mut c = valid_config();
        c.query_timeout_ms = Some(0);
        match c.validate() {
            Err(Error::ConfigInvalid { field, .. }) => assert_eq!(field, "query_timeout_ms"),
            other => panic!("expected ConfigInvalid(query_timeout_ms), got {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_zero_max_rows() {
        let mut c = valid_config();
        c.max_rows = Some(0);
        match c.validate() {
            Err(Error::ConfigInvalid { field, .. }) => assert_eq!(field, "max_rows"),
            other => panic!("expected ConfigInvalid(max_rows), got {other:?}"),
        }
    }

    #[test]
    fn debug_redacts_uri_credentials() {
        let c = ClientConfig {
            uri: "mongodb://user:password@host/db".to_string(),
            ..valid_config()
        };
        let s = format!("{c:?}");
        assert!(!s.contains("password"), "Debug leaked password: {s}");
        assert!(!s.contains("user"), "Debug leaked username: {s}");
        assert!(s.contains("[REDACTED]"));
        assert!(s.contains("mongodb://"));
    }

    #[test]
    fn debug_redacts_srv_uri_credentials() {
        let c = ClientConfig {
            uri: "mongodb+srv://u:p@cluster.mongodb.net/db".to_string(),
            ..valid_config()
        };
        let s = format!("{c:?}");
        assert!(!s.contains(":p@"));
        assert!(s.contains("mongodb+srv://[REDACTED]"));
    }

    #[test]
    fn with_defaults_applied_fills_missing_fields() {
        let c = ClientConfig {
            uri: "mongodb://host/db".to_string(),
            database: "db".to_string(),
            schema_source: None,
            schema_refresh_sec: None,
            schema_fail_open: None,
            query_timeout_ms: None,
            max_rows: None,
        }
        .with_defaults_applied();

        assert_eq!(c.schema_source_kind(), "collection");
        assert_eq!(c.schema_refresh_sec, Some(DEFAULT_SCHEMA_REFRESH_SEC));
        assert_eq!(c.schema_fail_open, Some(false));
        assert_eq!(c.query_timeout_ms, Some(DEFAULT_QUERY_TIMEOUT_MS));
        assert_eq!(c.max_rows, Some(DEFAULT_MAX_ROWS));
    }

    #[test]
    fn with_defaults_applied_treats_zero_as_unset() {
        let c = ClientConfig {
            uri: "mongodb://host/db".to_string(),
            database: "db".to_string(),
            schema_source: None,
            schema_refresh_sec: Some(0),
            schema_fail_open: None,
            query_timeout_ms: Some(0),
            max_rows: Some(0),
        }
        .with_defaults_applied();

        assert_eq!(c.schema_refresh_sec, Some(DEFAULT_SCHEMA_REFRESH_SEC));
        assert_eq!(c.query_timeout_ms, Some(DEFAULT_QUERY_TIMEOUT_MS));
        assert_eq!(c.max_rows, Some(DEFAULT_MAX_ROWS));
    }

    #[test]
    fn with_defaults_applied_preserves_explicit_values() {
        let c = ClientConfig {
            uri: "mongodb://host/db".to_string(),
            database: "db".to_string(),
            schema_source: Some(SchemaSource {
                kind: "file".to_string(),
                path: Some("/etc/x".to_string()),
            }),
            schema_refresh_sec: Some(60),
            schema_fail_open: Some(true),
            query_timeout_ms: Some(5_000),
            max_rows: Some(1_000),
        }
        .with_defaults_applied();

        assert_eq!(c.schema_source_kind(), "file");
        assert_eq!(c.schema_refresh_sec, Some(60));
        assert_eq!(c.schema_fail_open, Some(true));
        assert_eq!(c.query_timeout_ms, Some(5_000));
        assert_eq!(c.max_rows, Some(1_000));
    }

    #[test]
    fn schema_source_kind_helper() {
        let c = valid_config();
        assert_eq!(c.schema_source_kind(), "collection");
    }
}
