extern crate napi_build;

fn main() {
    napi_build::setup();

    // `napi_build::setup()` only injects the macOS `-undefined dynamic_lookup`
    // linker flag onto the *cdylib* output (the .node binary). When `cargo
    // test` builds an integration-test binary that links against this crate's
    // rlib, the napi-rs FFI symbols (`_napi_*`) are unresolved at link time
    // and the build fails. For binary targets we relax the linker the same
    // way napi-build does for cdylibs, so tests can run without a Node host.
    //
    // The integration tests themselves don't *call* any napi entry points;
    // they only exercise the pure-Rust modules (`schema`, `error`, ...). The
    // unresolved symbols come from monomorphised paths through `napi::*`
    // that the linker can't dead-strip when building a binary.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    match target_os.as_str() {
        "macos" => {
            println!("cargo:rustc-link-arg-tests=-Wl,-undefined,dynamic_lookup");
        }
        "linux" | "freebsd" => {
            // Same trick on ELF platforms: tell the linker that unresolved
            // symbols are expected (provided by Node at runtime, but for
            // tests we just don't call into them).
            println!("cargo:rustc-link-arg-tests=-Wl,--unresolved-symbols=ignore-all");
        }
        _ => {}
    }
}
