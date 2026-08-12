// Este foi feito para criar o modal visual da Central de Auditoria e Logs do Alethe, permitindo filtrar, pesquisar, copiar e exportar relatórios de erros completos diretamente da interface.

import { Copy, Download, ShieldAlert, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { type AuditEntry, auditLogger, type AuditLogLevel } from '../../lib/auditLogger'
import { writeClipboardText } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import styles from './AuditModal.module.css'

export function AuditModal() {
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

  if (openModal !== ('audit' as unknown)) return null

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
      title: 'Relatório de auditoria copiado',
      body: 'Cole no chat para análise imediata do agente.',
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
            <span>Central de Auditoria e Diagnósticos do Alethe</span>
          </div>
          <button
            type="button"
            className={styles.filterBtn}
            onClick={() => closeModal()}
            aria-label="Fechar"
            style={{ padding: '2px 6px' }}
          >
            <X size={14} />
          </button>
        </div>

        <div className={styles.controls}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Pesquisar nos logs de auditoria (mensagem, categoria ou stack)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className={`${styles.filterBtn} ${filterLevel === 'all' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilterLevel('all')}
          >
            Todos ({logs.length})
          </button>
          <button
            type="button"
            className={`${styles.filterBtn} ${filterLevel === 'error' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilterLevel('error')}
          >
            Erros ({logs.filter((l) => l.level === 'error').length})
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={copyReport}
            title="Copiar relatório completo para área de transferência"
          >
            <Copy size={12} /> Copiar
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={downloadReport}
            title="Baixar arquivo JSON de diagnósticos"
          >
            <Download size={12} /> Exportar
          </button>
          <button
            type="button"
            className={styles.filterBtn}
            onClick={() => auditLogger.clear()}
            title="Limpar logs"
          >
            <Trash2 size={12} />
          </button>
        </div>

        <div className={styles.logList}>
          {filteredLogs.length === 0 ? (
            <p className={styles.empty}>
              Nenhum registro de auditoria encontrado para o filtro atual.
            </p>
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
