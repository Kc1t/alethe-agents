//! One output stream for synthesized speech (cloud and local voices). `cpal::Stream` is `!Send`,
//! so the stream lives on its own thread; callers only touch the shared queue.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;

/// The characters of the utterance's text a chunk speaks, in code points.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextSpan {
    pub start: usize,
    pub len: usize,
}

/// Where the spoken word is: the chunk being played (each mark is the queue position its samples
/// end at, and its text) plus the share of it already played, mapped onto its characters. Past
/// the audio queued so far it stays on the last character queued, so a gap while the next chunk
/// is synthesized keeps the word just said rather than pointing at the next one.
pub fn spoken_char_offset(marks: &[(u64, TextSpan)], played: u64) -> usize {
    let mut start = 0;
    for &(end, span) in marks {
        if played < end {
            let share = (played - start) as f64 / (end - start) as f64;
            return span.start + (share * span.len as f64).floor() as usize;
        }
        start = end;
    }
    marks
        .last()
        .map_or(0, |(_, span)| span.start + span.len.saturating_sub(1))
}

pub struct PcmQueue {
    samples: VecDeque<f32>,
    current: Option<u64>,
    closed: bool,
    /// Samples queued and played for the current utterance, and where each chunk's text ends.
    queued: u64,
    played: u64,
    marks: Vec<(u64, TextSpan)>,
    /// Held where it is: silence goes out and nothing is taken from the queue.
    paused: bool,
    /// Plays at the same pace with zero gain, so progress and the finish report go on.
    muted: bool,
}

impl PcmQueue {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::new(),
            current: None,
            closed: false,
            queued: 0,
            played: 0,
            marks: Vec::new(),
            paused: false,
            muted: false,
        }
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }

    #[cfg(test)]
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    #[cfg(test)]
    pub fn is_muted(&self) -> bool {
        self.muted
    }

    fn forget_progress(&mut self) {
        self.queued = 0;
        self.played = 0;
        self.marks.clear();
    }

    pub fn begin(&mut self, id: u64) {
        self.samples.clear();
        self.current = Some(id);
        self.closed = false;
        self.forget_progress();
    }

    pub fn push(&mut self, id: u64, samples: &[f32]) {
        if self.current == Some(id) {
            self.samples.extend(samples.iter().copied());
            self.queued += samples.len() as u64;
        }
    }

    /// Queues a chunk and remembers which characters of the utterance it speaks.
    pub fn push_text(&mut self, id: u64, samples: &[f32], span: TextSpan) {
        if self.current == Some(id) {
            self.push(id, samples);
            self.marks.push((self.queued, span));
        }
    }

    /// The character offset reached in utterance `id`'s text; none when it is not playing.
    pub fn progress(&self, id: u64) -> Option<usize> {
        (self.current == Some(id)).then(|| spoken_char_offset(&self.marks, self.played))
    }

    pub fn close(&mut self, id: u64) {
        if self.current == Some(id) {
            self.closed = true;
        }
    }

    /// Drops the queued audio. Pause and mute stay: a new utterance clears the queue too, and a
    /// pause asked for meanwhile must hold it.
    pub fn clear(&mut self) {
        self.samples.clear();
        self.current = None;
        self.closed = false;
        self.forget_progress();
    }

    /// Drops everything and returns the id that was in flight, so a dead stream can release waiters.
    pub fn abort(&mut self) -> Option<u64> {
        self.samples.clear();
        self.closed = false;
        self.forget_progress();
        self.current.take()
    }

    /// Fills `out` (silence past the end) and returns the id that just finished, if any.
    pub fn pull(&mut self, out: &mut [f32]) -> Option<u64> {
        if self.paused {
            out.fill(0.0);
            return None;
        }
        let gain = if self.muted { 0.0 } else { 1.0 };
        for sample in out.iter_mut() {
            *sample = match self.samples.pop_front() {
                Some(value) => {
                    self.played += 1;
                    value * gain
                }
                None => 0.0,
            };
        }
        if self.closed && self.samples.is_empty() {
            self.closed = false;
            return self.current.take();
        }
        None
    }
}

pub fn pcm16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / i16::MAX as f32)
        .collect()
}

pub fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() || from == 0 {
        return input.to_vec();
    }
    let len = ((input.len() as u64 * to as u64) / from as u64) as usize;
    let step = from as f64 / to as f64;
    (0..len)
        .map(|index| {
            let position = index as f64 * step;
            let base = position.floor() as usize;
            let next = (base + 1).min(input.len() - 1);
            let fraction = (position - base as f64) as f32;
            input[base.min(input.len() - 1)] * (1.0 - fraction) + input[next] * fraction
        })
        .collect()
}

pub struct AudioOut {
    queue: Arc<Mutex<PcmQueue>>,
    device_rate: u32,
    dead: Arc<AtomicBool>,
}

impl AudioOut {
    fn with_queue(&self, work: impl FnOnce(&mut PcmQueue)) {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        work(&mut queue);
    }

    pub fn begin(&self, id: u64) {
        self.with_queue(|queue| queue.begin(id));
    }

    /// Queues a chunk of utterance `id` that speaks `span` of its text.
    pub fn push(&self, id: u64, samples: &[f32], rate: u32, span: TextSpan) {
        let resampled = resample_linear(samples, rate, self.device_rate);
        self.with_queue(|queue| queue.push_text(id, &resampled, span));
    }

    pub fn progress(&self, id: u64) -> Option<usize> {
        let queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.progress(id)
    }

    pub fn close(&self, id: u64) {
        self.with_queue(|queue| queue.close(id));
    }

    pub fn stop(&self) {
        self.with_queue(PcmQueue::clear);
    }
}

static OUT: Mutex<Option<Arc<AudioOut>>> = Mutex::new(None);
/// Player state for the session, kept here so a player reopened after a stream error inherits it.
static PAUSED: AtomicBool = AtomicBool::new(false);
static MUTED: AtomicBool = AtomicBool::new(false);

fn running() -> Option<Arc<AudioOut>> {
    OUT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Holds (or releases) the utterance playing now at the sample it reached.
pub fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
    if let Some(out) = running() {
        out.with_queue(|queue| queue.set_paused(paused));
    }
}

/// Plays on in silence (or audibly again); applies to this utterance and the next ones.
pub fn set_muted(muted: bool) {
    MUTED.store(muted, Ordering::Relaxed);
    if let Some(out) = running() {
        out.with_queue(|queue| queue.set_muted(muted));
    }
}

pub fn is_muted() -> bool {
    MUTED.load(Ordering::Relaxed)
}

#[cfg(test)]
fn is_paused() -> bool {
    PAUSED.load(Ordering::Relaxed)
}

/// The shared player. It is reused while its stream is alive and reopened after a stream error
/// (for example a headset unplug); a failed open is never cached, so the next call retries.
/// `on_finished` is used only when this call opens a new player; it runs on a worker thread,
/// never on the audio callback, and also fires for the in-flight id when the stream dies so
/// waiters are released.
pub fn get(on_finished: impl Fn(u64) + Send + 'static) -> Result<Arc<AudioOut>, String> {
    let mut slot = OUT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(out) = slot.as_ref() {
        if !out.dead.load(Ordering::Relaxed) {
            return Ok(Arc::clone(out));
        }
    }
    let out = Arc::new(open(on_finished)?);
    *slot = Some(Arc::clone(&out));
    Ok(out)
}

/// Drops queued audio, before a new utterance or on a stop. The pause stays.
pub fn stop_if_running() {
    if let Some(out) = running() {
        out.stop();
    }
}

/// Stop and barge-in: drops queued audio and releases the pause.
pub fn stop_and_release() {
    stop_if_running();
    set_paused(false);
}

/// Fills one callback period: mono samples fanned out to every channel. Silence when the queue
/// is contended, so the audio thread never blocks.
fn render<T: Copy>(
    data: &mut [T],
    channels: usize,
    mono: &mut Vec<f32>,
    queue: &Mutex<PcmQueue>,
    finished_tx: &mpsc::Sender<u64>,
    convert: impl Fn(f32) -> T,
) {
    mono.resize(data.len() / channels, 0.0);
    let pulled = match queue.try_lock() {
        Ok(mut guard) => guard.pull(mono),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner().pull(mono),
        Err(std::sync::TryLockError::WouldBlock) => {
            mono.fill(0.0);
            None
        }
    };
    if let Some(id) = pulled {
        let _ = finished_tx.send(id);
    }
    for (frame, value) in data.chunks_mut(channels).zip(mono.iter()) {
        frame.fill(convert(*value));
    }
}

fn open(on_finished: impl Fn(u64) + Send + 'static) -> Result<AudioOut, String> {
    let mut fresh = PcmQueue::new();
    fresh.set_paused(PAUSED.load(Ordering::Relaxed));
    fresh.set_muted(MUTED.load(Ordering::Relaxed));
    let queue = Arc::new(Mutex::new(fresh));
    let dead = Arc::new(AtomicBool::new(false));
    let (finished_tx, finished_rx) = mpsc::channel::<u64>();
    std::thread::spawn(move || {
        while let Ok(id) = finished_rx.recv() {
            on_finished(id);
        }
    });

    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let stream_queue = Arc::clone(&queue);
    let stream_dead = Arc::clone(&dead);
    std::thread::spawn(move || {
        let built = (|| -> Result<(cpal::Stream, u32), String> {
            let device = cpal::default_host()
                .default_output_device()
                .ok_or_else(|| "no audio output device".to_string())?;
            let supported = device.default_output_config().map_err(|e| e.to_string())?;
            let channels = supported.channels() as usize;
            let rate = supported.sample_rate().0;
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();

            let error_queue = Arc::clone(&stream_queue);
            let error_tx = finished_tx.clone();
            let error_dead = Arc::clone(&stream_dead);
            let on_error = move |error: cpal::StreamError| {
                eprintln!("audio_out: stream error: {error}");
                error_dead.store(true, Ordering::Relaxed);
                let aborted = error_queue
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .abort();
                if let Some(id) = aborted {
                    let _ = error_tx.send(id);
                }
            };

            let render_queue = stream_queue;
            let mut mono: Vec<f32> = Vec::with_capacity(8192);
            let stream = match format {
                SampleFormat::F32 => device.build_output_stream(
                    &config,
                    move |data: &mut [f32], _| {
                        render(
                            data,
                            channels,
                            &mut mono,
                            &render_queue,
                            &finished_tx,
                            |v| v,
                        )
                    },
                    on_error,
                    None,
                ),
                SampleFormat::I16 => device.build_output_stream(
                    &config,
                    move |data: &mut [i16], _| {
                        render(
                            data,
                            channels,
                            &mut mono,
                            &render_queue,
                            &finished_tx,
                            |v| (v * i16::MAX as f32) as i16,
                        )
                    },
                    on_error,
                    None,
                ),
                other => return Err(format!("unsupported output sample format: {other:?}")),
            }
            .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok((stream, rate))
        })();
        match built {
            Ok((stream, rate)) => {
                let _ = ready_tx.send(Ok(rate));
                // This thread owns the stream until it dies, then drops it so a reopen starts clean.
                while !stream_dead.load(Ordering::Relaxed) {
                    std::thread::park_timeout(std::time::Duration::from_millis(500));
                }
                drop(stream);
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
            }
        }
    });

    let device_rate = ready_rx
        .recv()
        .map_err(|_| "audio output thread exited".to_string())??;
    Ok(AudioOut {
        queue,
        device_rate,
        dead,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_stop_drops_queued_audio() {
        let mut queue = PcmQueue::new();
        queue.begin(1);
        queue.push(1, &[0.5; 10]);
        queue.close(1);
        queue.clear();
        let mut out = [9.0; 4];
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn finish_is_reported_once_after_close_and_drain() {
        let mut queue = PcmQueue::new();
        queue.begin(7);
        queue.push(7, &[0.1, 0.2, 0.3]);
        let mut out = [0.0; 2];
        assert_eq!(queue.pull(&mut out), None);
        queue.close(7);
        assert_eq!(queue.pull(&mut out), Some(7));
        assert_eq!(queue.pull(&mut out), None);
    }

    #[test]
    fn an_open_utterance_waits_for_more_chunks() {
        let mut queue = PcmQueue::new();
        queue.begin(3);
        queue.push(3, &[0.1]);
        let mut out = [0.0; 4];
        assert_eq!(queue.pull(&mut out), None, "drained but not closed");
        queue.push(3, &[0.2]);
        queue.close(3);
        assert_eq!(queue.pull(&mut out), Some(3));
        assert_eq!(out[0], 0.2);
    }

    #[test]
    fn chunks_of_an_interrupted_utterance_are_ignored() {
        let mut queue = PcmQueue::new();
        queue.begin(1);
        queue.begin(2);
        queue.push(1, &[0.9; 4]);
        queue.close(1);
        let mut out = [0.0; 4];
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn pcm16_decodes_to_unit_floats() {
        let bytes = [0x00, 0x00, 0xff, 0x7f, 0x01, 0x80];
        let samples = pcm16le_to_f32(&bytes);
        assert_eq!(samples[0], 0.0);
        assert!((samples[1] - 1.0).abs() < 1e-4);
        assert!((samples[2] + 1.0).abs() < 1e-4);
    }

    #[test]
    fn resampling_scales_the_length() {
        assert_eq!(resample_linear(&[0.0; 240], 24_000, 48_000).len(), 480);
        assert_eq!(resample_linear(&[0.0; 480], 48_000, 24_000).len(), 240);
        assert_eq!(resample_linear(&[0.25; 3], 16_000, 16_000), vec![0.25; 3]);
    }

    #[test]
    fn begin_drops_samples_queued_for_the_previous_utterance() {
        let mut queue = PcmQueue::new();
        queue.begin(1);
        queue.push(1, &[0.5; 4]);
        queue.close(1);
        queue.begin(2);
        let mut out = [9.0; 4];
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.0; 4]);
        assert_eq!(queue.pull(&mut out), None, "id 1 never finishes");
    }

    #[test]
    fn abort_returns_the_in_flight_id_and_clears() {
        let mut queue = PcmQueue::new();
        queue.begin(5);
        queue.push(5, &[0.5; 4]);
        assert_eq!(queue.abort(), Some(5));
        assert_eq!(queue.abort(), None);
        let mut out = [9.0; 2];
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.0; 2]);
    }

    #[test]
    fn upsampling_interpolates_and_holds_the_last_sample() {
        assert_eq!(resample_linear(&[0.0, 1.0], 1, 2), vec![0.0, 0.5, 1.0, 1.0]);
    }

    #[test]
    fn a_paused_queue_plays_silence_and_resumes_from_the_same_sample() {
        let mut queue = PcmQueue::new();
        queue.begin(1);
        queue.push(1, &[0.1, 0.2, 0.3]);
        queue.close(1);
        queue.set_paused(true);
        let mut out = [9.0; 2];
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.0; 2]);
        assert_eq!(queue.pull(&mut out), None, "nothing finishes while paused");
        queue.set_paused(false);
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.1, 0.2]);
        assert_eq!(queue.pull(&mut out), Some(1));
        assert_eq!(out, [0.3, 0.0]);
    }

    #[test]
    fn a_muted_queue_drains_at_the_same_pace_in_silence() {
        let mut queue = PcmQueue::new();
        queue.set_muted(true);
        queue.begin(4);
        queue.push(4, &[0.5; 3]);
        queue.close(4);
        let mut out = [9.0; 2];
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.0; 2]);
        assert_eq!(
            queue.pull(&mut out),
            Some(4),
            "the finish is still reported"
        );
        assert_eq!(out, [0.0; 2]);
        queue.set_muted(false);
        queue.begin(5);
        queue.push(5, &[0.5; 2]);
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.5; 2]);
    }

    #[test]
    fn mute_and_pause_outlive_an_utterance_and_its_queue_being_dropped() {
        let mut queue = PcmQueue::new();
        queue.set_muted(true);
        queue.set_paused(true);
        queue.begin(1);
        assert!(queue.is_muted() && queue.is_paused());
        // A new utterance drops the queued audio; a pause in place must hold it too.
        queue.clear();
        assert!(queue.is_muted() && queue.is_paused());
    }

    // `tts_speak` stops the player before a new utterance: that must not undo a pause asked for
    // meanwhile. Only `tts_stop` (stop, barge-in) and `tts_resume` release it.
    #[test]
    fn stopping_the_player_for_a_new_utterance_keeps_the_pause() {
        set_paused(true);
        stop_if_running();
        assert!(is_paused());
        stop_and_release();
        assert!(!is_paused());
        set_paused(true);
        set_paused(false);
        assert!(!is_paused());
    }

    fn span(start: usize, len: usize) -> TextSpan {
        TextSpan { start, len }
    }

    // Chunk 1 speaks characters 0..10 in 100 samples, chunk 2 characters 11..31 in 50.
    #[test]
    fn the_spoken_offset_moves_through_each_chunk_by_its_played_share() {
        let marks = [(100, span(0, 10)), (150, span(11, 20))];
        assert_eq!(spoken_char_offset(&marks, 0), 0);
        assert_eq!(spoken_char_offset(&marks, 50), 5);
        assert_eq!(spoken_char_offset(&marks, 99), 9);
        assert_eq!(spoken_char_offset(&marks, 100), 11);
        assert_eq!(spoken_char_offset(&marks, 125), 21);
        assert_eq!(
            spoken_char_offset(&marks, 150),
            30,
            "the last character queued"
        );
        assert_eq!(spoken_char_offset(&marks, 999), 30);
        assert_eq!(spoken_char_offset(&[], 10), 0, "nothing queued yet");
    }

    // The next chunk is still being synthesized: the word just said stays the current one,
    // rather than the gap after it pointing at the next word.
    #[test]
    fn between_chunks_the_offset_stays_on_the_last_word_queued() {
        let marks = [(100, span(0, 10))];
        assert_eq!(spoken_char_offset(&marks, 100), 9);
        assert_eq!(spoken_char_offset(&[(0, span(0, 0))], 0), 0);
    }

    #[test]
    fn progress_is_reported_only_for_the_utterance_playing() {
        let mut queue = PcmQueue::new();
        assert_eq!(queue.progress(1), None);
        queue.begin(1);
        queue.push_text(1, &[0.1; 4], span(0, 4));
        queue.push_text(1, &[0.1; 4], span(5, 8));
        assert_eq!(queue.progress(1), Some(0));
        assert_eq!(queue.progress(2), None, "not the current id");
        let mut out = [0.0; 2];
        queue.pull(&mut out);
        assert_eq!(queue.progress(1), Some(2));
        queue.pull(&mut out);
        assert_eq!(queue.progress(1), Some(5));
        queue.pull(&mut out);
        assert_eq!(queue.progress(1), Some(9));
        // A new utterance starts again from its own text.
        queue.begin(2);
        assert_eq!(queue.progress(1), None);
        assert_eq!(queue.progress(2), Some(0));
    }

    #[test]
    fn progress_freezes_while_paused_and_goes_on_while_muted() {
        let mut queue = PcmQueue::new();
        queue.begin(1);
        queue.push_text(1, &[0.1; 8], span(0, 8));
        let mut out = [0.0; 2];
        queue.pull(&mut out);
        queue.set_paused(true);
        queue.pull(&mut out);
        queue.pull(&mut out);
        assert_eq!(queue.progress(1), Some(2), "frozen while paused");
        queue.set_paused(false);
        queue.set_muted(true);
        queue.pull(&mut out);
        assert_eq!(queue.progress(1), Some(4), "muted still advances");
    }

    #[test]
    fn a_finished_or_dropped_utterance_reports_no_progress() {
        let mut queue = PcmQueue::new();
        queue.begin(1);
        queue.push_text(1, &[0.1; 2], span(0, 2));
        queue.close(1);
        let mut out = [0.0; 2];
        assert_eq!(queue.pull(&mut out), Some(1));
        assert_eq!(queue.progress(1), None);
        queue.begin(2);
        queue.push_text(2, &[0.1; 2], span(0, 2));
        queue.clear();
        assert_eq!(queue.progress(2), None);
    }

    #[test]
    fn pcm16_ignores_a_trailing_odd_byte() {
        assert_eq!(pcm16le_to_f32(&[0x00, 0x00, 0xff]).len(), 1);
    }
}
