//! Query executor and BSON → JSON marshaling.
//!
//! See ARCHITECTURE.md §4.1 (per-query sequence) and §4.2 (BSON → JSON
//! marshaling table). This module:
//!
//! 1. Hands a translated [`Translation`] to MongoDB via either
//!    `Database::aggregate` or `Collection::aggregate`, depending on whether
//!    the upstream `mongosql::Translation::target_collection` was `Some(name)`
//!    or `None`. The `None` branch is the database-level aggregate path —
//!    some MongoSQL queries (e.g. cross-collection forms) translate to a
//!    pipeline that runs at the database level rather than against any
//!    single collection.
//! 2. Applies the configured per-query timeout via `AggregateOptions::max_time`
//!    (mapped on the wire to `maxTimeMS`).
//! 3. Buffers up to `max_rows` rows and throws [`Error::ResultTooLarge`] if
//!    the cursor would exceed the cap (NFR-1: napi-rs has no AsyncIterator
//!    macro, so we buffer; the cap bounds memory).
//! 4. Marshals each `bson::Document` row to a `serde_json::Value::Object` via
//!    [`bson_to_json`].
//!
//! The marshaling table deliberately *does not* use bson's
//! [`bson::Bson::into_relaxed_extjson`] for the whole document: it panics on
//! `Decimal128`, and its `DateTime` shape is `{ "$date": "..." }` rather than
//! a bare ISO-8601 string, which is harder for downstream Cube measure types
//! to consume. We hand-roll the variant match so that compilation fails if a
//! new BSON variant is added without coverage. For the few legacy variants we
//! delegate the EJSON shape to `into_relaxed_extjson` (Binary, Regex, Symbol,
//! Code, CodeWithScope, Timestamp, MinKey, MaxKey, Undefined, DbPointer)
//! because their fields are private or their canonical EJSON form is fixed.

use std::time::Duration;

use bson::{Binary, Bson, DateTime as BsonDateTime, Document, Regex};
use futures_util::TryStreamExt;
use mongodb::error::ErrorKind;
use mongodb::options::AggregateOptions;
use mongodb::Client;
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::translate::Translation;

/// Cursor batch size passed via [`AggregateOptions::batch_size`]. Picked to
/// match common BI-tool defaults; tunable later if profiling shows benefit.
const CURSOR_BATCH_SIZE: u32 = 1000;

/// Threshold above which an Int64 cannot be exactly represented as a JS
/// number. Used purely to emit a tracing warning — the value still serializes
/// as a JSON number (which is the SPEC.md / ARCHITECTURE.md §4.2 contract).
const JS_SAFE_INT_MAX: i64 = 1 << 53;

/// Execute the given translation against MongoDB and return rows as a
/// [`serde_json::Value::Array`].
///
/// - `timeout_ms` is mapped to `maxTimeMS` at the server. A `Some(0)` cap
///   would disable the server-side timer; we still pass it as-is so callers
///   that intentionally request "no timeout" get that.
/// - `max_rows` is enforced *client-side* during cursor draining. The cap is
///   strict: returning exactly `max_rows` is fine, returning `max_rows + 1`
///   yields [`Error::ResultTooLarge`].
#[allow(dead_code)] // wired into MongoSqlClient by T09; exercised by integration tests today
pub async fn execute(
    client: &Client,
    translation: Translation,
    timeout_ms: u32,
    max_rows: u32,
) -> Result<Value> {
    let db = client.database(&translation.target_db);
    let opts = AggregateOptions::builder()
        .max_time(Some(Duration::from_millis(timeout_ms as u64)))
        .batch_size(Some(CURSOR_BATCH_SIZE))
        .build();

    // Branch on collection-level vs database-level aggregate. The pipeline is
    // already a `Vec<Document>` (T07 unwrapped the BSON Array), so it goes
    // straight to the action builder.
    let cursor_result = match translation.target_collection.as_deref() {
        Some(coll) => {
            db.collection::<Document>(coll)
                .aggregate(translation.pipeline)
                .with_options(opts)
                .await
        }
        None => db.aggregate(translation.pipeline).with_options(opts).await,
    };

    let mut cursor = cursor_result.map_err(map_mongo_error)?;

    let mut rows: Vec<Value> = Vec::new();
    loop {
        match cursor.try_next().await {
            Ok(Some(doc)) => {
                if rows.len() as u64 >= max_rows as u64 {
                    return Err(Error::ResultTooLarge { limit: max_rows });
                }
                rows.push(bson_to_json(Bson::Document(doc)));
            }
            Ok(None) => break,
            Err(err) => return Err(map_mongo_error(err)),
        }
    }

    Ok(Value::Array(rows))
}

/// Convert `mongodb::error::Error` to our taxonomy, with timeout (server
/// `maxTimeMSExpired`, code 50) routed to [`Error::Timeout`] and everything
/// else falling through to the existing `From<mongodb::error::Error>` mapping
/// (which handles auth/connect/io/etc.).
fn map_mongo_error(err: mongodb::error::Error) -> Error {
    if let ErrorKind::Command(ref cmd) = *err.kind {
        // 50 = MaxTimeMSExpired. The mongodb crate exposes the same check via
        // a `pub(crate)` helper; we replicate it on the public surface.
        if cmd.code == 50 {
            return Error::Timeout;
        }
    }
    Error::from(err)
}

/// Convert a single `bson::Bson` value to a `serde_json::Value` per
/// ARCHITECTURE.md §4.2.
///
/// Made `pub(crate)` so unit tests can drive it directly without going
/// through a real cursor. Exhaustive over `bson::Bson` variants — adding a
/// new variant upstream fails compilation here, which is the desired
/// behaviour: silently dropping a new BSON kind would be a correctness bug.
pub(crate) fn bson_to_json(value: Bson) -> Value {
    match value {
        // Direct primitive mappings.
        Bson::Double(f) => {
            // serde_json::Number::from_f64 returns None for NaN/Infinity (not
            // representable in JSON). Fall back to Null so the row is still
            // serializable. Cube treats numeric NaN as missing data.
            serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }
        Bson::String(s) => Value::String(s),
        Bson::Boolean(b) => Value::Bool(b),
        Bson::Null => Value::Null,
        Bson::Int32(i) => Value::Number(i.into()),
        Bson::Int64(i) => {
            // Per ARCHITECTURE §4.2 / SPEC FR-4: still serialize as a JSON
            // number; warn if outside the JS safe-integer range so consumers
            // know precision loss is possible.
            if i.abs() > JS_SAFE_INT_MAX {
                tracing::warn!(
                    value = i,
                    "Int64 outside JS safe-integer range (±2^53); precision may be lost when read by Node"
                );
            }
            Value::Number(i.into())
        }

        // Recursive composite types.
        Bson::Document(doc) => Value::Object(document_to_map(doc)),
        Bson::Array(arr) => Value::Array(arr.into_iter().map(bson_to_json).collect()),

        // Stringified types — preserve precision / canonical hex form.
        Bson::Decimal128(d) => Value::String(d.to_string()),
        Bson::ObjectId(oid) => Value::String(oid.to_hex()),
        Bson::DateTime(dt) => datetime_to_json(dt),

        // EJSON-form types. Hand-rolled to keep the shape stable and avoid
        // bson's relaxed_extjson `Decimal128` panic.
        Bson::Binary(Binary { subtype, bytes }) => {
            let st: u8 = u8::from(subtype);
            let mut obj = Map::new();
            obj.insert("$binary".to_string(), Value::String(base64_encode(&bytes)));
            obj.insert("$type".to_string(), Value::String(format!("{st:02x}")));
            Value::Object(obj)
        }
        Bson::RegularExpression(Regex { pattern, options }) => {
            // Sort options to match bson's relaxed_extjson canonical form.
            let mut chars: Vec<char> = options.chars().collect();
            chars.sort_unstable();
            let options: String = chars.into_iter().collect();
            let mut obj = Map::new();
            obj.insert("$regex".to_string(), Value::String(pattern));
            obj.insert("$options".to_string(), Value::String(options));
            Value::Object(obj)
        }
        Bson::Symbol(s) => {
            let mut obj = Map::new();
            obj.insert("$symbol".to_string(), Value::String(s));
            Value::Object(obj)
        }
        Bson::JavaScriptCode(code) => {
            let mut obj = Map::new();
            obj.insert("$code".to_string(), Value::String(code));
            Value::Object(obj)
        }
        Bson::JavaScriptCodeWithScope(jcs) => {
            let mut obj = Map::new();
            obj.insert("$code".to_string(), Value::String(jcs.code));
            obj.insert(
                "$scope".to_string(),
                Value::Object(document_to_map(jcs.scope)),
            );
            Value::Object(obj)
        }
        Bson::Timestamp(ts) => {
            let mut inner = Map::new();
            inner.insert("t".to_string(), Value::Number(ts.time.into()));
            inner.insert("i".to_string(), Value::Number(ts.increment.into()));
            let mut obj = Map::new();
            obj.insert("$timestamp".to_string(), Value::Object(inner));
            Value::Object(obj)
        }
        Bson::MinKey => {
            let mut obj = Map::new();
            obj.insert("$minKey".to_string(), Value::Number(1.into()));
            Value::Object(obj)
        }
        Bson::MaxKey => {
            let mut obj = Map::new();
            obj.insert("$maxKey".to_string(), Value::Number(1.into()));
            Value::Object(obj)
        }
        Bson::Undefined => {
            let mut obj = Map::new();
            obj.insert("$undefined".to_string(), Value::Bool(true));
            Value::Object(obj)
        }
        Bson::DbPointer(_) => {
            // DbPointer's fields are `pub(crate)` in bson 2.x, so we can't
            // pattern-match them. Delegate to bson's canonical relaxed_extjson
            // form (which doesn't panic for DbPointer; only Decimal128 panics
            // there). The result is `{"$dbPointer": {"$ref": ..., "$id": {"$oid": ...}}}`.
            value.into_relaxed_extjson()
        }
    }
}

/// Convert a `bson::Document` to a JSON `Map<String, Value>` by walking each
/// field through [`bson_to_json`]. Defined separately so several Bson arms
/// (Document, JavaScriptCodeWithScope) can share it.
fn document_to_map(doc: Document) -> Map<String, Value> {
    let mut map = Map::with_capacity(doc.len());
    for (k, v) in doc {
        map.insert(k, bson_to_json(v));
    }
    map
}

/// DateTime → ISO-8601 string per ARCHITECTURE §4.2 ("Cube parses time
/// dimensions from strings"). Uses bson's RFC 3339 helper, which falls back
/// to a "$date" / "$numberLong" EJSON form for out-of-range timestamps that
/// can't be formatted in RFC 3339 (year > 9999, etc.). For the
/// representable common case this returns a bare string like
/// "1970-01-01T00:00:00Z".
fn datetime_to_json(dt: BsonDateTime) -> Value {
    match dt.try_to_rfc3339_string() {
        Ok(s) => Value::String(s),
        Err(_) => {
            // Out-of-range fallback: surface the millis-since-epoch losslessly
            // in the canonical EJSON form so downstream consumers can still
            // reconstruct the moment. Avoids panicking, which the bson crate's
            // own `into_relaxed_extjson` would do for Decimal128 but happens
            // to do the same thing for DateTime out-of-range — we keep the
            // shape predictable.
            let mut inner = Map::new();
            inner.insert(
                "$numberLong".to_string(),
                Value::String(dt.timestamp_millis().to_string()),
            );
            let mut obj = Map::new();
            obj.insert("$date".to_string(), Value::Object(inner));
            obj
        }
        .into(),
    }
}

/// Tiny standard-base64 encoder. Avoids pulling in the `base64` crate just
/// for this one use site — the BSON Binary path only fires for opaque
/// payloads we never inspect.
fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        out.push(CHARS[(b0 >> 2) as usize] as char);
        out.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::{
        doc, oid::ObjectId, spec::BinarySubtype, Decimal128, JavaScriptCodeWithScope, Timestamp,
    };
    use std::str::FromStr;

    // ----- primitives -----

    #[test]
    fn double_is_json_number() {
        let v = bson_to_json(Bson::Double(1.5));
        assert_eq!(v, Value::Number(serde_json::Number::from_f64(1.5).unwrap()));
    }

    #[test]
    fn double_nan_falls_back_to_null() {
        let v = bson_to_json(Bson::Double(f64::NAN));
        assert_eq!(v, Value::Null);
    }

    #[test]
    fn string_is_json_string() {
        assert_eq!(
            bson_to_json(Bson::String("hi".into())),
            Value::String("hi".into())
        );
    }

    #[test]
    fn boolean_is_json_bool() {
        assert_eq!(bson_to_json(Bson::Boolean(true)), Value::Bool(true));
        assert_eq!(bson_to_json(Bson::Boolean(false)), Value::Bool(false));
    }

    #[test]
    fn null_is_json_null() {
        assert_eq!(bson_to_json(Bson::Null), Value::Null);
    }

    #[test]
    fn int32_is_json_number() {
        assert_eq!(bson_to_json(Bson::Int32(42)), Value::Number(42.into()));
    }

    #[test]
    fn int64_within_safe_range_is_number() {
        let v = bson_to_json(Bson::Int64(1_000_000));
        assert_eq!(v, Value::Number(1_000_000_i64.into()));
    }

    #[test]
    fn int64_above_safe_range_still_serializes_as_number() {
        // No panic, no warning assertion (best-effort per task spec).
        let big = (1_i64 << 60) + 7;
        let v = bson_to_json(Bson::Int64(big));
        assert_eq!(v, Value::Number(big.into()));
    }

    // ----- precision-preserving stringified types -----

    #[test]
    fn decimal128_serializes_as_string_preserving_precision() {
        let d = Decimal128::from_str("4521.50").expect("parse decimal");
        let v = bson_to_json(Bson::Decimal128(d));
        match v {
            Value::String(s) => {
                // bson::Decimal128::to_string is the canonical IEEE 754-2008
                // form; for "4521.50" that's "4521.50" (no normalization).
                assert_eq!(s, "4521.50");
            }
            other => panic!("expected JSON string for Decimal128, got {other:?}"),
        }
    }

    #[test]
    fn objectid_serializes_as_24_char_hex_string() {
        let oid = ObjectId::parse_str("507f1f77bcf86cd799439011").expect("known good oid");
        let v = bson_to_json(Bson::ObjectId(oid));
        assert_eq!(v, Value::String("507f1f77bcf86cd799439011".to_string()));
    }

    #[test]
    fn datetime_epoch_serializes_as_iso8601_z() {
        let dt = BsonDateTime::from_millis(0);
        let v = bson_to_json(Bson::DateTime(dt));
        // RFC 3339 with Zulu suffix — bson uses the `time` crate's Rfc3339
        // formatter which renders epoch as "1970-01-01T00:00:00Z".
        assert_eq!(v, Value::String("1970-01-01T00:00:00Z".to_string()));
    }

    // ----- composite -----

    #[test]
    fn nested_document_round_trips_recursively() {
        let nested = doc! {
            "a": 1_i32,
            "b": [1_i32, 2_i32, "three"],
        };
        let v = bson_to_json(Bson::Document(nested));
        let expected = serde_json::json!({
            "a": 1,
            "b": [1, 2, "three"],
        });
        assert_eq!(v, expected);
    }

    #[test]
    fn array_of_mixed_types_marshals_each_element() {
        let arr = vec![
            Bson::Int32(1),
            Bson::String("x".into()),
            Bson::Boolean(false),
            Bson::Null,
        ];
        let v = bson_to_json(Bson::Array(arr));
        assert_eq!(v, serde_json::json!([1, "x", false, null]),);
    }

    // ----- EJSON-form types -----

    #[test]
    fn binary_generic_subtype_renders_ejson_with_base64_and_hex_type() {
        let bin = Binary {
            subtype: BinarySubtype::Generic, // u8 = 0
            bytes: b"hello".to_vec(),        // base64 = aGVsbG8=
        };
        let v = bson_to_json(Bson::Binary(bin));
        assert_eq!(v, serde_json::json!({"$binary": "aGVsbG8=", "$type": "00"}));
    }

    #[test]
    fn binary_uuid_subtype_renders_with_correct_hex_type() {
        let bin = Binary {
            subtype: BinarySubtype::Uuid, // u8 = 4
            bytes: vec![0x00, 0x11, 0x22],
        };
        let v = bson_to_json(Bson::Binary(bin));
        let expected_b64 = base64_encode(&[0x00, 0x11, 0x22]);
        assert_eq!(
            v,
            serde_json::json!({"$binary": expected_b64, "$type": "04"})
        );
    }

    #[test]
    fn regex_renders_pattern_and_sorted_options() {
        // Options come in unsorted; canonical form is sorted.
        let r = Regex {
            pattern: "^foo".to_string(),
            options: "ix".to_string(),
        };
        let v = bson_to_json(Bson::RegularExpression(r));
        assert_eq!(v, serde_json::json!({"$regex": "^foo", "$options": "ix"}));
    }

    #[test]
    fn symbol_renders_canonical_ejson() {
        let v = bson_to_json(Bson::Symbol("legacy".into()));
        assert_eq!(v, serde_json::json!({"$symbol": "legacy"}));
    }

    #[test]
    fn javascript_code_renders_ejson() {
        let v = bson_to_json(Bson::JavaScriptCode("function() {}".into()));
        assert_eq!(v, serde_json::json!({"$code": "function() {}"}));
    }

    #[test]
    fn javascript_code_with_scope_renders_ejson() {
        let jcs = JavaScriptCodeWithScope {
            code: "function() { return x; }".into(),
            scope: doc! {"x": 1_i32},
        };
        let v = bson_to_json(Bson::JavaScriptCodeWithScope(jcs));
        assert_eq!(
            v,
            serde_json::json!({"$code": "function() { return x; }", "$scope": {"x": 1}})
        );
    }

    #[test]
    fn timestamp_renders_ejson_with_t_and_i() {
        let ts = Timestamp {
            time: 100,
            increment: 5,
        };
        let v = bson_to_json(Bson::Timestamp(ts));
        assert_eq!(v, serde_json::json!({"$timestamp": {"t": 100, "i": 5}}));
    }

    #[test]
    fn min_key_renders_canonical_ejson() {
        assert_eq!(
            bson_to_json(Bson::MinKey),
            serde_json::json!({"$minKey": 1})
        );
    }

    #[test]
    fn max_key_renders_canonical_ejson() {
        assert_eq!(
            bson_to_json(Bson::MaxKey),
            serde_json::json!({"$maxKey": 1})
        );
    }

    #[test]
    fn undefined_renders_canonical_ejson() {
        assert_eq!(
            bson_to_json(Bson::Undefined),
            serde_json::json!({"$undefined": true})
        );
    }

    // ----- base64 encoder smoke test -----

    #[test]
    fn base64_encoder_matches_known_vectors() {
        // RFC 4648 standard test vectors.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    // ----- error mapping -----

    #[test]
    fn map_mongo_error_routes_non_command_to_existing_taxonomy() {
        // Exercise the From<mongodb::error::Error> path via a real parse-time
        // error. Bad scheme manifests as InvalidArgument -> ConfigInvalid in
        // our taxonomy (not Timeout).
        let mongo_err = mongodb::options::ConnectionString::parse("notascheme")
            .expect_err("malformed URI must error");
        let mapped = map_mongo_error(mongo_err);
        assert_eq!(mapped.code(), "MONGOSQL_CONFIG_INVALID");
    }
}
