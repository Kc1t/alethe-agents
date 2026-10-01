import { ChevronDown, ChevronRight, GitCompareArrows } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  type GitFileChange,
  gitIncomingOutgoing,
  type IncomingOutgoing as IncomingOutgoingData,
} from '../../lib/tauri'
import styles from './IncomingOutgoing.module.css'

/** Arquivos que um `pull`/`push` traria/enviaria — só aparece quando existe
 *  branch adiantada/atrasada (`ahead`/`behind` vêm do mesmo `GitRepositoryStatus`
 *  já usado pro botão de sync, evita duplicar a lógica de "existe algo pra
 *  sincronizar"). Busca sob demanda (só quando aberto), igual ao GitGraph. */
export function IncomingOutgoing({
  repoRoot,
  ahead,
  behind,
}: {
  repoRoot: string
  ahead: number
  behind: number
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<IncomingOutgoingData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !repoRoot) return
    let cancelled = false
    gitIncomingOutgoing(repoRoot)
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, repoRoot, ahead, behind])

  if (ahead === 0 && behind === 0) return null

  const total = data ? data.incoming.length + data.outgoing.length : null

  return (
    <section className={styles.group}>
      <button type="button" className={styles.groupHeader} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <GitCompareArrows size={13} />
        <strong>{t('git.incomingOutgoing.title')}</strong>
      </button>
      {open ? (
        <div className={styles.body}>
          {error ? <p className={styles.error}>{error}</p> : null}
          {!data && !error ? (
            <p className={styles.loading}>{t('git.incomingOutgoing.loading')}</p>
          ) : null}
          {data && total === 0 ? (
            <p className={styles.empty}>{t('git.incomingOutgoing.empty')}</p>
          ) : null}
          {data ? (
            <>
              <FileList
                label={t('git.incomingOutgoing.incoming', { count: data.incoming.length })}
                items={data.incoming}
              />
              <FileList
                label={t('git.incomingOutgoing.outgoing', { count: data.outgoing.length })}
                items={data.outgoing}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function FileList({ label, items }: { label: string; items: GitFileChange[] }) {
  if (items.length === 0) return null
  return (
    <div className={styles.sub}>
      <div className={styles.subLabel}>{label}</div>
      {items.map((item) => (
        <div key={item.path} className={styles.file} title={item.path}>
          <span className={styles.status}>{(item.status.trim()[0] ?? '•').toUpperCase()}</span>
          <span className={styles.fileName}>{item.path}</span>
        </div>
      ))}
    </div>
  )
}
