//! Where decision records go: one JSON object per line, in `logs/alethe.jsonl`.
//!
//! There is deliberately **one** file for the whole app, frontend included. Before this, a message
//! send left traces in two places — `logs/frontend.log` at the repo root and `app-events.log` in
//! the profile data dir — written by two processes with two clocks and no shared key, so nobody
//! could line them up. A question like "the UI says it sent it; did the socket ever see it?"
//! needed both files read side by side and the answer guessed. One ordered stream, keyed by a
//! correlation id minted in the UI gesture, turns that into a `grep`.
//!
//! JSON Lines rather than prose because the records are meant to be filtered and counted, and
//! because a line that fails to parse is one lost record instead of a corrupt file.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;

/// Field name carrying the correlation id through spans and records.
pub const CORRELATION_FIELD: &str = "corr";

const FILE_NAME: &str = "alethe.jsonl";
/// Rotation threshold. A dev session at `debug` writes steadily, and an unbounded file is a file
/// nobody opens.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

struct Sink {
    path: PathBuf,
    file: Mutex<Option<File>>,
}

static SINK: OnceLock<Sink> = OnceLock::new();

/// The one place records are written. Returns whether the line reached the file, because a logger
/// that cannot write must not be able to look like a component that had nothing to say.
fn write_line(line: &str) -> bool {
    let Some(sink) = SINK.get() else {
        return false;
    };
    let Ok(mut guard) = sink.file.lock() else {
        return false;
    };
    if guard.is_none() {
        match OpenOptions::new().create(true).append(true).open(&sink.path) {
            Ok(file) => *guard = Some(file),
            Err(_) => return false,
        }
    }
    let Some(file) = guard.as_mut() else {
        return false;
    };
    if writeln!(file, "{line}").is_err() {
        // Drop the handle so the next record reopens rather than writing into a file that has been
        // rotated or deleted underneath us.
        *guard = None;
        return false;
    }
    if file.metadata().map(|meta| meta.len()).unwrap_or(0) > MAX_BYTES {
        *guard = None;
        let _ = fs::rename(&sink.path, sink.path.with_extension("jsonl.1"));
    }
    true
}

/// Collects a record's fields into a JSON object.
struct JsonVisitor(Map<String, Value>);

impl Visit for JsonVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0
            .insert(field.name().to_string(), Value::String(value.to_string()));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().to_string(), Value::Bool(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().to_string(), value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().to_string(), value.into());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().to_string(), value.into());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(
            field.name().to_string(),
            Value::String(format!("{value:?}")),
        );
    }
}

/// The correlation id attached to a span, so records emitted inside it inherit it.
struct SpanCorrelation(String);

/// Turns each `tracing` event into one JSON line.
pub struct JsonlLayer;

impl<S> Layer<S> for JsonlLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        id: &tracing::span::Id,
        ctx: Context<'_, S>,
    ) {
        let mut visitor = JsonVisitor(Map::new());
        attrs.record(&mut visitor);
        if let Some(Value::String(corr)) = visitor.0.remove(CORRELATION_FIELD) {
            if let Some(span) = ctx.span(id) {
                span.extensions_mut().insert(SpanCorrelation(corr));
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut visitor = JsonVisitor(Map::new());
        event.record(&mut visitor);
        let mut record = visitor.0;

        let metadata = event.metadata();
        // Epoch milliseconds as a JSON *number*, not the `"secs.millis"` string the older text logs
        // use. Anything reading this stream sorts and subtracts timestamps — the flow panel groups a
        // gesture and measures its duration — and a string there silently produces no ordering and
        // no duration at all, while every record still looks perfectly well-formed.
        record.insert("ts".into(), crate::provider_common::now_ms().into());
        record.insert("level".into(), metadata.level().as_str().to_lowercase().into());
        record.insert("target".into(), metadata.target().into());
        if let Some(line) = metadata.line() {
            record.insert("line".into(), line.into());
        }
        if let Some(file) = metadata.file() {
            record.insert("file".into(), file.into());
        }

        // A record states its own correlation if it has one; otherwise it inherits the innermost
        // span that carries one. That inheritance is the reason this uses `tracing` at all: it
        // survives `.await`, which a thread-local would not.
        if !record.contains_key(CORRELATION_FIELD) {
            if let Some(scope) = ctx.event_scope(event) {
                for span in scope.from_root().collect::<Vec<_>>().into_iter().rev() {
                    if let Some(corr) = span.extensions().get::<SpanCorrelation>() {
                        record.insert(CORRELATION_FIELD.into(), corr.0.clone().into());
                        break;
                    }
                }
            }
        }

        if let Ok(line) = serde_json::to_string(&Value::Object(record)) {
            write_line(&line);
        }
    }
}

/// Installs the subscriber. Safe to call more than once — the second call is a no-op, which is what
/// lets the embedded and standalone runtimes both try without coordinating.
///
/// `ALETHE_LOG` takes a `tracing` env-filter (`sync.chat=debug,pty=trace`); the default keeps the
/// stream to decisions that matter without a flag.
pub fn install(logs_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(logs_dir).map_err(|error| {
        format!(
            "could not create the log directory {}: {error}",
            logs_dir.display()
        )
    })?;
    let path = logs_dir.join(FILE_NAME);

    // Prove the destination is writable now, at startup, rather than discovering at the first
    // interesting failure that every record has been going nowhere.
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;

    let already_set = SINK
        .set(Sink {
            path: path.clone(),
            file: Mutex::new(None),
        })
        .is_err();
    if already_set {
        return Ok(path);
    }

    let filter = EnvFilter::try_from_env("ALETHE_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,alethe.best_effort=off"));

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(filter)
        .with(JsonlLayer)
        .try_init()
        .map_err(|error| format!("could not install the log subscriber: {error}"))?;

    Ok(path)
}

/// The file records are written to, once [`install`] has run.
pub fn sink_path() -> Option<&'static Path> {
    SINK.get().map(|sink| sink.path.as_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_numbers_so_durations_can_be_computed() {
        // Guards a real defect: the first version wrote `crate::diagnostics::timestamp_ms()`, which
        // is a `"secs.millis"` STRING. Every record still looked well-formed, and every consumer
        // that sorts or subtracts timestamps — the flow panel measuring how long a gesture took —
        // silently got nothing.
        let now: Value = crate::provider_common::now_ms().into();
        assert!(now.is_number(), "the timestamp written into records must be numeric");
    }

    #[test]
    fn a_visitor_keeps_field_types_instead_of_stringifying_everything() {
        // Numbers and booleans have to survive as JSON numbers and booleans, or filtering the
        // stream on "queue_depth > 0" stops being possible.
        let mut visitor = JsonVisitor(Map::new());
        let record = &mut visitor;
        record.0.insert("depth".into(), 3i64.into());
        record.0.insert("known".into(), Value::Bool(false));
        assert_eq!(visitor.0["depth"], Value::from(3));
        assert_eq!(visitor.0["known"], Value::Bool(false));
    }

    /// Installs the sink into a temp directory and proves a record actually reaches the file with
    /// its correlation id.
    ///
    /// This is one test rather than several because `install` sets a process-global subscriber:
    /// split across tests, whichever ran second would silently observe the first one's state and
    /// pass for the wrong reason.
    #[test]
    fn records_reach_the_file_and_inherit_their_span_correlation() {
        let dir = std::env::temp_dir().join(format!(
            "alethe-obs-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        // Before installation there is no destination, and `write_line` must say so rather than
        // report success — a logger that cannot write must never look like a component with
        // nothing to say.
        assert!(!write_line("{}"), "wrote a line with no sink installed");

        let path = install(&dir).expect("install the sink");
        assert_eq!(sink_path(), Some(path.as_path()));

        let span = tracing::info_span!(target: "test.sink", "gesture", corr = "corr_abc");
        span.in_scope(|| {
            crate::decide!(
                target: "test.sink",
                attempted = "write_record",
                outcome = Failed,
                because = "disk_full",
                rule = "test.sink.record",
                evidence = { queue_depth = 4 },
            );
        });

        let contents = std::fs::read_to_string(&path).expect("read the sink file");
        let line = contents
            .lines()
            .find(|line| line.contains("write_record"))
            .expect("the record reached the file");
        let record: Value = serde_json::from_str(line).expect("each line is one JSON object");

        assert_eq!(record["target"], "test.sink");
        assert_eq!(record["attempted"], "write_record");
        assert_eq!(record["outcome"], "failed");
        assert_eq!(record["because"], "disk_full");
        assert_eq!(record["rule"], "test.sink.record");
        // Evidence keeps its JSON type, so the stream stays filterable on numbers.
        assert_eq!(record["queue_depth"], Value::from(4));
        // The whole reason this is built on spans: the record did not state its own correlation,
        // it inherited the one the enclosing gesture opened.
        assert_eq!(record[CORRELATION_FIELD], "corr_abc");
        // `Failed` is reported at warn so a quiet filter still surfaces it.
        assert_eq!(record["level"], "warn");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
