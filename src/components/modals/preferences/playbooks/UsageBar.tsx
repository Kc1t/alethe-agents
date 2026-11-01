import { useEffect, useRef, useState } from 'react'

import { PLAN_DAYS, RESET_HOURS, ROUTES } from '../../../../lib/playbooks/catalog'
import {
  hoursText,
  spareWhy,
  usagePresetLabel,
  windowLabel,
} from '../../../../lib/playbooks/labels'
import {
  expiresOf,
  longWindow,
  lowProviders,
  mainLoad,
  presetUsage,
  providerLabel,
  quotaNow,
  resetOf,
  spareOf,
  usageKey,
  usageOf,
  usagePresetIds,
  windowsOf,
} from '../../../../lib/playbooks/state'
import { usePlaybooks } from './context'
import { Select } from './fields'
import styles from './Playbooks.module.css'
import { ProviderMark } from './ProviderMark'

const withCurrent = (list: number[], value: number | null) =>
  value === null || list.includes(value) ? list : [...list, value].sort((a, b) => a - b)

function Range({
  label,
  value,
  hot,
  onCommit,
}: {
  label: string
  value: number
  hot: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(value)
  return (
    <div className={styles.usageLine}>
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={() => onCommit(draft)}
        onKeyUp={() => onCommit(draft)}
      />
      <span className={draft >= hot ? `${styles.usageValue} ${styles.hot}` : styles.usageValue}>
        {draft}%
      </span>
    </div>
  )
}

export function UsageBar({ onChange }: { onChange: () => void }) {
  const { s, t, select } = usePlaybooks()
  const [open, setOpen] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const q = quotaNow(s)
  const low = lowProviders(s)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (rootRef.current?.contains(target)) return
      if (target?.closest('[data-alethe-dropdown-menu]')) return
      setOpen(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const tone = (value: number) =>
    value >= q.criticalThreshold ? 'danger' : value >= q.criticalThreshold - 20 ? 'warn' : 'normal'
  const current = open && s.providers.includes(open) ? open : null
  const def = current ? s.catalog[current] : null
  const spare = current ? spareOf(s, current) : null
  const set = (key: string, value: number | null) => {
    if (!current) return
    s.usage[current][key] = value
    onChange()
  }

  return (
    <div ref={rootRef} className={styles.usage}>
      {s.providers.map((id) => {
        const load = mainLoad(s, id)
        const reader = s.catalog[id]?.reader
        const detail = windowsOf(s, id)
          .filter((w) => w.main)
          .map((w) => `${windowLabel(t, w)} ${usageOf(s, id, w.key)}%`)
          .join(', ')
        const title = reader
          ? t('playbooks.usagePillTitle', { provider: providerLabel(s, id), detail })
          : t('playbooks.usageSimulatedTitle', { provider: providerLabel(s, id), detail })
        return (
          <button
            key={id}
            type="button"
            className={reader ? styles.usagePill : `${styles.usagePill} ${styles.unread}`}
            data-tone={tone(load)}
            title={title}
            aria-label={title}
            aria-pressed={open === id}
            onClick={() => setOpen(open === id ? null : id)}
          >
            <ProviderMark id={id} size={13} />
            {load}%
            {spareOf(s, id) ? (
              <span className={styles.dot} data-tone="on" />
            ) : low.includes(id) ? (
              <span className={styles.dot} data-tone="danger" />
            ) : null}
          </button>
        )
      })}
      {Object.entries(s.routes).map(([rid, route]) => {
        const label = ROUTES[rid]?.label ?? rid
        const title = route.running
          ? t('playbooks.routeRunning', { route: label, port: String(route.port ?? '') })
          : t('playbooks.routeStopped', { route: label })
        return (
          <button
            key={rid}
            type="button"
            className={`${styles.usagePill} ${styles.routePill}`}
            title={title}
            aria-label={title}
            onClick={() => select(`route:${rid}`)}
          >
            <ProviderMark id={rid} size={13} />
            {route.running ? t('playbooks.on') : t('playbooks.off')}
          </button>
        )
      })}
      {current && def ? (
        <div className={styles.popover} role="dialog" aria-label={t('playbooks.usageTitle')}>
          <div className={styles.popoverTitle}>
            {t('playbooks.usageTitle')}
            <span className={styles.tabs}>
              {s.providers.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-label={providerLabel(s, id)}
                  aria-pressed={id === current}
                  onClick={() => setOpen(id)}
                >
                  <ProviderMark id={id} size={13} />
                </button>
              ))}
            </span>
          </div>
          <div className={styles.presets}>
            {usagePresetIds(s).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={key === usageKey(s)}
                onClick={() => {
                  s.usage = presetUsage(s, key)
                  onChange()
                }}
              >
                {usagePresetLabel(t, key)}
              </button>
            ))}
          </div>
          <div className={styles.popoverProvider}>
            <ProviderMark id={current} size={13} />
            {def.label}
            {low.includes(current) ? (
              <span className={styles.state} data-tone="danger">
                {t('playbooks.stateLow')}
              </span>
            ) : spare ? (
              <span className={styles.state} data-tone="on">
                {t('playbooks.stateSpare')}
              </span>
            ) : null}
          </div>
          {!def.reader ? <p className={styles.unreadNote}>{t('playbooks.unreadNote')}</p> : null}
          {windowsOf(s, current).map((w) => (
            <Range
              key={`${current}:${w.key}:${usageOf(s, current, w.key)}`}
              label={windowLabel(t, w)}
              value={usageOf(s, current, w.key)}
              hot={q.criticalThreshold}
              onCommit={(value) => set(w.key, value)}
            />
          ))}
          {longWindow(s, current) ? (
            <>
              <div className={styles.usageMeta}>
                <span>{t('playbooks.resets')}</span>
                <Select
                  value={String(resetOf(s, current) ?? 168)}
                  ariaLabel={t('playbooks.resets')}
                  options={withCurrent(RESET_HOURS, resetOf(s, current) ?? 168).map((hours) => ({
                    value: String(hours),
                    label: t('playbooks.inTime', { time: hoursText(t, hours) }),
                  }))}
                  onChange={(value) => set('reset', Number(value))}
                />
              </div>
              <div className={styles.usageMeta}>
                <span>{t('playbooks.plan')}</span>
                <Select
                  value={expiresOf(s, current) === null ? 'renews' : String(expiresOf(s, current))}
                  ariaLabel={t('playbooks.plan')}
                  options={[
                    { value: 'renews', label: t('playbooks.renews') },
                    ...withCurrent(PLAN_DAYS, expiresOf(s, current)).map((days) => ({
                      value: String(days),
                      label: t('playbooks.endsIn', { time: hoursText(t, days * 24) }),
                    })),
                  ]}
                  onChange={(value) => set('expires', value === 'renews' ? null : Number(value))}
                />
              </div>
            </>
          ) : null}
          {spare ? (
            <p className={styles.why}>
              {t('playbooks.spareLine', { why: spareWhy(t, spare), percent: spare.left })}
            </p>
          ) : null}
          <p className={styles.foot}>
            {t('playbooks.usageFoot', {
              low: q.criticalThreshold,
              stop: q.stopAt,
              spare: q.spareMinLeft,
              hours: q.spareWithinHours,
            })}
          </p>
        </div>
      ) : null}
    </div>
  )
}
