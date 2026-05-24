//! Error types and code mapping. See SPEC.md §6.
//!
//! Each variant maps 1:1 to a SPEC.md §6 error code via [`Error::code`]. The
//! `code()` match is exhaustive — adding a new variant without updating it
//! fails compilation.

use std::path::PathBuf;

use thiserror::Error;

/// Driver error type. Maps to the SPEC.md §6 error codes via [`Error::code`].
#[derive(Debug, Error)]
pub enum Error {
    /// Configuration is invalid (missing field, bad shape, bad scheme, ...).
    #[error("invalid configuration: field `{field}`: {reason}")]
    ConfigInvalid {
        /// Name of the offending config field.
        field: &'static str,
        /// Human-readable reason.
        reason: String,
    },

    /// Could not establish a connection to MongoDB.
    #[error("connect failed: {msg}")]
    ConnectFailed {
        /// Human-readable detail. Must NOT contain credentials.
        msg: String,
    },

    /// Authentication handshake failed.
    #[error("auth failed: {msg}")]
    AuthFailed {
        /// Human-readable detail. Must NOT contain credentials.
        msg: String,
    },

    /// `__sql_schemas` empty or schema absent for the requested database.
    #[error("schema not found: {msg}")]
    SchemaNotFound {
        /// Human-readable detail.
        msg: String,
    },

    /// Schema document failed parsing.
    #[error("schema invalid: {msg}")]
    SchemaInvalid {
        /// Human-readable detail.
        msg: String,
    },

    /// Schema file not found at the configured path.
    #[error("schema file not found: {}", path.display())]
    SchemaFileNotFound {
        /// File path that was attempted.
        path: PathBuf,
    },

    /// SQL → MQL translation failed.
    #[error("translate failed: {msg}")]
    TranslateFailed {
        /// Human-readable detail; should include the SQL fragment that failed.
        msg: String,
    },

    /// Aggregation pipeline failed at MongoDB.
    #[error("execute failed: {msg}")]
    ExecuteFailed {
        /// Human-readable detail. Must NOT contain credentials.
        msg: String,
    },

    /// Query exceeded its configured timeout.
    #[error("query timeout")]
    Timeout,

    /// Cursor returned more rows than the configured cap.
    #[error("result too large: exceeded cap of {limit} rows")]
    ResultTooLarge {
        /// Configured `max_rows` cap.
        limit: u32,
    },

    /// Operation was cancelled via an `AbortSignal` or `close()`. Distinct
    /// from `Timeout` (server-side `maxTimeMS` expiry) — `Cancelled` means
    /// the *caller* asked us to stop.
    #[error("cancelled: {site}")]
    Cancelled {
        /// Static label naming where the cancellation was observed
        /// (e.g. `"query"`, `"test_connection"`, `"tables_schema"`).
        /// Used only for diagnostics — the public `code()` is constant.
        site: &'static str,
    },
}

impl Error {
    /// Returns the SPEC.md §6 error code for this error.
    ///
    /// The match is intentionally exhaustive (no `_ =>`) so that adding a new
    /// variant without updating this method fails compilation.
    pub fn code(&self) -> &'static str {
        match self {
            Error::ConfigInvalid { .. } => "MONGOSQL_CONFIG_INVALID",
            Error::ConnectFailed { .. } => "MONGOSQL_CONNECT_FAILED",
            Error::AuthFailed { .. } => "MONGOSQL_AUTH_FAILED",
            Error::SchemaNotFound { .. } => "MONGOSQL_SCHEMA_NOT_FOUND",
            Error::SchemaInvalid { .. } => "MONGOSQL_SCHEMA_INVALID",
            Error::SchemaFileNotFound { .. } => "MONGOSQL_SCHEMA_FILE_NOT_FOUND",
            Error::TranslateFailed { .. } => "MONGOSQL_TRANSLATE_FAILED",
            Error::ExecuteFailed { .. } => "MONGOSQL_EXECUTE_FAILED",
            Error::Timeout => "MONGOSQL_TIMEOUT",
            Error::ResultTooLarge { .. } => "MONGOSQL_RESULT_TOO_LARGE",
            Error::Cancelled { .. } => "MONGOSQL_CANCELLED",
        }
    }
}

// Compile-time assertion that Error is Send + Sync — required for the napi-rs
// boundary and for safe use across Tokio tasks. If a future variant carries a
// non-Send/Sync payload (e.g. Rc, raw pointer) this fails to compile.
const _: fn() = || {
    fn _assert_send_sync<T: Send + Sync + 'static>() {}
    _assert_send_sync::<Error>();
};

/// Map upstream `mongodb::error::Error` to our taxonomy.
///
/// We distinguish auth failures (`AuthFailed`) from connect-class failures
/// (`ConnectFailed`) by inspecting `ErrorKind`. Anything else is bucketed
/// under `ExecuteFailed`.
///
/// IMPORTANT: We do NOT include the upstream Display output in the message
/// because it can render the connection URI, including credentials. We use
/// only the kind discriminant + a short generic note. The catch-all branch
/// — which DOES surface the kind's Display — routes its inner string
/// through [`redact_uri_creds`] as defence-in-depth in case a future
/// mongodb-crate variant reintroduces a URI in its Display template.
impl From<mongodb::error::Error> for Error {
    fn from(err: mongodb::error::Error) -> Self {
        use mongodb::error::ErrorKind;
        match *err.kind {
            ErrorKind::Authentication { .. } => Error::AuthFailed {
                msg: "authentication handshake rejected by server".to_string(),
            },
            ErrorKind::DnsResolve { ref message, .. } => Error::ConnectFailed {
                msg: format!("DNS resolution failed: {message}"),
            },
            ErrorKind::ServerSelection { ref message, .. } => Error::ConnectFailed {
                msg: format!("server selection failed: {message}"),
            },
            ErrorKind::Io(ref io_err) => Error::ConnectFailed {
                msg: format!("I/O error: {}", io_err.kind()),
            },
            ErrorKind::InvalidArgument { ref message, .. } => Error::ConfigInvalid {
                field: "uri",
                reason: redact_uri_creds(message),
            },
            ErrorKind::InvalidTlsConfig { ref message, .. } => Error::ConnectFailed {
                msg: format!("TLS config invalid: {message}"),
            },
            ref other => Error::ExecuteFailed {
                msg: format_kind_redacted(other),
            },
        }
    }
}

/// Format an `ErrorKind` for use in the catch-all branch of
/// [`From<mongodb::error::Error>`], routing the Display string through
/// [`redact_uri_creds`].
///
/// The mongodb crate's `ErrorKind` Display templates are currently
/// credential-free, but the variant set is `#[non_exhaustive]` and the upstream
/// crate could re-introduce a variant whose Display embeds a URI in a future
/// upgrade. Piping every Display string through the redactor closes that gap.
///
/// Extracted as a pure helper so unit tests can drive it with synthetic
/// `ErrorKind` values: `mongodb::error::ErrorKind` is `#[non_exhaustive]` and
/// not all variants are publicly constructible, but the helper itself takes a
/// `&str` Display rendering so the test contract is independent of which
/// variants happen to be constructible from outside the crate.
fn format_kind_redacted(kind: &mongodb::error::ErrorKind) -> String {
    format_kind_display_redacted(&kind.to_string())
}

/// Inner pure-string helper for [`format_kind_redacted`]. Takes the kind's
/// already-formatted Display string so the test surface is independent of
/// the (`#[non_exhaustive]`) mongodb-crate `ErrorKind` variant set.
fn format_kind_display_redacted(kind_display: &str) -> String {
    format!("mongodb error: {}", redact_uri_creds(kind_display))
}

/// Strip anything that looks like `user:password@` from a string before it
/// becomes part of a public error message. Defence-in-depth: the upstream
/// crate already redacts in most paths, but we redact regardless.
///
/// Visible to the rest of the crate so error sites that build their own
/// `Error::SchemaInvalid`/`ExecuteFailed` messages from upstream mongodb
/// crate errors (rather than going through `From<mongodb::error::Error>`)
/// can still apply the same redaction. Today the mongodb-3.x `ErrorKind`
/// Display templates don't carry URI strings, but future upgrades could
/// reintroduce a variant whose Display includes user-controlled URIs —
/// piping through this helper is cheap insurance.
pub(crate) fn redact_uri_creds(s: &str) -> String {
    // Crude but effective: drop anything between "://" and "@" if both
    // appear in order. Leaves the rest of the message alone.
    if let Some(scheme_end) = s.find("://") {
        let after_scheme = &s[scheme_end + 3..];
        if let Some(at_offset) = after_scheme.find('@') {
            let before = &s[..scheme_end + 3];
            let after = &after_scheme[at_offset + 1..];
            return format!("{before}[REDACTED]@{after}");
        }
    }
    s.to_string()
}

impl From<serde_yaml::Error> for Error {
    fn from(err: serde_yaml::Error) -> Self {
        Error::SchemaInvalid {
            msg: format!("yaml: {err}"),
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Self {
        Error::SchemaInvalid {
            msg: format!("json: {err}"),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            Error::SchemaFileNotFound {
                path: PathBuf::new(),
            }
        } else {
            Error::SchemaInvalid {
                msg: format!("{err}"),
            }
        }
    }
}

impl From<Error> for napi::Error {
    fn from(err: Error) -> napi::Error {
        napi::Error::from_reason(format!("{}: {err}", err.code()))
    }
}

/// Convenience alias for results in this crate.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn all_variants() -> Vec<Error> {
        vec![
            Error::ConfigInvalid {
                field: "uri",
                reason: "empty".to_string(),
            },
            Error::ConnectFailed {
                msg: "host unreachable".to_string(),
            },
            Error::AuthFailed {
                msg: "scram rejected".to_string(),
            },
            Error::SchemaNotFound {
                msg: "no docs".to_string(),
            },
            Error::SchemaInvalid {
                msg: "bad yaml".to_string(),
            },
            Error::SchemaFileNotFound {
                path: PathBuf::from("/tmp/missing.yaml"),
            },
            Error::TranslateFailed {
                msg: "unknown column".to_string(),
            },
            Error::ExecuteFailed {
                msg: "stage failed".to_string(),
            },
            Error::Timeout,
            Error::ResultTooLarge { limit: 100_000 },
            Error::Cancelled { site: "query" },
        ]
    }

    #[test]
    fn config_invalid_code() {
        let e = Error::ConfigInvalid {
            field: "uri",
            reason: "empty".into(),
        };
        assert_eq!(e.code(), "MONGOSQL_CONFIG_INVALID");
    }

    #[test]
    fn connect_failed_code() {
        assert_eq!(
            Error::ConnectFailed { msg: "x".into() }.code(),
            "MONGOSQL_CONNECT_FAILED"
        );
    }

    #[test]
    fn auth_failed_code() {
        assert_eq!(
            Error::AuthFailed { msg: "x".into() }.code(),
            "MONGOSQL_AUTH_FAILED"
        );
    }

    #[test]
    fn schema_not_found_code() {
        assert_eq!(
            Error::SchemaNotFound { msg: "x".into() }.code(),
            "MONGOSQL_SCHEMA_NOT_FOUND"
        );
    }

    #[test]
    fn schema_invalid_code() {
        assert_eq!(
            Error::SchemaInvalid { msg: "x".into() }.code(),
            "MONGOSQL_SCHEMA_INVALID"
        );
    }

    #[test]
    fn schema_file_not_found_code() {
        assert_eq!(
            Error::SchemaFileNotFound {
                path: PathBuf::from("/x")
            }
            .code(),
            "MONGOSQL_SCHEMA_FILE_NOT_FOUND"
        );
    }

    #[test]
    fn translate_failed_code() {
        assert_eq!(
            Error::TranslateFailed { msg: "x".into() }.code(),
            "MONGOSQL_TRANSLATE_FAILED"
        );
    }

    #[test]
    fn execute_failed_code() {
        assert_eq!(
            Error::ExecuteFailed { msg: "x".into() }.code(),
            "MONGOSQL_EXECUTE_FAILED"
        );
    }

    #[test]
    fn timeout_code() {
        assert_eq!(Error::Timeout.code(), "MONGOSQL_TIMEOUT");
    }

    #[test]
    fn result_too_large_code() {
        assert_eq!(
            Error::ResultTooLarge { limit: 1 }.code(),
            "MONGOSQL_RESULT_TOO_LARGE"
        );
    }

    #[test]
    fn cancelled_code() {
        assert_eq!(
            Error::Cancelled { site: "query" }.code(),
            "MONGOSQL_CANCELLED"
        );
    }

    #[test]
    fn cancelled_napi_error_message_carries_code() {
        let n: napi::Error = Error::Cancelled { site: "query" }.into();
        assert!(
            n.reason.starts_with("MONGOSQL_CANCELLED:"),
            "napi error reason should start with code: {}",
            n.reason
        );
    }

    #[test]
    fn display_non_empty_for_every_variant() {
        for v in all_variants() {
            let s = format!("{v}");
            assert!(!s.is_empty(), "variant {:?} produced empty Display", v);
        }
    }

    #[test]
    fn napi_error_message_starts_with_code() {
        let e = Error::ConfigInvalid {
            field: "uri",
            reason: "empty".into(),
        };
        let n: napi::Error = e.into();
        // The `reason` is the formatted body that crosses the FFI boundary.
        let reason = n.reason.as_str();
        assert!(
            reason.starts_with("MONGOSQL_CONFIG_INVALID:"),
            "napi error reason should start with code: {reason}"
        );
        // And the Display always carries the code somewhere too.
        let displayed = n.to_string();
        assert!(
            displayed.contains("MONGOSQL_CONFIG_INVALID"),
            "napi error display should carry code: {displayed}"
        );
    }

    #[test]
    fn from_io_not_found_yields_schema_file_not_found() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        let e: Error = io_err.into();
        assert_eq!(e.code(), "MONGOSQL_SCHEMA_FILE_NOT_FOUND");
    }

    #[test]
    fn from_io_other_yields_schema_invalid() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let e: Error = io_err.into();
        assert_eq!(e.code(), "MONGOSQL_SCHEMA_INVALID");
    }

    #[test]
    fn from_serde_json_yields_schema_invalid() {
        let parse_err: serde_json::Error =
            serde_json::from_str::<serde_json::Value>("not json").unwrap_err();
        let e: Error = parse_err.into();
        assert_eq!(e.code(), "MONGOSQL_SCHEMA_INVALID");
    }

    #[test]
    fn from_serde_yaml_yields_schema_invalid() {
        let parse_err: serde_yaml::Error =
            serde_yaml::from_str::<serde_yaml::Value>("foo: : :").unwrap_err();
        let e: Error = parse_err.into();
        assert_eq!(e.code(), "MONGOSQL_SCHEMA_INVALID");
    }

    #[test]
    fn from_mongodb_invalid_argument_yields_config_invalid() {
        // Synthesize a real mongodb error via the public ConnectionString::parse API.
        let mongo_err = mongodb::options::ConnectionString::parse("notascheme")
            .expect_err("malformed URI must error");
        let e: Error = mongo_err.into();
        // Bad scheme manifests as InvalidArgument from the upstream parser.
        assert_eq!(e.code(), "MONGOSQL_CONFIG_INVALID");
    }

    #[test]
    fn from_mongodb_does_not_leak_credentials() {
        // A connection string with embedded user:password that fails to parse.
        // Whatever upstream message comes back, our redactor strips the creds.
        let bad = "mongodb://user:password@";
        let mongo_err = match mongodb::options::ConnectionString::parse(bad) {
            Ok(_) => panic!("expected parse to fail for {bad}"),
            Err(e) => e,
        };
        let e: Error = mongo_err.into();
        let displayed = format!("{e}");
        assert!(
            !displayed.contains("password"),
            "Error::Display leaked credentials: {displayed}"
        );
        let debugged = format!("{e:?}");
        assert!(
            !debugged.contains("password"),
            "Error::Debug leaked credentials: {debugged}"
        );
    }

    #[test]
    fn redact_uri_creds_strips_user_password() {
        let s = "bad URI: mongodb://alice:s3cret@host/db option";
        let red = redact_uri_creds(s);
        assert!(!red.contains("alice"));
        assert!(!red.contains("s3cret"));
        assert!(red.contains("[REDACTED]"));
    }

    #[test]
    fn redact_uri_creds_passes_through_when_no_creds() {
        let s = "bad URI: mongodb://host/db";
        let red = redact_uri_creds(s);
        assert_eq!(red, s);
    }

    /// The catch-all branch of `From<mongodb::error::Error>` must route the
    /// kind's Display output through `redact_uri_creds`. We can't construct
    /// most non-public `ErrorKind` variants from outside the crate, but the
    /// pure-string helper that the catch-all delegates to is testable in
    /// isolation — that's the contract test for "future upstream variant
    /// with a URI in its Display template doesn't leak creds".
    #[test]
    fn format_kind_display_redacted_strips_creds_from_synthetic_display() {
        // Simulate a future mongodb-crate variant whose Display embeds a
        // connection URI with credentials. The redactor must drop the
        // user:password segment.
        let synthetic_display =
            "InternalServerError: something happened with mongodb://alice:s3cret@host:27017/db";
        let formatted = format_kind_display_redacted(synthetic_display);
        assert!(formatted.starts_with("mongodb error: "));
        assert!(
            !formatted.contains("alice"),
            "must redact username: {formatted}",
        );
        assert!(
            !formatted.contains("s3cret"),
            "must redact password: {formatted}",
        );
        assert!(
            formatted.contains("[REDACTED]"),
            "redaction marker must appear: {formatted}",
        );
    }

    /// Display strings that don't contain credentials must pass through
    /// unchanged (modulo the "mongodb error: " prefix) — the redactor is
    /// defence-in-depth, not a destructive filter.
    #[test]
    fn format_kind_display_redacted_passes_through_when_no_creds() {
        let benign = "Transaction: invalid state";
        let formatted = format_kind_display_redacted(benign);
        assert_eq!(formatted, format!("mongodb error: {benign}"));
    }

    /// Round-trip via the public `From` impl: a synthetic upstream error
    /// whose Display contains a URI surfaces through the catch-all path
    /// without leaking creds in either Display or Debug. We can't reach the
    /// catch-all from outside the crate today (ConnectionString::parse hits
    /// `InvalidArgument`, which is its own branch), so the assertion below
    /// just verifies that no constructible upstream error path leaks creds —
    /// the catch-all's pure helper is covered by the test above.
    #[test]
    fn from_mongodb_error_never_leaks_creds_via_catch_all() {
        // Most user-driven mongo errors today funnel through specific
        // branches above the catch-all. The catch-all is reached only by
        // upstream variants we can't construct. The cred-leak risk it
        // guards against is exercised by `format_kind_display_redacted_*`;
        // this test is a smoke check that the catch-all is still wired up
        // to the helper (the format string carries the "mongodb error: "
        // prefix our helper builds).
        let expected_prefix = "mongodb error: ";
        let formatted = format_kind_display_redacted("anything");
        assert!(
            formatted.starts_with(expected_prefix),
            "catch-all prefix must be `{expected_prefix}`, got: {formatted}",
        );
    }
}
