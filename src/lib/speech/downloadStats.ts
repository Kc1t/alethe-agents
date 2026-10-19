/** Speed and time-left arithmetic for the speech model download, plus Intl-localized units. */

export type DownloadSample = { bytes: number; at: number }
export type DownloadRate = { bytesPerSecond: number | null; last: DownloadSample }

/** Weight of the newest sample; low enough that one slow burst does not swing the estimate. */
const SMOOTHING = 0.3

export function nextRate(previous: DownloadRate | null, sample: DownloadSample): DownloadRate {
  if (!previous || sample.bytes < previous.last.bytes) {
    return { bytesPerSecond: null, last: sample }
  }
  const seconds = (sample.at - previous.last.at) / 1000
  if (seconds <= 0) return previous
  const instant = (sample.bytes - previous.last.bytes) / seconds
  const bytesPerSecond =
    previous.bytesPerSecond === null
      ? instant
      : previous.bytesPerSecond * (1 - SMOOTHING) + instant * SMOOTHING
  return { bytesPerSecond, last: sample }
}

export function etaSeconds(remainingBytes: number, bytesPerSecond: number | null): number | null {
  if (!bytesPerSecond || bytesPerSecond <= 0) return null
  return Math.ceil(Math.max(0, remainingBytes) / bytesPerSecond)
}

function unit(value: number, name: string, locale: string, fractionDigits = 1): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: name,
    unitDisplay: 'short',
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

function sizeUnit(bytes: number): [number, string] {
  if (bytes >= 1e9) return [bytes / 1e9, 'gigabyte']
  if (bytes >= 1e6) return [bytes / 1e6, 'megabyte']
  return [bytes / 1e3, 'kilobyte']
}

export function formatByteSize(bytes: number, locale: string): string {
  const [value, name] = sizeUnit(bytes)
  return unit(value, name, locale)
}

export function formatRate(bytesPerSecond: number, locale: string): string {
  const [value, name] = sizeUnit(bytesPerSecond)
  return unit(value, `${name}-per-second`, locale)
}

export function formatDuration(seconds: number, locale: string): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) {
    return [unit(hours, 'hour', locale, 0), minutes ? unit(minutes, 'minute', locale, 0) : '']
      .filter(Boolean)
      .join(' ')
  }
  if (minutes > 0) {
    return [unit(minutes, 'minute', locale, 0), rest ? unit(rest, 'second', locale, 0) : '']
      .filter(Boolean)
      .join(' ')
  }
  return unit(rest, 'second', locale, 0)
}
