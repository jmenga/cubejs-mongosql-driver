# Contributing — Agent & Human Workflow

This project is built primarily by autonomous agents using a structured workflow. Human contributors follow the same loop. Read [SPEC.md](./SPEC.md), [ARCHITECTURE.md](./ARCHITECTURE.md), and [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) before contributing.

## The five-phase loop

Every change — large or small — follows this sequence:

```
   ┌─► PLAN ──► EXECUTE ──► VALIDATE ──► REVIEW ──► DOCUMENT ──┐
   │                                                            │
   └────────────────────────────────────────────────────────────┘
                              │
                       (next task)
```

### Phase 1 — PLAN

Pick a task from [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md). Before any code:

1. Read the task's *Context*, *Inputs*, *Outputs* sections in full.
2. Read every file listed in *Inputs*.
3. Identify *Open questions* — resolve them by reading docs, spiking the actual library, or asking the user. Don't guess.
4. If the task's scope is unclear, write a one-paragraph plan in your response BEFORE calling Edit/Write. Get user agreement if there's ambiguity.
5. If the task takes >3 distinct steps, use `TaskCreate` to track sub-tasks.

**Don't skip to coding.** Plans that get pushback early save days of rework.

### Phase 2 — EXECUTE (TDD)

Strict TDD discipline:

1. **Red**: write the failing test first. Verify it fails for the right reason.
2. **Green**: write the minimum code to pass.
3. **Refactor**: clean up while tests are green.

Rules:

- Never commit without running the relevant test pass.
- Never write code with no test in scope.
- Use `cargo test`, `pnpm test`, `make e2e` — not manual smoke tests.

### Phase 3 — VALIDATE

Run the *Validation* commands listed in the task. All must exit 0:

```
pnpm lint            # eslint + prettier --check + rustfmt --check + clippy
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest (unit)
cargo test           # rust unit
make e2e             # docker-compose up + integration suite
```

If any step fails, return to Phase 2. **Do not mark a task complete with failing tests.**

### Phase 4 — REVIEW

Two layers:

**Self-review** (always):
- Walk through the task's *Review checklist* item by item. Each `[ ]` becomes `[x]` only with evidence.
- Diff your changes; ask "would I approve this PR?"
- Check for: forgotten test cases, dead code, secrets, debug prints, TODOs without owner.

**Peer review** (for tasks marked *needs critic* in IMPLEMENTATION_PLAN.md, or when self-review surfaces ambiguity):
- Spawn a critic agent (`Agent` tool, `subagent_type: general-purpose`) with a prompt of the form:

```
Review the changes in commits <range> against the task spec at IMPLEMENTATION_PLAN.md
T0X. Specifically check: [task-specific concerns]. Report: what's correct, what's
missing, what's wrong, what's risky. Under 400 words.
```

- Apply review feedback before declaring the task complete.

### Phase 5 — DOCUMENT

- Update the task's *Status* in IMPLEMENTATION_PLAN.md (`[ ]` → `[x]`).
- If you discovered a material issue mid-task, add an entry to *Discoveries* at the bottom of IMPLEMENTATION_PLAN.md.
- If you resolved an open question, remove it from *Open questions*.
- Keep README.md and any user-facing docs in sync.
- Commit with a clear message (see *Commit conventions* below).

## TDD discipline

### Test first, always

```
1. Write the test. Watch it fail.
   ┌─────────────────────────────────────┐
   │ FAIL: test_translate_count          │
   │   left:  Ok(Translation { ... })    │
   │   right: <not implemented>          │
   └─────────────────────────────────────┘

2. Implement the minimum. Watch it pass.
   ┌─────────────────────────────────────┐
   │ PASS: test_translate_count          │
   └─────────────────────────────────────┘

3. Refactor with confidence (tests still pass).
```

### Test pyramid (per ARCHITECTURE.md §6.4)

Write tests at the level closest to the code:

- Pure logic → Rust unit (in-tree `#[cfg(test)]`) or TS unit (Vitest)
- Boundary behaviour (DB I/O, FFI) → Rust integration tests in `crates/native/tests/`
- End-to-end behaviour → Docker Compose integration tests under `tests/integration/`
- Cube-level behaviour → E2E with the `cubejs/cube` image (T19)

Don't write E2E tests for things unit tests can cover.

### What to test

- **Happy path** — every public method/function
- **Error path** — every error variant from SPEC §6
- **Boundaries** — empty inputs, max sizes, type edges (Decimal128, large ints)
- **Concurrency** — anywhere `Arc`/`RwLock`/`Mutex` is used
- **Refresh/lifecycle** — anywhere a background task is involved

### What not to test

- Third-party libraries (mongodb crate, mongosql crate) — trust their own tests
- Configuration validation that's already covered upstream
- Trivial getters/setters

## Code style

### TypeScript

- Strict mode on; no `any` (use `unknown` and narrow)
- ESLint + Prettier auto-fix on commit
- Public APIs documented with JSDoc
- Async functions return `Promise<T>` explicitly; no implicit returns

### Rust

- `cargo fmt` on save
- `cargo clippy` clean
- No `unwrap()` outside tests
- Errors: `Result<T, Error>` with our `Error` enum; no `Box<dyn Error>` in public APIs
- Async: Tokio; no blocking in async fns

### Comments

- Default to no comments. Names should explain intent.
- Comment when *why* is non-obvious — invariants, workarounds for upstream bugs, perf considerations.
- Don't comment *what* the code does; that's what the code is.
- Don't comment for the PR description (those rot).

## Commit conventions

```
<type>(<scope>): <subject>

<body — optional, wrap at 72 cols>

<footer — optional, e.g. "Fixes #N">
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.

Scope: `rust`, `ts`, `infra`, `docs`, `e2e`.

Examples:

```
feat(rust): add schema cache with background refresh

Implements T06 from IMPLEMENTATION_PLAN.md. SchemaCache now exposes
read/write methods backed by Arc<RwLock<Arc<MongoSqlCatalog>>>; refresh
task uses Weak<Self> so it auto-stops when the client is dropped.

Tests: 8 new in schema.rs::tests, all green.
```

```
fix(ts): preserve error code across napi boundary

Native errors prefix message with "MONGOSQL_X: ". Wrapper now parses
that prefix into a `code` field on the thrown Error. Without this,
Cube can't distinguish auth failures from query failures.
```

## PR template

(For when this repo accepts external contributions; agents working on the main branch can skip.)

```markdown
## Summary

- [What changed in 1–3 bullets]

## Task

- IMPLEMENTATION_PLAN.md T0X

## Test plan

- [ ] `pnpm lint` clean
- [ ] `pnpm test` clean
- [ ] `cargo test` clean
- [ ] `make e2e` clean (if applicable)

## Review checklist

(Copy from IMPLEMENTATION_PLAN.md task; mark each item)
```

## Anti-patterns

- ❌ Adding code without a test in scope
- ❌ Marking a task `[x]` with failing CI
- ❌ "Future-proofing" abstractions that aren't needed by current tasks
- ❌ Catching errors to swallow them; if you catch, do something specific
- ❌ Importing JS-side validators in TypeScript (Joi, Zod) when napi already validates
- ❌ Writing comments that restate the code
- ❌ Editing SPEC.md or ARCHITECTURE.md without explicit user agreement (those are contracts; the *plan* changes, the *contract* doesn't). **Exception:** if a spike task (e.g. T00) discovers that an upstream API contradicts what SPEC asserts, file the discrepancy in *IMPLEMENTATION_PLAN.md → Discoveries* and ask the user before proceeding. Don't silently re-interpret the SPEC; don't silently ship a divergent impl.

## Spawning sub-agents

When a task is too large to fit one agent's context, decompose:

```
Agent (subagent_type: Plan) — produce a step-by-step implementation
                              plan for the task

Agent (subagent_type: Explore) — locate specific code/symbols across
                                  the codebase

Agent (subagent_type: general-purpose) — execute a sub-task with
                                          its own TDD loop
```

For peer review, prefer `general-purpose` with a tight prompt and a word-count cap.

## Workflow examples

### Example 1 — small task (T03)

```
1. PLAN: Read SPEC §6, §5.2. Resolve "exhaustive match for Error::code"
         via Rust docs.

2. EXECUTE:
   - Red: write tests/error_test.rs::error_codes_complete
   - Red: cargo test → 1 fail
   - Green: implement Error variants + code()
   - Green: cargo test → all pass

3. VALIDATE:
   - cargo test -p cubejs-mongosql-driver-native error config
   - cargo clippy
   - cargo fmt --check

4. REVIEW: walk Review checklist; self-review diff.

5. DOCUMENT: update IMPLEMENTATION_PLAN.md T03 → [x].
            commit "feat(rust): add Error type and ClientConfig (T03)"
```

### Example 2 — task that surfaces a discovery

```
1. PLAN: T07 (translate wrapper). Spike mongosql crate first.

2. EXECUTE:
   - Spike reveals: mongosql::translate returns the target collection
     name as part of its result, but only for single-collection queries.
     Multi-collection queries don't expose this — caller must inspect
     pipeline.

3. (mid-execute) DISCOVER:
   - Add to IMPLEMENTATION_PLAN.md *Discoveries*:
     "T07 spike: mongosql::translate doesn't return target_collection
      for multi-collection queries. Translation struct must derive it
      from pipeline.first(). Affects T08 executor signature."

4. (resume) EXECUTE: implement with the discovery accommodated.

5. VALIDATE → REVIEW → DOCUMENT (mark T07 done, update T08 inputs).
```

## When in doubt

- **About a SPEC item**: ask the user. Don't reinterpret.
- **About a library API**: read its source/docs/tests. Don't guess.
- **About a test passing for the wrong reason**: write another test that proves intent.
- **About an open question**: surface it in IMPLEMENTATION_PLAN.md *Open questions* before coding.
- **About commit safety**: run `git status` and read the diff. Don't push if you didn't review.
