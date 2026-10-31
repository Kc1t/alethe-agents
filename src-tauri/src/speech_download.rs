//! Pausable model downloads: one active download at a time, a stop flag per model, and states
//! derived from what is on disk so a pause survives closing the app.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use tokio::sync::Mutex as AsyncMutex;

/// Error code `speech_download_model` returns when a pause landed; the UI treats it as a state.
pub const PAUSED: &str = "speech_download_paused";
/// Error code for a download requested while another one runs.
pub const BUSY: &str = "speech_download_busy";

/// Stop flags keyed by model id: the active download plus any model reserved by a cancel.
/// `start` admits a download only while the map is empty, so at most one download runs.
#[derive(Default)]
pub struct DownloadFlags(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl DownloadFlags {
    /// Registers `model_id` as the active download; `Err(BUSY)` while any download runs.
    pub fn start(&self, model_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !map.is_empty() {
            return Err(BUSY.to_string());
        }
        let flag = Arc::new(AtomicBool::new(false));
        map.insert(model_id.to_string(), Arc::clone(&flag));
        Ok(flag)
    }

    /// Holds `model_id` without waiting on other downloads: refused only while `model_id` itself
    /// is active or reserved. A reservation keeps `start` busy until the guard drops.
    pub fn reserve<'a>(&'a self, model_id: &'a str) -> Result<ActiveDownload<'a>, String> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(model_id) {
            return Err(BUSY.to_string());
        }
        map.insert(model_id.to_string(), Arc::new(AtomicBool::new(false)));
        Ok(ActiveDownload::new(self, model_id))
    }

    pub fn finish(&self, model_id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(model_id);
    }

    /// Raises the stop flag of `model_id`; `true` when it is downloading or reserved. A
    /// reservation's flag has no reader, so only a running download actually stops.
    pub fn stop(&self, model_id: &str) -> bool {
        match self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(model_id)
        {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn is_active(&self, model_id: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(model_id)
    }
}

/// Runs `finish` for its model when dropped, so every exit path of a download clears its flag.
pub struct ActiveDownload<'a> {
    flags: &'a DownloadFlags,
    model_id: &'a str,
}

impl<'a> ActiveDownload<'a> {
    pub fn new(flags: &'a DownloadFlags, model_id: &'a str) -> Self {
        Self { flags, model_id }
    }
}

impl Drop for ActiveDownload<'_> {
    fn drop(&mut self) {
        self.flags.finish(self.model_id);
    }
}

/// Stops the download of `model_id` and clears its files unless `is_ready` says the model is
/// complete. Readiness is read after any wait, so a download that finishes meanwhile survives.
/// Only the model's own active download is waited for: an idle model is reserved instead, so
/// cancelling it never queues behind another model's download.
pub async fn cancel_download(
    flags: &DownloadFlags,
    lock: &AsyncMutex<()>,
    model_id: &str,
    dir: &Path,
    is_ready: impl FnOnce(&Path) -> bool,
) -> std::io::Result<()> {
    if !flags.stop(model_id) {
        if let Ok(_reserved) = flags.reserve(model_id) {
            return cancel_files(dir, is_ready(dir));
        }
        // Its download started between `stop` and `reserve`.
        flags.stop(model_id);
    }
    // The download releases the lock once its loop has stopped (or after verify/unpack finishes).
    let _guard = lock.lock().await;
    cancel_files(dir, is_ready(dir))
}

#[derive(Debug)]
pub enum WriteOutcome {
    Done(u64),
    Paused(u64),
}

/// Writes the stream to `out`, checking `stop` after every chunk; reports the bytes written.
/// `on_chunk` receives the running total after each chunk.
pub async fn write_stream<S, T, E>(
    mut stream: S,
    out: &mut impl Write,
    stop: &AtomicBool,
    mut on_chunk: impl FnMut(u64),
) -> Result<WriteOutcome, String>
where
    S: futures_util::Stream<Item = Result<T, E>> + Unpin,
    T: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let mut written = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download stream: {e}"))?;
        let chunk = chunk.as_ref();
        out.write_all(chunk).map_err(|e| format!("write: {e}"))?;
        written += chunk.len() as u64;
        on_chunk(written);
        if stop.load(Ordering::SeqCst) {
            out.flush().map_err(|e| format!("flush: {e}"))?;
            return Ok(WriteOutcome::Paused(written));
        }
    }
    out.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(WriteOutcome::Done(written))
}

pub struct DiskState {
    /// `ready`, `paused` or `not-downloaded`.
    pub status: &'static str,
    pub downloaded_bytes: u64,
}

/// `ready` when the caller says so; `paused` when any finished file or `.part` exists; else
/// `not-downloaded`. Bytes count finished files at their catalog size plus `.part` lengths.
pub fn disk_state(dir: &Path, files: &[(&str, u64)], ready: bool) -> DiskState {
    let total: u64 = files.iter().map(|(_, size)| size).sum();
    if ready {
        return DiskState {
            status: "ready",
            downloaded_bytes: total,
        };
    }
    let mut bytes = 0u64;
    let mut any = false;
    for (name, size) in files {
        if dir.join(name).is_file() {
            bytes += size;
            any = true;
        } else if let Ok(meta) = std::fs::metadata(dir.join(format!("{name}.part"))) {
            bytes += meta.len().min(*size);
            any = true;
        }
    }
    DiskState {
        status: if any { "paused" } else { "not-downloaded" },
        downloaded_bytes: bytes,
    }
}

/// Cancel: a model that is not ready loses its whole folder (finished files, `.part` files, an
/// archive and an interrupted unpack), so it reads as `not-downloaded` again. A ready model is
/// left alone; removing it is a separate action.
pub fn cancel_files(dir: &Path, ready: bool) -> std::io::Result<()> {
    if ready || !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    fn chunks(
        parts: &[&'static [u8]],
    ) -> impl futures_util::Stream<Item = Result<Vec<u8>, String>> + Unpin {
        stream::iter(
            parts
                .iter()
                .map(|p| Ok(p.to_vec()))
                .collect::<Vec<Result<Vec<u8>, String>>>(),
        )
    }

    #[tokio::test]
    async fn pausing_mid_stream_keeps_exactly_the_bytes_received() {
        let stop = AtomicBool::new(false);
        let mut out = Vec::new();
        let mut seen = 0;
        let outcome = write_stream(chunks(&[b"abc", b"def", b"ghi"]), &mut out, &stop, |_| {
            seen += 1;
            if seen == 2 {
                stop.store(true, Ordering::SeqCst)
            }
        })
        .await
        .unwrap();
        assert!(matches!(outcome, WriteOutcome::Paused(6)));
        assert_eq!(out, b"abcdef");
    }

    #[tokio::test]
    async fn a_full_stream_reports_done() {
        let stop = AtomicBool::new(false);
        let mut out = Vec::new();
        let outcome = write_stream(chunks(&[b"ab", b"cd"]), &mut out, &stop, |_| {})
            .await
            .unwrap();
        assert!(matches!(outcome, WriteOutcome::Done(4)));
        assert_eq!(out, b"abcd");
    }

    #[tokio::test]
    async fn a_stream_error_is_reported() {
        let stop = AtomicBool::new(false);
        let mut out = Vec::new();
        let items: Vec<Result<Vec<u8>, String>> = vec![Ok(b"ab".to_vec()), Err("reset".into())];
        let err = write_stream(stream::iter(items), &mut out, &stop, |_| {})
            .await
            .err()
            .unwrap();
        assert!(err.contains("reset"));
        assert_eq!(out, b"ab");
    }

    #[test]
    fn only_one_download_at_a_time() {
        let flags = DownloadFlags::default();
        flags.start("a").unwrap();
        assert_eq!(flags.start("b").unwrap_err(), BUSY);
        assert!(flags.stop("a"));
        flags.finish("a");
        assert!(!flags.is_active("a"));
        assert!(flags.start("b").is_ok());
    }

    #[test]
    fn stopping_an_idle_model_is_a_no_op() {
        let flags = DownloadFlags::default();
        assert!(!flags.stop("a"));
        let flag = flags.start("a").unwrap();
        assert!(!flags.stop("b"));
        assert!(!flag.load(Ordering::SeqCst));
        assert!(flags.stop("a"));
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn the_active_guard_frees_the_slot_on_drop() {
        let flags = DownloadFlags::default();
        flags.start("a").unwrap();
        {
            let _active = ActiveDownload::new(&flags, "a");
            assert!(flags.is_active("a"));
        }
        assert!(!flags.is_active("a"));
        assert!(flags.start("b").is_ok());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-dl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn states_from_disk_report_paused_with_bytes() {
        let dir = temp_dir("paused");
        std::fs::write(dir.join("a.onnx"), vec![0u8; 10]).unwrap();
        std::fs::write(dir.join("b.onnx.part"), vec![0u8; 4]).unwrap();
        let state = disk_state(&dir, &[("a.onnx", 10), ("b.onnx", 20)], false);
        assert_eq!(state.status, "paused");
        assert_eq!(state.downloaded_bytes, 14);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn states_from_disk_report_ready_and_not_downloaded() {
        let dir = temp_dir("states");
        assert_eq!(
            disk_state(&dir, &[("a.onnx", 10)], false).status,
            "not-downloaded"
        );
        assert_eq!(
            disk_state(&dir.join("missing"), &[("a.onnx", 10)], false).status,
            "not-downloaded"
        );
        let ready = disk_state(&dir, &[("a.onnx", 10)], true);
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.downloaded_bytes, 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_deletes_partials_and_the_folder() {
        let dir = temp_dir("cancel");
        std::fs::write(dir.join("b.onnx.part"), b"x").unwrap();
        cancel_files(&dir, false).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn cancel_on_a_partial_model_removes_its_folder() {
        let dir = temp_dir("partial");
        std::fs::write(dir.join("a.onnx"), b"x").unwrap();
        std::fs::write(dir.join("b.onnx.part"), b"x").unwrap();
        cancel_files(&dir, false).unwrap();
        assert!(!dir.exists());
        assert_eq!(
            disk_state(&dir, &[("a.onnx", 1), ("b.onnx", 1)], false).status,
            "not-downloaded"
        );
    }

    #[test]
    fn cancel_on_a_ready_model_leaves_it_intact() {
        let dir = temp_dir("ready");
        std::fs::write(dir.join("a.onnx"), b"x").unwrap();
        cancel_files(&dir, true).unwrap();
        assert!(dir.join("a.onnx").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_removes_an_interrupted_unpack() {
        let dir = temp_dir("staging");
        std::fs::write(dir.join("voice.tar.bz2"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("unpack.part").join("espeak-ng-data")).unwrap();
        std::fs::write(dir.join("unpack.part").join("tokens.txt"), b"x").unwrap();
        cancel_files(&dir, false).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn cancelling_a_missing_folder_is_fine() {
        let dir = temp_dir("gone").join("missing");
        assert!(cancel_files(&dir, false).is_ok());
    }

    #[test]
    fn a_reservation_keeps_new_downloads_out() {
        let flags = DownloadFlags::default();
        let reserved = flags.reserve("a").unwrap();
        assert_eq!(flags.start("b").unwrap_err(), BUSY);
        assert!(flags.reserve("a").is_err());
        drop(reserved);
        assert!(flags.start("b").is_ok());
    }

    #[test]
    fn a_reservation_coexists_with_another_active_download() {
        let flags = DownloadFlags::default();
        flags.start("other").unwrap();
        let reserved = flags.reserve("idle");
        assert!(reserved.is_ok());
        assert!(flags.reserve("other").is_err());
        drop(reserved);
        assert!(flags.is_active("other"));
        assert!(!flags.is_active("idle"));
    }

    #[tokio::test]
    async fn cancelling_an_idle_model_does_not_wait_for_another_download() {
        let flags = DownloadFlags::default();
        let lock = AsyncMutex::new(());
        flags.start("other").unwrap();
        let _held = lock.lock().await;
        let dir = temp_dir("idle-cancel");
        std::fs::write(dir.join("a.onnx.part"), b"x").unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            cancel_download(&flags, &lock, "idle", &dir, |_| false),
        )
        .await
        .expect("cancel of an idle model must not wait for the download lock")
        .unwrap();
        assert!(!dir.exists());
        assert!(!flags.is_active("idle"));
        assert!(flags.is_active("other"));
    }

    #[tokio::test]
    async fn cancelling_the_active_download_stops_it_and_waits_for_its_loop() {
        let flags = DownloadFlags::default();
        let lock = AsyncMutex::new(());
        let flag = flags.start("a").unwrap();
        let held = lock.lock().await;
        let dir = temp_dir("active-cancel");
        std::fs::write(dir.join("a.onnx.part"), b"x").unwrap();
        let waited = tokio::time::timeout(
            Duration::from_millis(50),
            cancel_download(&flags, &lock, "a", &dir, |_| false),
        )
        .await;
        assert!(
            waited.is_err(),
            "cancel must wait while the download holds the lock"
        );
        assert!(flag.load(Ordering::SeqCst));
        assert!(dir.exists());
        drop(held);
        cancel_download(&flags, &lock, "a", &dir, |_| false)
            .await
            .unwrap();
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn readiness_is_checked_after_the_wait() {
        // A download that finishes while cancel waits must survive: cancel reads readiness late.
        let flags = DownloadFlags::default();
        let lock = AsyncMutex::new(());
        let dir = temp_dir("late-ready");
        std::fs::write(dir.join("a.onnx"), b"x").unwrap();
        let checked = std::cell::Cell::new(false);
        cancel_download(&flags, &lock, "a", &dir, |d| {
            checked.set(true);
            d.join("a.onnx").is_file()
        })
        .await
        .unwrap();
        assert!(checked.get());
        assert!(dir.join("a.onnx").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
