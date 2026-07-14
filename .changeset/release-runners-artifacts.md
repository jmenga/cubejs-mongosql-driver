---
---

Modernize the release workflow: cross-compile the `x86_64-apple-darwin` binary on the `macos-15` Apple-Silicon runner (the Intel `macos-13` runner is retired and `macos-14` is deprecated), and bump the deprecated `actions/upload-artifact` / `actions/download-artifact` from `v4` to `v7`. CI/tooling only — no package version bump.
