import { useEffect, useState } from 'react'

import { buildChangeProcedurePrompt } from '../../lib/changeProcedurePrompt'
import { resolveAgentPromptTargets } from '../../lib/changeTriggerTargets'
import { useT } from '../../lib/i18n'
import { type DiffSummaryEntry, gitWorkingTreeStats, writePty } from '../../lib/tauri'
import { getProjectRepoRoot } from '../../lib/terminalFactory'
import { useChangeTriggerStore } from '../../stores/changeTriggerStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { DiffStatBar } from '../ui/DiffStatBar'
import styles from './ChangeProcedureModal.module.css'
import controls from './controls.module.css'
import { Modal } from './Modal'

/**
 * Shows what changed and offers to ask the agent to write up the procedure for it.
 *
 * The list is read from the working tree at open time rather than from the trigger's event: the
 * event carries a capped sample taken when it fired, and by the time the user clicks the badge the
 * tree has usually moved on. Showing stale paths would undercut the whole point of the screen.
 *
 * Sending types the prompt into the agent's existing conversation — nothing is spawned. Both
 * buttons acknowledge the trigger, because the user has now been asked: raising the same batch
 * again after they declined it is nagging, not a reminder.
 */
export function ChangeProcedureModal({ projectId }: { projectId: string }) {
  const t = useT()
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId))
  const pushToast = useUiStore((s) => s.pushToast)
  const dismiss = useChangeTriggerStore((s) => s.dismiss)

  const [changed, setChanged] = useState<DiffSummaryEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [targetPtyId, setTargetPtyId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const targets = resolveAgentPromptTargets(project)
  const repo = getProjectRepoRoot(project)

  useEffect(() => {
    if (!repo) {
      setLoadError(t('changeTrigger.noRepository'))
      return
    }
    let cancelled = false
    gitWorkingTreeStats(repo)
      .then((entries) => {
        if (!cancelled) setChanged(entries)
      })
      .catch((error) => {
        // Never a silent empty list: "nothing changed" and "we could not look" are different
        // answers, and only one of them means there is nothing to do.
        console.error(`[change-trigger] working tree stats failed for ${repo}:`, error)
        if (!cancelled) setLoadError(String(error))
      })
    return () => {
      cancelled = true
    }
  }, [repo, t])

  useEffect(() => {
    if (targetPtyId === null && targets.length > 0) setTargetPtyId(targets[0].ptyId)
  }, [targetPtyId, targets])

  const close = () => dismiss(projectId)

  const totals = (changed ?? []).reduce(
    (accumulated, file) => ({
      additions: accumulated.additions + (file.additions ?? 0),
      deletions: accumulated.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  )

  const handleSend = async () => {
    const target = targets.find((candidate) => candidate.ptyId === targetPtyId)
    if (!target || !changed || changed.length === 0) return
    setSending(true)
    try {
      const prompt = buildChangeProcedurePrompt(t, changed)
      await writePty(target.ptyId, `${prompt}\r`)
      pushToast({
        title: t('changeTrigger.sentTitle'),
        body: t('changeTrigger.sentBody', { agent: target.terminalName }),
      })
      close()
    } catch (error) {
      pushToast({ title: t('changeTrigger.sendFailedTitle'), body: String(error) })
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      open
      onClose={close}
      title={t('changeTrigger.title')}
      width={520}
      footer={
        <div className={styles.footerRow}>
          <button type="button" className={controls.btn} onClick={close}>
            {t('changeTrigger.dismiss')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={sending || !targetPtyId || !changed || changed.length === 0}
            onClick={() => void handleSend()}
          >
            {t('changeTrigger.send')}
          </button>
        </div>
      }
    >
      <div className={styles.summary}>
        <span>{t('changeTrigger.subtitle', { count: changed?.length ?? 0 })}</span>
        {changed && changed.length > 0 ? (
          <span className={styles.totals}>
            <span className={styles.added}>+{totals.additions}</span>
            <span className={styles.removed}>−{totals.deletions}</span>
          </span>
        ) : null}
      </div>

      {loadError ? (
        <div className={styles.empty}>{t('changeTrigger.loadFailed', { error: loadError })}</div>
      ) : changed === null ? (
        <div className={styles.loading}>{t('changeTrigger.loading')}</div>
      ) : changed.length === 0 ? (
        <div className={styles.empty}>{t('changeTrigger.nothingChanged')}</div>
      ) : (
        <div className={styles.fileList}>
          {changed.map((file) => (
            <div key={file.path} className={styles.fileRow}>
              <span className={styles.path} title={file.path}>
                {file.path}
              </span>
              <span className={styles.stats}>
                {file.additions == null || file.deletions == null ? (
                  <span className={styles.binary}>{t('changeTrigger.binary')}</span>
                ) : (
                  <>
                    <span className={styles.added}>+{file.additions}</span>
                    <span className={styles.removed}>−{file.deletions}</span>
                    <DiffStatBar additions={file.additions} deletions={file.deletions} />
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {targets.length === 0 ? (
        <div className={styles.noTarget}>{t('changeTrigger.noAgentRunning')}</div>
      ) : targets.length > 1 ? (
        <div className={styles.targetField}>
          <label className={styles.targetLabel} htmlFor="change-trigger-target">
            {t('changeTrigger.targetLabel')}
          </label>
          <select
            id="change-trigger-target"
            className={controls.input}
            value={targetPtyId ?? ''}
            onChange={(event) => setTargetPtyId(event.target.value)}
          >
            {targets.map((target) => (
              <option key={target.ptyId} value={target.ptyId}>
                {target.terminalName} ({target.agentType})
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </Modal>
  )
}
