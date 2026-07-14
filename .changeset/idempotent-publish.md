---
---

Make the release `publish` job idempotent: skip any package version already on the npm registry (sub-packages and main), and skip an existing git tag / GitHub Release. Fixes the failure mode where npm publishes a version but exits non-zero on an internal retry, aborting the job after the sub-packages published but before the main package — leaving a half-published release that no re-run could finish. CI/tooling only — no package version bump.
