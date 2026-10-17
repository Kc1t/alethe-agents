//! Silero VAD over the live capture, so the frontend can tell speech from noise.

use std::path::Path;

use serde::Serialize;
use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};

use crate::speech_capture::{resample_linear, CaptureSession};

const VAD_RATE: u32 = 16_000;
const WINDOW: usize = 512;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VadStatus {
    pub level: f32,
    pub voice: bool,
    pub heard_ms: u64,
    pub silence_ms: u64,
    pub segments: u32,
}

pub struct VadMonitor {
    vad: VoiceActivityDetector,
    consumed_raw: usize,
    pending: Vec<f32>,
    processed: u64,
    first_voice: Option<u64>,
    last_voice: Option<u64>,
    voice: bool,
    segments: u32,
}

impl VadMonitor {
    pub fn new(model: &Path) -> Result<Self, String> {
        let config = VadModelConfig {
            silero_vad: SileroVadModelConfig {
                model: Some(model.to_string_lossy().into_owned()),
                threshold: 0.5,
                min_silence_duration: 0.3,
                min_speech_duration: 0.15,
                window_size: WINDOW as i32,
                max_speech_duration: 30.0,
            },
            sample_rate: VAD_RATE as i32,
            num_threads: 1,
            provider: Some("cpu".into()),
            debug: false,
            ..Default::default()
        };
        let vad = VoiceActivityDetector::create(&config, 60.0)
            .ok_or_else(|| "Failed to load the voice activity model".to_string())?;
        Ok(Self {
            vad,
            consumed_raw: 0,
            pending: Vec::new(),
            processed: 0,
            first_voice: None,
            last_voice: None,
            voice: false,
            segments: 0,
        })
    }

    pub fn poll(&mut self, capture: &CaptureSession) -> VadStatus {
        let (raw, total) = capture.raw_since(self.consumed_raw);
        self.consumed_raw = total;
        self.pending
            .extend(resample_linear(&raw, capture.sample_rate(), VAD_RATE));

        let mut offset = 0;
        while self.pending.len() - offset >= WINDOW {
            self.vad
                .accept_waveform(&self.pending[offset..offset + WINDOW]);
            offset += WINDOW;
            self.processed += WINDOW as u64;
            self.voice = self.vad.detected();
            if self.voice {
                self.first_voice.get_or_insert(self.processed);
                self.last_voice = Some(self.processed);
            }
            while !self.vad.is_empty() {
                self.vad.pop();
                self.segments += 1;
            }
        }
        self.pending.drain(..offset);

        let to_ms = |samples: u64| samples * 1000 / VAD_RATE as u64;
        let (heard_ms, silence_ms) = match (self.first_voice, self.last_voice) {
            (Some(first), Some(last)) => (to_ms(last - first), to_ms(self.processed - last)),
            _ => (0, 0),
        };
        VadStatus {
            level: capture.level(),
            voice: self.voice,
            heard_ms,
            silence_ms,
            segments: self.segments,
        }
    }
}
