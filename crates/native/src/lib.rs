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
// `config`, `error`, `execute`, `schema`, and `translate` are `pub` so the
// in-tree integration test targets under `tests/` can reach them via
// `use cubejs_mongosql_driver_native::*`. They are NOT part of the napi-rs
// surface (`MongoSqlClient` in `client.rs` is); Node consumers see them only
// through that wrapper. `config::ClientConfig` is exposed by napi-rs as an
// object on its own, but the module path stays accessible to Rust callers.
// Other modules stay private until a real Rust consumer needs them.
pub mod config;
pub mod error;
pub mod execute;
pub mod schema;
pub mod translate;

pub use client::MongoSqlClient;

#[cfg(test)]
mod tests {
    #[test]
    fn sanity() {
        assert_eq!(2 + 2, 4);
    }
}
