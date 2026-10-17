import type { TFunction } from '../i18n'
import {
  speechPrepare,
  speechStartCapture,
  speechStopAndTranscribe,
  speechStopCapture,
} from '../tauri'
import type { VoiceUse } from '../types'
import { cloudFailureMessage, forgetProviderKey } from '../voice/cloudErrors'
import { isCloudProvider } from '../voice/providers'
import type { SttEngineArgs } from './engine'

/** Why the mic did not open: a message for the person, or `cancelled` when the caller went away. */
export type CaptureBlock =
  | 'speech.nativeLocaleRequired'
  | 'speech.nativeNotReady'
  | 'voice.cloud.noKey'
  | 'voice.conv.modelMissing'
  | 'cancelled'

export type OpenCaptureOptions = {
  /**
   * Also prepare a downloaded local model before the mic opens. Callers that warm it in the
   * background skip this, so the mic opens without waiting for the model.
   */
  prepareLocal?: boolean
  /** Checked after each await; true drops the attempt (and closes a mic that just opened). */
  cancelled?: () => boolean
}

function notReady(provider: SttEngineArgs['provider']): CaptureBlock {
  if (provider === 'apple') return 'speech.nativeNotReady'
  return isCloudProvider(provider) ? 'voice.cloud.noKey' : 'voice.conv.modelMissing'
}

/**
 * Readies the engine and opens the microphone: null once capturing, else why not. On Apple the
 * prepare also asks for the speech-recognition permission before the mic opens. A cloud provider
 * whose key turns out to be missing is marked unconfigured. Capture errors are thrown.
 */
export async function openCapture(
  engine: SttEngineArgs,
  micId: string | null,
  options: OpenCaptureOptions = {},
): Promise<CaptureBlock | null> {
  const cancelled = options.cancelled ?? (() => false)
  if (engine.needsLocale) return 'speech.nativeLocaleRequired'
  if (options.prepareLocal || engine.provider !== 'local') {
    // null: the check itself failed (e.g. the keychain), which says nothing about the key.
    let ready: boolean | null
    try {
      ready = await speechPrepare(engine.modelId, engine.locale, engine.provider)
    } catch {
      ready = null
    }
    if (cancelled()) return 'cancelled'
    if (ready === false && isCloudProvider(engine.provider)) forgetProviderKey(engine.provider)
    if (!ready) return notReady(engine.provider)
  }
  await speechStartCapture(micId)
  if (cancelled()) {
    // Nobody is left to close a mic that opened after the caller went away.
    void speechStopCapture().catch(() => undefined)
    return 'cancelled'
  }
  return null
}

/** Stops the capture and transcribes it, trimmed. On failure the native stream is dropped. */
export async function transcribeCapture(engine: SttEngineArgs, usage: VoiceUse): Promise<string> {
  try {
    const text = await speechStopAndTranscribe(engine.modelId, engine.locale, {
      provider: engine.provider,
      fallbackLocale: engine.fallbackLocale,
      usage,
    })
    return text.trim()
  } catch (cause) {
    await speechStopCapture().catch(() => undefined)
    throw cause
  }
}

/** A failed transcription as the person reads it: the cloud provider's reason, else the error. */
export function transcriptionFailureText(cause: unknown, provider: string, t: TFunction): string {
  return (
    cloudFailureMessage(cause, provider, t) ??
    (cause instanceof Error ? cause.message : String(cause))
  )
}

/**
 * The press/release race every capture has: a release that lands while the mic is still opening
 * (prepare, permission prompt) must stop the capture as soon as it starts, exactly once.
 */
export class CaptureGate {
  private recording = false
  private starting = false
  private stopAfterStart = false

  /** Capturing, or opening the mic. */
  get active(): boolean {
    return this.recording || this.starting
  }

  get isRecording(): boolean {
    return this.recording
  }

  /**
   * Runs `open` (true once the mic is open). A stop requested meanwhile runs `onStop` right
   * after. Errors from `open` are rethrown with the gate reset.
   */
  async start(open: () => Promise<boolean>, onStop: () => unknown): Promise<void> {
    if (this.active) return
    this.starting = true
    this.stopAfterStart = false
    let stopNow: boolean
    try {
      this.recording = await open()
      stopNow = this.recording && this.stopAfterStart
    } catch (cause) {
      this.recording = false
      throw cause
    } finally {
      this.starting = false
      this.stopAfterStart = false
    }
    if (stopNow) await onStop()
  }

  /**
   * True when the caller should stop and transcribe now. While the mic is still opening the stop
   * is deferred to `start` and this returns false.
   */
  takeStop(): boolean {
    if (!this.recording) {
      if (this.starting) this.stopAfterStart = true
      return false
    }
    this.recording = false
    return true
  }

  /** Forgets a recording without transcribing it; true when one was open (close it then). */
  abandon(): boolean {
    const was = this.recording
    this.recording = false
    return was
  }
}
