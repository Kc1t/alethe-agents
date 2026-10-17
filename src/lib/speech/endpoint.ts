const MEDIAN_WINDOW = 5
const FLOOR_RISE = 0.004
const FLOOR_RATIO = 2.2
const PEAK_RATIO = 0.05
const PEAK_DECAY = 0.98
const MIN_THRESHOLD = 0.004
const MIN_SPEECH_MS = 500
const END_SILENCE_MS = 1600

const VAD_MIN_SPEECH_MS = 300
const VAD_END_SILENCE_MS = 900

export function vadSpeechEnded(status: { heardMs: number; silenceMs: number }): boolean {
  return status.heardMs >= VAD_MIN_SPEECH_MS && status.silenceMs >= VAD_END_SILENCE_MS
}

export type SpeechEndpoint = {
  push: (level: number, now: number) => boolean
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

export function createSpeechEndpoint(endSilenceMs = END_SILENCE_MS): SpeechEndpoint {
  const recent: number[] = []
  let floor = Number.POSITIVE_INFINITY
  let peak = 0
  let speechStartedAt = 0
  let lastSpeechAt = 0

  return {
    push(level, now) {
      recent.push(level)
      if (recent.length > MEDIAN_WINDOW) recent.shift()
      const smooth = median(recent)

      floor = smooth < floor ? smooth : floor + (smooth - floor) * FLOOR_RISE
      peak = Math.max(smooth, peak * PEAK_DECAY)
      const threshold = Math.max(MIN_THRESHOLD, floor * FLOOR_RATIO, peak * PEAK_RATIO)

      if (smooth > threshold) {
        if (!speechStartedAt) speechStartedAt = now
        lastSpeechAt = now
        return false
      }
      if (!speechStartedAt || lastSpeechAt - speechStartedAt < MIN_SPEECH_MS) return false
      return now - lastSpeechAt >= endSilenceMs
    },
  }
}
