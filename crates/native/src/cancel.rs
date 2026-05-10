//! Cancellation primitives bridging JS `AbortSignal` ↔ Tokio futures.
//!
//! ## Why a hand-rolled token?
//!
//! napi-rs 2.16's [`napi::bindgen_prelude::AbortSignal`] is **only** wired to
//! [`napi::bindgen_prelude::AsyncTask`] — the libuv async-work pattern. It is
//! `!Send` (holds `Rc<...>`) and cannot be passed as a parameter to
//! `#[napi] async fn`. Concretely: napi-rs's own implementation aborts an
//! async task by calling `napi_cancel_async_work` on the queued libuv handle;
//! it does not provide a generic Tokio-aware cancellation channel.
//!
//! See `napi-2.16.17/src/bindgen_runtime/js_values/task.rs` (struct
//! `AbortSignal`, lines 50–86 / `on_abort` lines 88–137) for the upstream
//! constraint. Until napi-rs ships a Tokio-aware bridge (post-2.x territory)
//! we expose our own opaque [`AbortHandle`] class with an `abort()` method
//! that JavaScript wires to the AbortSignal's `'abort'` event.
//!
//! ## Wire shape
//!
//! ```text
//! TS:
//!   const handle = new AbortHandle();
//!   signal.addEventListener('abort', () => handle.abort());
//!   await client.query(sql, handle);
//!
//! Rust (inside MongoSqlClient::query):
//!   tokio::select! {
//!       biased;
//!       _ = handle.cancelled() => Err(Error::Cancelled { site: "query" }),
//!       res = do_query(...)    => res,
//!   }
//! ```
//!
//! `biased` ensures cancellation has priority if both branches are ready
//! simultaneously (e.g. handle aborted before the task even started polling).
//!
//! ## Close-time fan-out
//!
//! [`MongoSqlClient::close`] holds a *parent* token. Per-query tokens are
//! linked to it via [`CancelToken::child`], so calling `close()` cancels all
//! outstanding queries before tearing down the mongo client. That is the
//! SIGTERM-during-pre-agg fix: without the link, `release()` would return
//! immediately while queries kept running until `max_time`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

/// Cooperative cancellation token. `cancel()` is idempotent and safe from
/// any thread; `cancelled()` is the future a worker `tokio::select!`s on.
///
/// Internally an `AtomicBool` flag (cheap synchronous polling) plus a
/// `Notify` (wake registered waiters). Using both avoids both the
/// `Notify`-only race (waiters registered after `cancel()` would miss it)
/// and the `AtomicBool`-only inefficiency (waiters would have to busy-poll).
#[derive(Debug)]
pub struct CancelToken {
    cancelled: AtomicBool,
    notify: Notify,
    /// If set, cancelling this child triggers the parent — but more
    /// importantly, when the *parent* is cancelled, a watcher task wired in
    /// [`CancelToken::child`] propagates the cancellation here. We keep the
    /// parent strong-ref so an in-flight child can't outlive the close()
    /// future before being notified.
    _parent: Option<Arc<CancelToken>>,
}

impl CancelToken {
    /// Construct a fresh, un-cancelled token.
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
            _parent: None,
        })
    }

    /// Construct a child token that is cancelled whenever `parent` is.
    /// The propagation watcher runs as a detached tokio task and exits as
    /// soon as either the parent fires or the child is dropped (because
    /// the upgrade fails).
    pub fn child(parent: &Arc<CancelToken>) -> Arc<Self> {
        let child = Arc::new(Self {
            cancelled: AtomicBool::new(parent.is_cancelled()),
            notify: Notify::new(),
            _parent: Some(Arc::clone(parent)),
        });
        // If parent already fired, child is already marked above; still
        // notify so any select! that races us before the cancel-aware
        // task spawns wakes up.
        if child.cancelled.load(Ordering::SeqCst) {
            child.notify.notify_waiters();
            return child;
        }
        let parent_clone = Arc::clone(parent);
        let child_weak = Arc::downgrade(&child);
        tokio::spawn(async move {
            parent_clone.cancelled().await;
            if let Some(child) = child_weak.upgrade() {
                child.cancel();
            }
        });
        child
    }

    /// Mark cancelled and wake all waiters. Idempotent.
    pub fn cancel(&self) {
        // SeqCst because the Acquire-Release pairs with `is_cancelled()`'s
        // Relaxed reads in cancelled() — we want the flip to be globally
        // visible the instant we fire notify_waiters().
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Synchronous probe. Useful for tests and for the hot path where we
    /// want to fail-fast before spawning subsidiary work.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Future that resolves once the token has been cancelled. Cheap to
    /// drop if the racing branch wins. Safe to call after cancel() — the
    /// flag is checked first, so the future resolves immediately.
    pub async fn cancelled(&self) {
        // Fast path: already cancelled — return immediately, no Notify
        // dance.
        if self.is_cancelled() {
            return;
        }
        // Register a waiter *before* re-checking the flag, otherwise we
        // could miss the notification fired between our check and our
        // registration. This is the standard Notify race-free pattern.
        let notified = self.notify.notified();
        tokio::pin!(notified);
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

/// Public napi-rs handle exposed to JavaScript.
///
/// JS lifecycle:
/// 1. `const handle = new AbortHandle();`
/// 2. Wire to a `AbortSignal`: `signal.addEventListener('abort', () => handle.abort());`
/// 3. Pass to a cancellable Rust async method.
///
/// The handle is a thin newtype around `Arc<CancelToken>` so it can be
/// cloned cheaply across the napi boundary if a future API needs to share
/// one signal across several calls.
#[napi]
pub struct AbortHandle {
    token: Arc<CancelToken>,
}

impl Default for AbortHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl AbortHandle {
    /// Construct a fresh, un-aborted handle.
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            token: CancelToken::new(),
        }
    }

    /// Mark this handle aborted. Safe to call from any thread; idempotent.
    /// JS-callable; the conventional use is from an `AbortSignal`'s
    /// `'abort'` event listener.
    #[napi]
    pub fn abort(&self) {
        self.token.cancel();
    }

    /// Synchronous probe — true once `abort()` has been called.
    #[napi]
    pub fn aborted(&self) -> bool {
        self.token.is_cancelled()
    }
}

impl AbortHandle {
    /// Internal: clone the underlying `Arc<CancelToken>` so a worker future
    /// can `select!` on it without holding the napi reference.
    pub(crate) fn token(&self) -> Arc<CancelToken> {
        Arc::clone(&self.token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn fresh_token_is_not_cancelled() {
        let t = CancelToken::new();
        assert!(!t.is_cancelled());
    }

    #[tokio::test]
    async fn cancel_flips_state_and_wakes_waiter() {
        let t = CancelToken::new();
        let t2 = Arc::clone(&t);
        let waiter = tokio::spawn(async move { t2.cancelled().await });
        // Yield once to let the waiter register before we cancel — without
        // this, the test still passes because cancelled() re-checks the
        // flag after registering, but yielding makes the timing explicit.
        tokio::task::yield_now().await;
        t.cancel();
        timeout(Duration::from_millis(100), waiter)
            .await
            .expect("waiter should resolve quickly")
            .expect("waiter task did not panic");
        assert!(t.is_cancelled());
    }

    #[tokio::test]
    async fn cancel_before_await_resolves_immediately() {
        let t = CancelToken::new();
        t.cancel();
        // Should resolve in under a millisecond — fast path, no Notify.
        timeout(Duration::from_millis(10), t.cancelled())
            .await
            .expect("pre-cancelled token should resolve immediately");
    }

    #[tokio::test]
    async fn cancel_is_idempotent() {
        let t = CancelToken::new();
        t.cancel();
        t.cancel();
        t.cancel();
        assert!(t.is_cancelled());
        // Still resolves.
        timeout(Duration::from_millis(10), t.cancelled())
            .await
            .expect("idempotent cancel keeps resolving");
    }

    #[tokio::test]
    async fn child_cancels_when_parent_cancels() {
        let parent = CancelToken::new();
        let child = CancelToken::child(&parent);
        assert!(!child.is_cancelled());
        parent.cancel();
        // Allow the propagation task to run.
        timeout(Duration::from_millis(100), child.cancelled())
            .await
            .expect("child must cancel after parent");
        assert!(child.is_cancelled());
    }

    #[tokio::test]
    async fn child_inherits_already_cancelled_parent() {
        let parent = CancelToken::new();
        parent.cancel();
        let child = CancelToken::child(&parent);
        assert!(
            child.is_cancelled(),
            "child must inherit cancelled state on construction"
        );
        timeout(Duration::from_millis(10), child.cancelled())
            .await
            .expect("inherited-cancelled child resolves immediately");
    }

    #[tokio::test]
    async fn abort_handle_round_trip() {
        let h = AbortHandle::new();
        assert!(!h.aborted());
        h.abort();
        assert!(h.aborted());
        // Underlying token reflects it too.
        let t = h.token();
        assert!(t.is_cancelled());
        timeout(Duration::from_millis(10), t.cancelled())
            .await
            .expect("aborted handle's token resolves");
    }
}
