//! Structured decision records — the observability core.
//!
//! The problem this exists to solve is not "there are not enough log lines". It is that when the
//! app does something surprising, the code that made the decision leaves no trace of *which rule it
//! applied*, *what it looked at*, or *what it concluded*. A message that never arrives, an agent
//! that spawns without the MCP servers you enabled, a peer that never connects — all three fail the
//! same way: a branch is taken, nothing is written, and the absence of evidence reads exactly like
//! the absence of a problem.
//!
//! A decision record answers those questions in one line:
//!
//! ```ignore
//! decide!(
//!     target: "sync.chat",
//!     attempted = "relay.enqueue",
//!     outcome = Deferred,
//!     because = "queued_local_only",
//!     rule = "chat.send.relay_path",
//!     evidence = { conv_id = %conv_id, peer_route_known = peer_known, queue_depth = depth },
//! );
//! ```
//!
//! `grep '"rule":"agent_spawn.' alethe.jsonl` then reconstructs every rule applied to a spawn, in
//! order, with the inputs each one used.
//!
//! # Privacy
//!
//! `evidence` carries ids, counts, lengths and enums. **Never message bodies, file contents,
//! tokens or paths that identify a person.** This is a convention, so it is easy to regress: check
//! it in review the same way you would check a `println!` of a secret.

use std::fmt;

use serde::{Deserialize, Serialize};

/// What a decision concluded. Deliberately a closed set: a free-text status is a status nobody can
/// filter on, and the whole point is being able to ask "show me everything that was rejected".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The thing was done, completely, here.
    Ok,
    /// A rule refused it. Expected behaviour, not an error — but the caller may not know that.
    Rejected,
    /// Accepted but not finished here: handed to a queue, a task, another device. **The one that
    /// stops a function from reporting success for work it has only scheduled.**
    Deferred,
    /// It was attempted and failed.
    Failed,
    /// Not applicable — a precondition was absent, so nothing was attempted.
    Skipped,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Rejected => "rejected",
            Outcome::Deferred => "deferred",
            Outcome::Failed => "failed",
            Outcome::Skipped => "skipped",
        }
    }

    /// The severity a record of this outcome is reported at, so an `ALETHE_LOG=warn` run shows the
    /// failures without the successful steps around them.
    pub fn level(self) -> tracing::Level {
        match self {
            Outcome::Failed => tracing::Level::WARN,
            Outcome::Rejected | Outcome::Deferred => tracing::Level::INFO,
            Outcome::Ok | Outcome::Skipped => tracing::Level::DEBUG,
        }
    }
}

impl fmt::Display for Outcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Records one decision.
///
/// Every field is required except `evidence`, and that is on purpose — a record missing its `rule`
/// or its `because` is the kind of log line that tells you something happened without telling you
/// why, which is the state this module exists to leave behind.
///
/// * `target`   — where the logic lives; used as the tracing target, so it doubles as the filter
///                key for `ALETHE_LOG=sync.chat=debug`.
/// * `attempted`— what was being tried, as a stable identifier.
/// * `outcome`  — an [`Outcome`] variant, written bare (`outcome = Deferred`).
/// * `because`  — the verdict, as a machine-readable code. Never prose: `"queued_local_only"`, not
///                `"message was put on the queue"`. Prose cannot be grepped or counted.
/// * `rule`     — which of Alethe's rules was applied, dotted and stable
///                (`"agent_spawn.requires_planning_gate"`).
/// * `evidence` — optional `{ key = value, .. }` of the inputs the decision used, in
///                `tracing` field syntax (`%display`, `?debug`, or a plain value).
#[macro_export]
macro_rules! decide {
    (
        target: $target:expr,
        attempted = $attempted:expr,
        outcome = $outcome:ident,
        because = $because:expr,
        rule = $rule:expr
        $(, evidence = { $($evidence:tt)* })?
        $(,)?
    ) => {{
        let __outcome = $crate::obs::Outcome::$outcome;
        // The level has to be known at compile time for `tracing`'s macros, so the runtime outcome
        // picks between four fixed call sites rather than computing one.
        match __outcome.level() {
            ::tracing::Level::WARN => ::tracing::warn!(
                target: $target,
                attempted = $attempted, outcome = __outcome.as_str(),
                because = $because, rule = $rule,
                $($($evidence)*)?
            ),
            ::tracing::Level::INFO => ::tracing::info!(
                target: $target,
                attempted = $attempted, outcome = __outcome.as_str(),
                because = $because, rule = $rule,
                $($($evidence)*)?
            ),
            _ => ::tracing::debug!(
                target: $target,
                attempted = $attempted, outcome = __outcome.as_str(),
                because = $because, rule = $rule,
                $($($evidence)*)?
            ),
        }
    }};
}

/// A human-readable diagnostic line that survives packaging.
///
/// `eprintln!` is fine under `tauri dev` and useless in a shipped build, where stderr goes nowhere:
/// the most detailed traces in the codebase — the P2P bridge's connection narration — were being
/// written and thrown away on exactly the machines where a connection problem is hardest to
/// reproduce. This keeps the terminal output during development and also puts the line in the
/// unified stream, where it inherits the correlation id of the gesture in progress.
///
/// Prefer [`decide!`] for anything that is a decision. This is for narration.
#[macro_export]
macro_rules! note {
    (target: $target:expr, $($arg:tt)*) => {{
        let __message = ::std::format!($($arg)*);
        #[cfg(debug_assertions)]
        ::std::eprintln!("{}", __message);
        ::tracing::info!(target: $target, message = %__message);
    }};
}

/// Discards a `Result` **while naming why the failure does not matter**.
///
/// This is the counterpart to [`decide!`]: after a site has been reviewed, it ends either as a
/// recorded failure or as a named best-effort. A bare `let _ = …` says nothing about which of those
/// it is, so "the author considered this and decided to ignore it" and "nobody noticed" look
/// identical in the code — which is how a genuinely important failure survives review.
///
/// Costs nothing at runtime on the happy path: the reason is only formatted if the call failed, and
/// even then it is reported at `debug`.
///
/// ```ignore
/// best_effort!(kill_process(pid), "pty_already_dead");
/// ```
#[macro_export]
macro_rules! best_effort {
    ($expr:expr, $reason:expr $(,)?) => {{
        match $expr {
            Ok(value) => Some(value),
            Err(error) => {
                ::tracing::debug!(
                    target: "alethe.best_effort",
                    reason = $reason,
                    error = %error,
                    "ignored an expected failure",
                );
                None
            }
        }
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_levels_put_failures_above_successes() {
        assert_eq!(Outcome::Failed.level(), tracing::Level::WARN);
        assert_eq!(Outcome::Rejected.level(), tracing::Level::INFO);
        assert_eq!(Outcome::Deferred.level(), tracing::Level::INFO);
        assert_eq!(Outcome::Ok.level(), tracing::Level::DEBUG);
        assert_eq!(Outcome::Skipped.level(), tracing::Level::DEBUG);
    }

    #[test]
    fn outcome_names_are_stable_wire_values() {
        // These strings end up in `alethe.jsonl` and in anything that greps it, so renaming a
        // variant must not silently rename the value people filter on.
        assert_eq!(Outcome::Ok.as_str(), "ok");
        assert_eq!(Outcome::Rejected.as_str(), "rejected");
        assert_eq!(Outcome::Deferred.as_str(), "deferred");
        assert_eq!(Outcome::Failed.as_str(), "failed");
        assert_eq!(Outcome::Skipped.as_str(), "skipped");
        assert_eq!(
            serde_json::to_string(&Outcome::Deferred).unwrap(),
            "\"deferred\""
        );
    }

    #[test]
    fn decide_accepts_every_shape_without_a_subscriber() {
        // No subscriber is installed in unit tests, so these are no-ops; the point is that all four
        // forms compile and that emitting a record never panics when nothing is listening.
        decide!(
            target: "test.obs",
            attempted = "minimal",
            outcome = Ok,
            because = "no_evidence_needed",
            rule = "test.minimal",
        );
        let queue_depth = 3usize;
        decide!(
            target: "test.obs",
            attempted = "with_evidence",
            outcome = Deferred,
            because = "queued_local_only",
            rule = "test.evidence",
            evidence = { queue_depth = queue_depth, route = %"relay" },
        );
        decide!(
            target: "test.obs",
            attempted = "failure",
            outcome = Failed,
            because = "disk_full",
            rule = "test.failure",
        );
        decide!(
            target: "test.obs",
            attempted = "rejection",
            outcome = Rejected,
            because = "not_a_member",
            rule = "test.rejection",
        );
    }

    #[test]
    fn best_effort_yields_the_value_and_swallows_the_error() {
        let ok: Result<u8, String> = Ok(7);
        assert_eq!(best_effort!(ok, "cannot_fail"), Some(7));
        let failed: Result<u8, String> = Err("nope".into());
        assert_eq!(best_effort!(failed, "expected_in_tests"), None);
    }
}
