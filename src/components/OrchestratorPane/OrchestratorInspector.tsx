import { convertFileSrc } from '@tauri-apps/api/core'
import {
  GitBranch,
  Globe2,
  Play,
  RotateCcw,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useOnEscape } from '../../hooks/useOnEscape'
import type { MessageKey, TFunction } from '../../lib/i18n'
import { extractMediaItems, splitPromotedMedia, type MediaItem } from '../../lib/orchestratorMedia'
import { type ShellControl, shellControls } from '../../lib/orchestratorShells'
import { shortcutsForJob } from '../../lib/orchestratorShortcuts'
import { basename } from '../../lib/paths'
import type { OrchestratorJob, OrchestratorShell } from '../../lib/tauri/orchestrator'
import type { OrchestratorShortcut, Theme } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { MarkdownRenderer } from '../MarkdownPane/MarkdownRenderer'
import { Modal } from '../modals/Modal'
import { XTermView } from '../XTermView'
import styles from './OrchestratorInspector.module.css'
import {
  AgentGlyph,
  contextShare,
  diffLineClass,
  formatElapsed,
  formatTokens,
  hostnameOf,
  pathOf,
  statusTitle,
} from './nodeFormat'

export type InspectorTarget =
  | { kind: 'worker'; job: OrchestratorJob }
  | { kind: 'shell'; shell: OrchestratorShell }

export type OrchestratorInspectorProps = {
  target: InspectorTarget
  projectId: string
  theme: Theme
  terminalTheme: Theme
  diffText: string | undefined
  diffLoading: boolean
  shortcuts: readonly OrchestratorShortcut[]
  /** Whether the terminal the worker's agent runs in is still alive; irrelevant for a shell target. */
  plannerAlive: boolean
  shellBusy: boolean
  canStopJob: boolean
  onClose: () => void
  onLoadDiff: (jobId: string) => void
  onStopJob: (jobId: string) => void
  onShortcut: (job: OrchestratorJob, shortcut: OrchestratorShortcut) => void
  onShellControl: (shell: OrchestratorShell, control: ShellControl) => void
  t: TFunction
}

type Tab = 'report' | 'diff'

const CONTROL_ICON: Record<ShellControl, typeof Square> = {
  stop: Square,
  restart: RotateCcw,
  play: Play,
  openTerminal: TerminalIcon,
  remove: Trash2,
}

const CONTROL_LABEL: Record<ShellControl, MessageKey> = {
  stop: 'orchestrator.shell.stop',
  restart: 'orchestrator.shell.restart',
  play: 'orchestrator.shell.play',
  openTerminal: 'orchestrator.shell.openTerminal',
  remove: 'orchestrator.shell.remove',
}

type WorkerBodyProps = {
  job: OrchestratorJob
  tab: Tab
  onSelectTab: (tab: Tab) => void
  projectId: string
  theme: Theme
  diffText: string | undefined
  diffLoading: boolean
  shortcuts: readonly OrchestratorShortcut[]
  plannerAlive: boolean
  canStopJob: boolean
  previewMedia: MediaItem | null
  onPreviewMedia: (item: MediaItem | null) => void
  onClose: () => void
  onStopJob: (jobId: string) => void
  onShortcut: (job: OrchestratorJob, shortcut: OrchestratorShortcut) => void
  t: TFunction
}

function WorkerBody({
  job,
  tab,
  onSelectTab,
  projectId,
  theme,
  diffText,
  diffLoading,
  shortcuts,
  plannerAlive,
  canStopJob,
  previewMedia,
  onPreviewMedia,
  onClose,
  onStopJob,
  onShortcut,
  t,
}: WorkerBodyProps) {
  const share = contextShare(job)
  const tokens = formatTokens(job.tokens?.total?.totalTokens)
  const elapsed = formatElapsed(job.seconds)
  const plan = job.plan.filter((step) => step.trim().length > 0)
  const report = job.summary.trim()
  // No planner to send an instruction to beats "no shortcut happened to match" as an explanation —
  // the person should never see an empty row and wonder whether that's a bug.
  const applicableShortcuts = plannerAlive ? shortcutsForJob(shortcuts, job) : []

  // The first image a worker's report mentions is promoted to its own canvas card (see
  // `promotedMediaByJobId` in `index.tsx`) — this strip only shows what didn't get promoted:
  // links, and any 2nd+ image. `splitPromotedMedia` is the shared rule for both.
  const remainingMedia = useMemo(() => {
    if (!report) return []
    return splitPromotedMedia(extractMediaItems(report)).remaining
  }, [report])

  return (
    <>
      <header className={styles.head}>
        <div className={styles.headMeta}>
          <AgentGlyph
            agent={job.agent}
            theme={theme}
            title={t('orchestrator.agentTitle', { agent: job.agent })}
            className={styles.glyph}
          />
          <span className={styles.workerId}>{job.id}</span>
          <span className={styles.metaStatus} title={statusTitle(job.status, t)}>
            {t(`orchestrator.status.${job.status}`)}
          </span>
          {elapsed && <span className={styles.metaValue}>{elapsed}</span>}
          {share !== null && (
            <span
              className={styles.metaValue}
              title={t('orchestrator.contextTitle', { percent: share })}
            >
              {t('orchestrator.contextChip', { value: share })}
            </span>
          )}
          {tokens && (
            <span className={styles.metaValue} title={t('orchestrator.tokensTitle')}>
              {tokens}
            </span>
          )}
          {job.worktree && (
            <span className={styles.metaIcon} title={job.worktree}>
              <GitBranch size={11} aria-hidden />
              {t('orchestrator.isolated')}
            </span>
          )}
        </div>
        <div className={styles.headActions}>
          {canStopJob && (
            <button
              type="button"
              className={styles.headBtn}
              aria-label={t('orchestrator.stopWorker')}
              title={t('orchestrator.stopWorker')}
              onClick={() => onStopJob(job.id)}
            >
              <Square size={14} />
            </button>
          )}
          {plannerAlive ? (
            applicableShortcuts.map((shortcut) => (
              <button
                key={shortcut.id}
                type="button"
                className={styles.shortcutBtn}
                onClick={() => onShortcut(job, shortcut)}
              >
                {shortcut.name}
              </button>
            ))
          ) : (
            <span className={styles.noShortcuts}>{t('orchestrator.noPlannerForShortcuts')}</span>
          )}
          <button
            type="button"
            className={styles.headBtn}
            aria-label={t('orchestrator.inspectorClose')}
            title={t('orchestrator.inspectorClose')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'report'}
          className={styles.tab}
          data-selected={tab === 'report' ? 'true' : undefined}
          onClick={() => onSelectTab('report')}
        >
          {t('orchestrator.reportTab')}
        </button>
        {job.hasDiff && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'diff'}
            className={styles.tab}
            data-selected={tab === 'diff' ? 'true' : undefined}
            onClick={() => onSelectTab('diff')}
          >
            {t('orchestrator.diffTab')}
          </button>
        )}
      </div>

      <div className={styles.body}>
        {tab === 'report' ? (
          <div className={styles.report}>
            {plan.length > 0 && (
              <>
                <div className={styles.sectionLabel}>{t('orchestrator.planLabel')}</div>
                <ul className={styles.plan}>
                  {plan.map((step, index) => (
                    <li key={`${job.id}-plan-${index}`}>{step}</li>
                  ))}
                </ul>
              </>
            )}
            <div className={styles.sectionLabel}>{t('orchestrator.summaryLabel')}</div>
            {report ? (
              <MarkdownRenderer content={report} dark={theme === 'dark'} />
            ) : (
              <p>{t('orchestrator.noReport')}</p>
            )}
            {remainingMedia.length > 0 && (
              <div className={styles.mediaStrip}>
                {remainingMedia.map((item) =>
                  item.kind === 'link' ? (
                    <button
                      key={item.value}
                      type="button"
                      className={styles.mediaLink}
                      title={item.value}
                      onClick={() =>
                        useProjectsStore.getState().createWebPane(projectId, { url: item.value })
                      }
                    >
                      <Globe2 size={13} />
                      <span className={styles.mediaLinkText}>
                        <span className={styles.mediaLinkHost}>{hostnameOf(item.value)}</span>
                        <span className={styles.mediaLinkPath}>{pathOf(item.value)}</span>
                      </span>
                    </button>
                  ) : (
                    <button
                      key={item.value}
                      type="button"
                      className={styles.mediaFigure}
                      title={item.value}
                      onClick={() => onPreviewMedia(item)}
                    >
                      <img
                        className={styles.mediaThumb}
                        src={item.kind === 'image-local' ? convertFileSrc(item.value) : item.value}
                        alt=""
                        loading="lazy"
                      />
                      <span className={styles.mediaCaption}>{basename(item.value)}</span>
                    </button>
                  ),
                )}
              </div>
            )}
            {previewMedia && (
              <Modal
                open
                onClose={() => onPreviewMedia(null)}
                title={basename(previewMedia.value)}
                width={720}
              >
                <div className={styles.mediaPreviewBody}>
                  <img
                    className={styles.mediaPreviewImage}
                    src={
                      previewMedia.kind === 'image-local'
                        ? convertFileSrc(previewMedia.value)
                        : previewMedia.value
                    }
                    alt=""
                  />
                  <div className={styles.mediaPreviewPath} title={previewMedia.value}>
                    {previewMedia.value}
                  </div>
                </div>
              </Modal>
            )}
          </div>
        ) : diffLoading ? (
          <p className={styles.report}>{t('orchestrator.diffLoading')}</p>
        ) : (
          <pre className={styles.diff}>
            {(diffText || t('diff.empty')).split('\n').map((line, index) => (
              <span key={index} className={diffLineClass(line, styles)}>
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        )}
      </div>
    </>
  )
}

type ShellBodyProps = {
  shell: OrchestratorShell
  projectId: string
  terminalTheme: Theme
  shellBusy: boolean
  onClose: () => void
  onShellControl: (shell: OrchestratorShell, control: ShellControl) => void
  t: TFunction
}

function ShellBody({
  shell,
  projectId,
  terminalTheme,
  shellBusy,
  onClose,
  onShellControl,
  t,
}: ShellBodyProps) {
  const setInspectorPty = useUiStore((state) => state.setInspectorPty)

  // This terminal is an overlay, not a workspace pane, so nothing else would report its PTY as on
  // screen: it would open with no scrollback and with its output stream switched off.
  useEffect(() => {
    setInspectorPty(shell.ptyId)
    return () => setInspectorPty(null)
  }, [shell.ptyId, setInspectorPty])

  const status =
    shell.status === 'running'
      ? t('orchestrator.shell.running')
      : shell.status === 'exited'
        ? t('orchestrator.shell.exited', { code: shell.exitCode ?? '—' })
        : t('orchestrator.shell.stopped')

  return (
    <>
      <header className={styles.head}>
        <div className={styles.headMeta}>
          <span className={styles.workerId}>{shell.name}</span>
          <code className={styles.command} title={shell.cwd}>
            {shell.command}
          </code>
          <span className={styles.metaValue} title={shell.cwd}>
            {t('orchestrator.shellCwd', { path: shell.cwd })}
          </span>
          <span className={styles.metaStatus}>{status}</span>
        </div>
        <div className={styles.headActions}>
          {shellControls(shell.status).map((control) => {
            const Icon = CONTROL_ICON[control]
            const label = t(CONTROL_LABEL[control])
            return (
              <button
                key={control}
                type="button"
                className={styles.headBtn}
                disabled={shellBusy && control !== 'openTerminal'}
                title={label}
                aria-label={label}
                onClick={() => onShellControl(shell, control)}
              >
                <Icon size={14} />
              </button>
            )
          })}
          <button
            type="button"
            className={styles.headBtn}
            aria-label={t('orchestrator.inspectorClose')}
            title={t('orchestrator.inspectorClose')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className={styles.terminal}>
        <XTermView
          ptyId={shell.ptyId}
          projectId={projectId}
          command={null}
          cwd={shell.cwd}
          terminalTheme={terminalTheme}
        />
      </div>
    </>
  )
}

export function OrchestratorInspector(props: OrchestratorInspectorProps) {
  const { target, onClose, t } = props
  const [tab, setTab] = useState<Tab>('report')
  const [previewMedia, setPreviewMedia] = useState<MediaItem | null>(null)
  const targetKey = target.kind === 'worker' ? target.job.id : target.shell.id

  // The image lightbox is a nested Radix dialog with its own Escape dismissal. Registering this
  // listener while it is open would win the race (capture phase, `preventDefault` unconditionally)
  // and close the whole panel instead of just the image — so it must not even be attached then.
  useOnEscape(
    (event) => {
      event.preventDefault()
      onClose()
    },
    previewMedia === null,
    { capture: true },
  )

  useEffect(() => {
    setTab('report')
    setPreviewMedia(null)
  }, [targetKey])

  const selectTab = (next: Tab) => {
    setTab(next)
    if (next === 'diff' && target.kind === 'worker') props.onLoadDiff(target.job.id)
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {target.kind === 'worker' ? (
          <WorkerBody
            job={target.job}
            tab={tab}
            onSelectTab={selectTab}
            projectId={props.projectId}
            theme={props.theme}
            diffText={props.diffText}
            diffLoading={props.diffLoading}
            shortcuts={props.shortcuts}
            plannerAlive={props.plannerAlive}
            canStopJob={props.canStopJob}
            previewMedia={previewMedia}
            onPreviewMedia={setPreviewMedia}
            onClose={onClose}
            onStopJob={props.onStopJob}
            onShortcut={props.onShortcut}
            t={t}
          />
        ) : (
          <ShellBody
            shell={target.shell}
            projectId={props.projectId}
            terminalTheme={props.terminalTheme}
            shellBusy={props.shellBusy}
            onClose={onClose}
            onShellControl={props.onShellControl}
            t={t}
          />
        )}
      </div>
    </div>
  )
}
