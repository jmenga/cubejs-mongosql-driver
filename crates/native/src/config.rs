//! Client configuration. See SPEC.md §5.2.
//!
//! Implementation arrives in T03.

use crate::error::{Error, Result};

/// Schema source — Collection or File mode.
#[napi(object)]
pub struct SchemaSource {
    /// "collection" or "file"
    pub kind: String,
    /// Path to schema file (file mode only)
    pub path: Option<String>,
}

/// Client configuration object passed across the napi-rs boundary.
#[napi(object)]
pub struct ClientConfig {
    /// MongoDB connection URI.
    pub uri: String,
    /// Database name to query.
    pub database: String,
    /// Schema source. None defaults to Collection.
    pub schema_source: Option<SchemaSource>,
    /// Refresh interval in seconds. None defaults to 300.
    pub schema_refresh_sec: Option<u32>,
    /// If true, testConnection succeeds even on initial schema load failure. None defaults to false.
    pub schema_fail_open: Option<bool>,
    /// Per-query timeout in milliseconds. None defaults to 60000.
    pub query_timeout_ms: Option<u32>,
}

impl ClientConfig {
    /// Validates the config. Returns Err with an actionable message.
    pub fn validate(&self) -> Result<()> {
        // T03 will implement; this stub keeps the workspace compiling.
        let _ = self;
        Err(Error::Unimplemented("ClientConfig::validate"))
    }
}
