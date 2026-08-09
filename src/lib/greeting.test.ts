import { describe, expect, it } from 'vitest'

import { formatRelativeTimestamp, getGreeting } from './greeting'

describe('formatRelativeTimestamp', () => {
  it('retorna travessão para timestamp zero', () => {
    expect(formatRelativeTimestamp(0, 1_000, 'en')).toBe('—')
  })

  it('retorna now abaixo de um minuto', () => {
    const now = new Date('2026-08-08T12:00:00').getTime()
    expect(formatRelativeTimestamp(now - 30_000, now, 'en')).toBe('now')
  })

  it('retorna minutos abaixo de uma hora', () => {
    const now = new Date('2026-08-08T12:00:00').getTime()
    expect(formatRelativeTimestamp(now - 5 * 60_000, now, 'en')).toBe('5min')
  })

  it('retorna horário no mesmo dia', () => {
    const now = new Date('2026-08-08T12:00:00').getTime()
    const ts = new Date('2026-08-08T09:32:00').getTime()
    expect(formatRelativeTimestamp(ts, now, 'en')).toBe('09:32')
  })

  it('retorna ontem com horário usando comparação de dia do calendário', () => {
    const now = new Date('2026-08-08T01:00:00').getTime()
    const ts = new Date('2026-08-07T22:00:00').getTime()
    expect(formatRelativeTimestamp(ts, now, 'en')).toBe('yesterday 22:00')
  })

  it('retorna dias atrás entre 2 e 29 dias', () => {
    const now = new Date('2026-08-08T12:00:00').getTime()
    const ts = now - 3 * 86_400_000
    expect(formatRelativeTimestamp(ts, now, 'en')).toBe('3 days')
  })

  it('retorna dia e mês para 30 dias ou mais', () => {
    const now = new Date('2026-08-08T12:00:00').getTime()
    const ts = new Date('2026-07-01T12:00:00').getTime()
    expect(formatRelativeTimestamp(ts, now, 'en')).toBe('1 jul')
  })
})

describe('getGreeting', () => {
  it('retorna bom dia às 05:00', () => {
    expect(getGreeting(new Date('2026-08-08T05:00:00'), 'en')).toBe('Good morning')
  })

  it('retorna boa tarde às 12:00', () => {
    expect(getGreeting(new Date('2026-08-08T12:00:00'), 'en')).toBe('Good afternoon')
  })

  it('retorna boa noite às 18:00', () => {
    expect(getGreeting(new Date('2026-08-08T18:00:00'), 'en')).toBe('Good evening')
  })
})
