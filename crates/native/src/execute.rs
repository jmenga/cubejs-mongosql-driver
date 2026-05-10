//! Query executor and BSON → JSON marshaling. See ARCHITECTURE.md §4.2.
//!
//! Implementation arrives in T08.

use crate::error::{Error, Result};
use crate::translate::Translation;

/// Execute the given translation and return rows as a JSON array.
#[allow(dead_code)]
pub async fn execute(
    _client: &mongodb::Client,
    _translation: Translation,
    _timeout_ms: u32,
) -> Result<serde_json::Value> {
    Err(Error::Unimplemented("execute"))
}

/// Convert a BSON document to a JSON value per the marshaling rules in
/// ARCHITECTURE.md §4.2.
#[allow(dead_code)]
pub fn bson_to_json(_doc: bson::Document) -> serde_json::Value {
    serde_json::Value::Null
}
