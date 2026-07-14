---
---

Replace `napi prepublish` in the release job with an explicit version-sync step. `napi prepublish` publishes the platform sub-packages as a non-idempotent side effect, so once they exist on the registry it aborts the whole publish job with a `403` before the main package can publish. The sub-package stubs are already complete and the binaries are staged separately, so the job now just syncs versions and relies on the idempotent `npm publish` steps. CI/tooling only — no package version bump.
