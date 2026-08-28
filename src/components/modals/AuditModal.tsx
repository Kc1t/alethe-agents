import { Copy, Download, ShieldAlert, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { type AuditEntry, auditLogger, type AuditLogLevel } from '../../lib/auditLogger'
import { writeClipboardText } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import styles from './AuditModal.module.css'

export function AuditModal() {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal)
  const closeModal = useUiStore((s) => s.closeModal)
  const pushToast = useUiStore((s) => s.pushToast)

  const [logs, setLogs] = useState<AuditEntry[]>([])
  const [filterLevel, setFilterLevel] = useState<AuditLogLevel | 'all'>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const unsubscribe = auditLogger.subscribe((entries) => {
      setLogs(entries)
    })
    return () => unsubscribe()
  }, [])

  if (openModal !== 'audit') return null

  const filteredLogs = logs.filter((log) => {
    if (filterLevel !== 'all' && log.level !== filterLevel) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      log.message.toLowerCase().includes(q) ||
      log.category.toLowerCase().includes(q) ||
      (log.stack && log.stack.toLowerCase().includes(q))
    )
  })

  const copyReport = () => {
    const report = auditLogger.exportReport()
    void writeClipboardText(report)
    pushToast({
      title: t('audit.copiedTitle'),
      body: t('audit.copiedBody'),
    })
  }

  const downloadReport = () => {
    const report = auditLogger.exportReport()
    const blob = new Blob([report], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `alethe-audit-log-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={styles.overlay} onClick={() => closeModal()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.titleGroup}>
            <ShieldAlert size={16} style={{ color: 'var(--status-offline)' }} />
            <span>{t('audit.title')}</span>
          </div>
          <button
            type="button"
            className={styles.filterBtn}
            onClick={() => closeModal()}
            aria-label={t('common.close')}
            style={{ padding: '2px 6px' }}
          >
            <X size={14} />
          </button>
        </div>

        <div className={styles.controls}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder={t('audit.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className={`${styles.filterBtn} ${filterLevel === 'all' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilterLevel('all')}
          >
            {t('audit.filterAll', { count: logs.length })}
          </button>
          <button
            type="button"
            className={`${styles.filterBtn} ${filterLevel === 'error' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilterLevel('error')}
          >
            {t('audit.filterErrors', { count: logs.filter((l) => l.level === 'error').length })}
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={copyReport}
            title={t('audit.copyTooltip')}
          >
            <Copy size={12} /> {t('audit.copy')}
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={downloadReport}
            title={t('audit.exportTooltip')}
          >
            <Download size={12} /> {t('audit.export')}
          </button>
          <button
            type="button"
            className={styles.filterBtn}
            onClick={() => auditLogger.clear()}
            title={t('audit.clearTooltip')}
          >
            <Trash2 size={12} />
          </button>
        </div>

        <div className={styles.logList}>
          {filteredLogs.length === 0 ? (
            <p className={styles.empty}>{t('audit.empty')}</p>
          ) : (
            filteredLogs.map((entry) => (
              <div
                key={entry.id}
                className={`${styles.logRow} ${
                  entry.level === 'error'
                    ? styles.logRowError
                    : entry.level === 'warn'
                      ? styles.logRowWarn
                      : styles.logRowInfo
                }`}
              >
                <div className={styles.logHeader}>
                  <span className={styles.badgeCategory}>[{entry.category}]</span>
                  <span className={styles.time}>{entry.isoTime}</span>
                  <span style={{ fontSize: '10px', color: 'var(--fg-faint)', marginLeft: 'auto' }}>
                    {entry.env}
                  </span>
                </div>
                <div className={styles.message}>{entry.message}</div>
                {entry.stack ? <pre className={styles.stack}>{entry.stack}</pre> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
