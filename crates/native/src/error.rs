//! Error types and code mapping. See SPEC.md §6.
//!
//! Implementation arrives in T03. Stubbed here so the rest of the workspace
//! compiles during T01.

use thiserror::Error;

/// Driver error type. Maps to the SPEC.md §6 error codes via [`Error::code`].
#[derive(Debug, Error)]
pub enum Error {
    /// Unimplemented placeholder — replace in T03.
    #[error("not implemented (T03): {0}")]
    Unimplemented(&'static str),
}

impl Error {
    /// Returns the SPEC.md §6 error code for this error.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Unimplemented(_) => "MONGOSQL_UNIMPLEMENTED",
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
