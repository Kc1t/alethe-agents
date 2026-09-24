import { concatFloat32, resampleLinear, SPEECH_TARGET_SAMPLE_RATE } from './audio'

export type MicDevice = {
  deviceId: string
  label: string
}

export async function listMicrophoneDevices(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  // A permission grant is required before device labels are populated.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach((track) => track.stop())
  } catch {
    /* Labels may stay empty; still return device ids. */
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }))
}

export type AudioCaptureSession = {
  stop: () => Promise<{ samples: Float32Array; sampleRate: number; peak: number }>
}

function peakAmplitude(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i] ?? 0)
    if (value > peak) peak = value
  }
  return peak
}

/** Capture mono PCM from the preferred mic until `stop()` is called. */
export async function startAudioCapture(deviceId: string | null): Promise<AudioCaptureSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone API is unavailable in this webview.')
  }

  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 1,
  }
  if (deviceId) {
    audioConstraints.deviceId = { exact: deviceId }
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
  } catch (firstError) {
    try {
      // Fall back to the system default when the preferred device is missing.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      const message = firstError instanceof Error ? firstError.message : String(firstError)
      throw new Error(
        `Microphone permission denied or unavailable (${message}). Allow the mic for Alethe and try again.`,
      )
    }
  }

  const liveTracks = stream.getAudioTracks().filter((track) => track.readyState === 'live')
  if (liveTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('Microphone opened but no live audio track was returned.')
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const context = new AudioCtx()
  // WebKit often starts AudioContext suspended until resume() — without it,
  // ScriptProcessor never fires and dictation captures silence.
  if (context.state === 'suspended') {
    await context.resume()
  }

  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(input))
  }

  source.connect(processor)
  // Keep the graph alive without playing mic audio through the speakers.
  const mute = context.createGain()
  mute.gain.value = 0
  processor.connect(mute)
  mute.connect(context.destination)

  return {
    stop: async () => {
      processor.onaudioprocess = null
      try {
        processor.disconnect()
        source.disconnect()
        mute.disconnect()
      } catch {
        /* already torn down */
      }
      stream.getTracks().forEach((track) => track.stop())
      const inputRate = context.sampleRate || SPEECH_TARGET_SAMPLE_RATE
      await context.close().catch(() => undefined)
      const merged = concatFloat32(chunks)
      const samples = resampleLinear(merged, inputRate, SPEECH_TARGET_SAMPLE_RATE)
      return { samples, sampleRate: SPEECH_TARGET_SAMPLE_RATE, peak: peakAmplitude(samples) }
    },
  }
}
