import { getLocale, intlLocale, translate, type Locale } from './i18n'

export function getGreeting(date: Date = new Date(), locale: Locale = getLocale()): string {
  const h = date.getHours()
  if (h >= 5 && h < 12) return translate(locale, 'greeting.morning')
  if (h >= 12 && h < 18) return translate(locale, 'greeting.afternoon')
  return translate(locale, 'greeting.evening')
}

function weekdayShort(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'short' })
    .format(date)
    .replace('.', '')
    .toLowerCase()
}

function monthShort(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'short' })
    .format(date)
    .replace('.', '')
    .toLowerCase()
}

/** Formato: "wed, 8 may · 09:32" */
export function formatHomeDate(date: Date = new Date(), locale: Locale = getLocale()): string {
  const wd = weekdayShort(date, locale)
  const day = date.getDate()
  const mo = monthShort(date, locale)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${wd}, ${day} ${mo} · ${h}:${m}`
}

/** "23:14", "yesterday 18:42", "3 days", "now" */
export function formatRelativeTimestamp(
  ts: number,
  now: number = Date.now(),
  locale: Locale = getLocale(),
): string {
  if (!ts) return '—'
  const diffMs = now - ts
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return translate(locale, 'time.now')
  if (diffMin < 60) return translate(locale, 'time.minutes', { n: diffMin })
  const date = new Date(ts)
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) {
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  if (isYesterday) {
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return translate(locale, 'time.yesterday', { time: `${h}:${m}` })
  }
  const diffDays = Math.floor(diffMs / 86_400_000)
  if (diffDays < 30) return translate(locale, 'time.daysAgo', { n: diffDays })
  return `${date.getDate()} ${monthShort(date, locale)}`
}
