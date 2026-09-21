//! Native microphone capture via cpal (bypasses WebKit getUserMedia).
//!
//! AppImage + WebKitGTK often reports 0 capture devices even with media-stream
//! enabled. PipeWire/Pulse through cpal works outside the webview sandbox.
//!
//! `cpal::Stream` is `!Send` on this platform, so the live stream lives on a
//! dedicated thread and only Send handles cross into Tauri managed state.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};
use serde::{Deserialize, Serialize};

const TARGET_RATE: u32 = 16_000;
/// Cap ~60s of mono float at 48 kHz so a stuck session cannot grow forever.
const MAX_SAMPLES: usize = 48_000 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechInputDevice {
    pub device_id: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub peak: f32,
}

/// Send-safe handle to a recording owned by a background thread.
pub struct CaptureSession {
    stop_tx: mpsc::Sender<()>,
    join: JoinHandle<Result<CapturedAudio, String>>,
}

fn host() -> cpal::Host {
    cpal::default_host()
}

fn device_name(device: &Device) -> String {
    device.name().unwrap_or_else(|_| "unknown".into())
}

pub fn list_input_devices() -> Result<Vec<SpeechInputDevice>, String> {
    let host = host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let mut out = Vec::new();
    let devices = host
        .input_devices()
        .map_err(|e| format!("list input devices: {e}"))?;
    for device in devices {
        let name = device_name(&device);
        let is_default = default_name.as_ref() == Some(&name);
        out.push(SpeechInputDevice {
            device_id: name.clone(),
            label: name,
            is_default,
        });
    }
    if out.is_empty() {
        return Err(
            "No microphone found. Check PipeWire/PulseAudio and that a mic is connected."
                .into(),
        );
    }
    Ok(out)
}

fn resolve_device(device_id: Option<&str>) -> Result<Device, String> {
    let host = host();
    if let Some(id) = device_id {
        if !id.is_empty() {
            let devices = host
                .input_devices()
                .map_err(|e| format!("list input devices: {e}"))?;
            for device in devices {
                if device.name().ok().as_deref() == Some(id) {
                    return Ok(device);
                }
            }
        }
    }
    host.default_input_device()
        .ok_or_else(|| "No default microphone available".to_string())
}

fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame[0])
        .collect()
}

fn append_mono(dst: &Arc<Mutex<Vec<f32>>>, mono: &[f32]) {
    if let Ok(mut buf) = dst.lock() {
        if buf.len() >= MAX_SAMPLES {
            return;
        }
        let room = MAX_SAMPLES.saturating_sub(buf.len());
        let take = mono.len().min(room);
        buf.extend_from_slice(&mono[..take]);
    }
}

fn resample_linear(input: &[f32], input_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || input_rate == 0 {
        return Vec::new();
    }
    if input_rate == target_rate {
        return input.to_vec();
    }
    let ratio = input_rate as f64 / target_rate as f64;
    let out_len = ((input.len() as f64) / ratio).round().max(1.0) as usize;
    let mut out = vec![0.0; out_len];
    for (i, sample) in out.iter_mut().enumerate() {
        let src = i as f64 * ratio;
        let i0 = src.floor() as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let t = (src - i0 as f64) as f32;
        let a = input[i0];
        let b = input[i1];
        *sample = a * (1.0 - t) + b * t;
    }
    out
}

fn peak_amplitude(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0_f32, |peak, &s| peak.max(s.abs()))
}

pub fn start_capture(device_id: Option<String>) -> Result<CaptureSession, String> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    let join = std::thread::Builder::new()
        .name("alethe-speech-capture".into())
        .spawn(move || {
            let device = match resolve_device(device_id.as_deref()) {
                Ok(device) => device,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.clone()));
                    return Err(error);
                }
            };
            let supported = match device.default_input_config() {
                Ok(config) => config,
                Err(error) => {
                    let message = format!("input config: {error}");
                    let _ = ready_tx.send(Err(message.clone()));
                    return Err(message);
                }
            };
            let sample_rate = supported.sample_rate().0;
            let channels = supported.channels() as usize;
            let sample_format = supported.sample_format();
            let config: StreamConfig = supported.into();
            let samples = Arc::new(Mutex::new(Vec::with_capacity(TARGET_RATE as usize * 8)));
            let err_fn = |err| eprintln!("[speech] capture stream error: {err}");

            let stream = match sample_format {
                SampleFormat::F32 => {
                    let samples = Arc::clone(&samples);
                    device.build_input_stream(
                        &config,
                        move |data: &[f32], _| {
                            let mono = to_mono(data, channels);
                            append_mono(&samples, &mono);
                        },
                        err_fn,
                        None,
                    )
                }
                SampleFormat::I16 => {
                    let samples = Arc::clone(&samples);
                    device.build_input_stream(
                        &config,
                        move |data: &[i16], _| {
                            let floats: Vec<f32> =
                                data.iter().map(|&s| s as f32 / 32768.0).collect();
                            let mono = to_mono(&floats, channels);
                            append_mono(&samples, &mono);
                        },
                        err_fn,
                        None,
                    )
                }
                SampleFormat::U16 => {
                    let samples = Arc::clone(&samples);
                    device.build_input_stream(
                        &config,
                        move |data: &[u16], _| {
                            let floats: Vec<f32> = data
                                .iter()
                                .map(|&s| (s as f32 / 65535.0) * 2.0 - 1.0)
                                .collect();
                            let mono = to_mono(&floats, channels);
                            append_mono(&samples, &mono);
                        },
                        err_fn,
                        None,
                    )
                }
                other => {
                    let message = format!("Unsupported microphone sample format: {other:?}");
                    let _ = ready_tx.send(Err(message.clone()));
                    return Err(message);
                }
            };

            let stream = match stream {
                Ok(stream) => stream,
                Err(error) => {
                    let message = format!("build input stream: {error}");
                    let _ = ready_tx.send(Err(message.clone()));
                    return Err(message);
                }
            };

            if let Err(error) = stream.play() {
                let message = format!("start microphone stream: {error}");
                let _ = ready_tx.send(Err(message.clone()));
                return Err(message);
            }

            let _ = ready_tx.send(Ok(()));
            let _ = stop_rx.recv();
            drop(stream);

            let raw = samples.lock().map(|guard| guard.clone()).unwrap_or_default();
            let out = resample_linear(&raw, sample_rate, TARGET_RATE);
            let peak = peak_amplitude(&out);
            Ok(CapturedAudio {
                samples: out,
                sample_rate: TARGET_RATE,
                peak,
            })
        })
        .map_err(|e| format!("spawn capture thread: {e}"))?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(CaptureSession { stop_tx, join }),
        Ok(Err(error)) => {
            let _ = join.join();
            Err(error)
        }
        Err(_) => {
            let _ = join.join();
            Err("Capture thread exited before becoming ready".into())
        }
    }
}

impl CaptureSession {
    pub fn stop(self) -> Result<CapturedAudio, String> {
        let _ = self.stop_tx.send(());
        match self.join.join() {
            Ok(result) => result,
            Err(_) => Err("Capture thread panicked".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_halves_length_for_48k_to_16k() {
        let input = vec![0.5_f32; 4800];
        let out = resample_linear(&input, 48_000, 16_000);
        assert_eq!(out.len(), 1600);
    }
}
