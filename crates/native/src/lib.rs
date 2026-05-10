//! cubejs-mongosql-driver-native — Rust shim for the Cube MongoSQL driver.
//!
//! See SPEC.md §5.2 and ARCHITECTURE.md §2.2.
//!
//! This file is the napi-rs surface; module impls live in the sibling files.

#![deny(unsafe_code)]
// napi-rs codegen emits undocumented FFI plumbing impls; we keep human-
// authored items documented but cannot enforce missing_docs at the crate
// level without false positives on generated code.

#[macro_use]
extern crate napi_derive;

mod client;
mod config;
mod error;
mod execute;
// `schema` is `pub` so the in-tree integration test target
// (`tests/schema_collection.rs`) can `use cubejs_mongosql_driver_native::schema`.
// Other modules stay private until a real Rust consumer needs them.
pub mod schema;
mod translate;

pub use client::MongoSqlClient;

#[cfg(test)]
mod tests {
    #[test]
    fn sanity() {
        assert_eq!(2 + 2, 4);
    }
}
