import { Loader2, Mic, Play, Repeat } from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'

import { agentLabel } from '../../lib/agentProviders'
import { type TFunction, useT } from '../../lib/i18n'
import { isPrimaryModifier } from '../../lib/platform'
import { DEFAULT_SPEECH_MODEL_ID } from '../../lib/speech/audio'
import { createSpeechEndpoint, vadSpeechEnded } from '../../lib/speech/endpoint'
import {
  jevDecide,
  type JevDecision,
  speechCaptureLevel,
  type SpeechInputDevice,
  speechListInputDevices,
  speechPrepare,
  speechPrepareVad,
  speechStartCapture,
  speechStopCapture,
  speechTranscribePartial,
  speechVadStatus,
  stopAndTranscribe,
  writePty,
} from '../../lib/tauri'
import { type AgentType, isShellAgentType } from '../../lib/types'
import {
  BLOCK_REASONS,
  endsWithSendPhrase,
  needsConfirmation,
  planFromDecision,
  planWarnings,
  stripSendPhrase,
  toJevContext,
  type VoicePlan,
  type VoiceWarning,
  type VoiceWorkspace,
  WARNINGS,
} from '../../lib/voiceCommand'
import {
  getProjectDefaultCwd,
  selectActiveProject,
  useProjectsStore,
} from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { useVoiceHistoryStore } from '../../stores/voiceHistoryStore'
import { Dropdown } from '../ui/Dropdown'
import styles from './VoiceCommand.module.css'

const LEVEL_POLL_MS = 60
const SPECTRUM_BARS = 40
const SILENT_LEVEL = 0.005
const SILENT_POLLS_BEFORE_WARNING = 12
const SILENCE: number[] = Array.from({ length: SPECTRUM_BARS }, () => 0)
const DECIDE_TIMEOUT_MS = 20000
const PARTIAL_POLL_MS = 700
const HEARD_TAIL_CHARS = 60

async function withTimeout<T>(work: Promise<T>, timeoutMessage: string): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(timeoutMessage)), DECIDE_TIMEOUT_MS)
      }),
    ])
  } finally {
    window.clearTimeout(timer)
  }
}

function tailOf(text: string): string {
  return text.length > HEARD_TAIL_CHARS ? `…${text.slice(-HEARD_TAIL_CHARS)}` : text
}

function isOpenChord(e: KeyboardEvent): boolean {
  return isPrimaryModifier(e) && e.shiftKey && !e.altKey && (e.code === 'Space' || e.key === ' ')
}

function readWorkspace(): VoiceWorkspace {
  const projects = useProjectsStore.getState()
  const runtime = useTerminalsStore.getState().byPtyId
  const focused = useUiStore.getState().activeTerminal
  const active = selectActiveProject(projects)
  const live = projects.projects.filter((project) => !project.archived)

  const terminals: VoiceWorkspace['terminals'] = []
  for (const project of live) {
    for (const terminal of project.terminals) {
      if (terminal.kind && terminal.kind !== 'terminal') continue
      const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
      if (!tab) continue
      terminals.push({
        id: terminal.id,
        projectId: project.id,
        projectName: project.name,
        ptyId: tab.ptyId,
        agent: tab.type,
        cwd: tab.cwd || terminal.cwd,
        busy: tab.ptyId ? runtime[tab.ptyId]?.status === 'working' : false,
        name: terminal.name,
      })
    }
  }

  const enabledAgents = projects.preferences.enabledAgents

  return {
    projects: live.map((project) => ({
      id: project.id,
      name: project.name,
      path: getProjectDefaultCwd(project, projects.projects),
    })),
    terminals,
    agents: (Object.keys(enabledAgents) as AgentType[]).filter(
      (agent) => enabledAgents[agent] && !isShellAgentType(agent),
    ),
    focusedProjectId: active?.id ?? null,
    focusedTerminalId: focused?.terminalId ?? null,
  }
}

function focusTerminal(projectId: string, terminalId: string) {
  const projects = useProjectsStore.getState()
  projects.setActiveProjectOnly(projectId)
  projects.focusWorkspaceTerminal(projectId, terminalId)
  const ui = useUiStore.getState()
  ui.setActiveTerminal(projectId, terminalId)
  ui.requestPaneFocus(terminalId)
  ui.requestPaneFlash(terminalId)
}

async function runPlan(plan: VoicePlan, t: TFunction): Promise<string[]> {
  const projects = useProjectsStore.getState()

  if (plan.kind === 'focus') {
    focusTerminal(plan.projectId, plan.terminalId)
    return [t('voice.action.focused', { terminal: plan.terminalName })]
  }
  if (plan.kind === 'kill') {
    projects.deleteTerminal(plan.projectId, plan.terminalId)
    return [t('voice.action.stopped', { terminal: plan.terminalName })]
  }
  if (plan.kind === 'reuse') {
    await writePty(plan.ptyId, `${plan.prompt}\r`)
    focusTerminal(plan.projectId, plan.terminalId)
    return [t('voice.action.sent', { terminal: plan.terminalName })]
  }
  if (plan.kind !== 'spawn') return []

  const project = projects.projects.find((item) => item.id === plan.projectId)
  if (!project) throw new Error('project vanished before the plan ran')
  const cwd = getProjectDefaultCwd(project, projects.projects)

  const created = await Promise.all(
    plan.jobs.map((job, index) => {
      const label = agentLabel(job.agent)
      const sameAgent = plan.jobs.filter((item) => item.agent === job.agent).length > 1
      return projects.createAgentTerminal(plan.projectId, {
        name: sameAgent ? `${label} ${index + 1}` : label,
        cwd,
        firstTab: { type: job.agent, cwd, initialInput: job.prompt || undefined },
      })
    }),
  )
  const last = created[created.length - 1]
  if (last) focusTerminal(plan.projectId, last.id)

  return plan.jobs.map((job) => {
    const agent = agentLabel(job.agent)
    return job?.prompt
      ? t('voice.action.openedWith', { agent, project: plan.projectName, prompt: job.prompt })
      : t('voice.action.opened', { agent, project: plan.projectName })
  })
}

function summarize(plan: VoicePlan, t: TFunction): string {
  switch (plan.kind) {
    case 'spawn': {
      const agents = [...new Set(plan.jobs.map((job) => job.agent))]
      const distinctTasks = new Set(plan.jobs.map((job) => job.prompt)).size > 1
      if (distinctTasks) {
        return t('voice.summary.splitTasks', {
          count: plan.jobs.length,
          project: plan.projectName,
        })
      }
      if (agents.length > 1) {
        return t('voice.summary.launchAgents', {
          agents: agents.map(agentLabel).join(' + '),
          project: plan.projectName,
        })
      }
      return t('voice.summary.launchN', {
        count: plan.jobs.length,
        agent: agentLabel(agents[0] ?? 'claude'),
        project: plan.projectName,
      })
    }
    case 'reuse':
      return t('voice.summary.reuse', { terminal: plan.terminalName })
    case 'focus':
      return t('voice.summary.focus', { terminal: plan.terminalName })
    case 'kill':
      return t('voice.summary.kill', { terminal: plan.terminalName })
    default:
      return t(BLOCK_REASONS[plan.reason])
  }
}

export function VoiceCommand() {
  const t = useT()
  const apiKey = useProjectsStore((s) => s.preferences.voiceCommandApiKey)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const dictationEnabled = useProjectsStore((s) => s.preferences.dictationEnabled)
  const keepListening = useProjectsStore((s) => s.preferences.voiceKeepListening)
  const modelId = useProjectsStore((s) => s.preferences.dictationModelId || DEFAULT_SPEECH_MODEL_ID)
  const micId = useProjectsStore((s) => s.preferences.dictationMicrophoneId)
  const provider = useProjectsStore((s) => s.preferences.dictationProvider)
  const cloudModel = useProjectsStore((s) => s.preferences.dictationCloudModel)

  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'listening' | 'transcribing' | 'deciding'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [decision, setDecision] = useState<JevDecision | null>(null)
  const [plan, setPlan] = useState<VoicePlan | null>(null)
  const [warnings, setWarnings] = useState<VoiceWarning[]>([])
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null)
  const [mics, setMics] = useState<SpeechInputDevice[]>([])
  const [levels, setLevels] = useState<number[]>(SILENCE)
  const [micSilent, setMicSilent] = useState(false)
  const [heard, setHeard] = useState('')
  const [voice, setVoice] = useState(false)

  const pillRef = useRef<HTMLDivElement>(null)
  const recordingRef = useRef(false)
  const busyRef = useRef(false)
  const startingRef = useRef(false)
  const sessionRef = useRef(0)

  const recording = phase === 'listening'
  const busy = phase === 'transcribing' || phase === 'deciding'
  const runnable = plan !== null && plan.kind !== 'blocked'

  const resetForNextCommand = useCallback(() => {
    setMessage(null)
    setDecision(null)
    setPlan(null)
    setWarnings([])
    setPendingEntryId(null)
    setLevels(SILENCE)
    setMicSilent(false)
    setPhase('idle')
  }, [])

  const close = useCallback(() => {
    sessionRef.current += 1
    setOpen(false)
    resetForNextCommand()
    if (recordingRef.current) {
      recordingRef.current = false
      void speechStopCapture().catch(() => undefined)
    }
  }, [resetForNextCommand])

  const execute = useCallback(
    async (pending: VoicePlan, entryId: string | null) => {
      const prefs = useProjectsStore.getState().preferences
      const continuous =
        Boolean(prefs.voiceCommandApiKey) && prefs.dictationEnabled && prefs.voiceKeepListening
      busyRef.current = true
      if (continuous) {
        resetForNextCommand()
        setPhase('deciding')
      } else {
        close()
      }
      try {
        const actions = await runPlan(pending, t)
        if (entryId) {
          useVoiceHistoryStore.getState().settle(entryId, { status: 'ran', actions })
        }
        useUiStore.getState().pushToast({
          title: t('voice.successToastTitle'),
          body: summarize(pending, t),
        })
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        if (entryId) {
          useVoiceHistoryStore.getState().settle(entryId, { status: 'failed', error: reason })
        }
        useUiStore.getState().pushToast({ title: t('voice.failedToast'), body: reason })
      } finally {
        busyRef.current = false
        setPhase('idle')
      }
    },
    [close, resetForNextCommand, t],
  )

  const route = useCallback(
    async (spoken: string, entryId: string) => {
      const history = useVoiceHistoryStore.getState()
      const workspace = readWorkspace()
      const startedAt = performance.now()
      const session = sessionRef.current
      const answer = await withTimeout(
        jevDecide(spoken, toJevContext(workspace), apiKey),
        t('voice.error.timeout'),
      )
      const decideMs = Math.round(performance.now() - startedAt)
      if (session !== sessionRef.current) {
        history.settle(entryId, { status: 'blocked', summary: t('voice.confirm.cancel') })
        return null
      }
      const next = planFromDecision(answer, workspace)
      const nextWarnings = planWarnings(answer, next, workspace)
      const held = next.kind === 'blocked' || needsConfirmation(next, nextWarnings)
      history.settle(entryId, {
        decision: answer,
        plan: next,
        decideMs,
        warnings: nextWarnings,
        status: next.kind === 'blocked' ? 'blocked' : held ? 'waiting' : 'ran',
        summary: summarize(next, t),
      })
      if (!held) {
        await execute(next, entryId)
        return null
      }
      return { answer, next, nextWarnings, entryId }
    },
    [apiKey, execute, t],
  )

  const listen = useCallback(async () => {
    if (recordingRef.current || busyRef.current || startingRef.current) return
    const session = sessionRef.current
    startingRef.current = true
    try {
      await speechStartCapture(micId)
      if (session !== sessionRef.current) {
        await speechStopCapture().catch(() => undefined)
        return
      }
      recordingRef.current = true
      setMicSilent(false)
      setHeard('')
      setLevels(SILENCE)
      setMessage(null)
      setPhase('listening')
    } catch (cause) {
      recordingRef.current = false
      setPhase('idle')
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      startingRef.current = false
    }
  }, [micId])

  const transcribe = useCallback(() => {
    if (startingRef.current && !recordingRef.current) {
      sessionRef.current += 1
      return
    }
    if (!recordingRef.current) return
    recordingRef.current = false
    busyRef.current = true
    setPhase('transcribing')
    const session = sessionRef.current
    const history = useVoiceHistoryStore.getState()
    const entryId = history.start('', 'voice', t('voice.lifecycle.transcribing'))
    history.settle(entryId, { summary: t('voice.lifecycle.transcribing') })

    void (async () => {
      try {
        const startedAt = performance.now()
        const transcript = stripSendPhrase(
          (await stopAndTranscribe({ provider, modelId, cloudModel, apiKey })).trim(),
        )
        const transcribeMs = Math.round(performance.now() - startedAt)
        if (session !== sessionRef.current) {
          history.settle(entryId, { status: 'blocked', summary: t('voice.confirm.cancel') })
          return
        }
        if (!transcript) {
          history.settle(entryId, {
            status: 'blocked',
            summary: t('voice.lifecycle.heardNothing'),
            spoken: t('voice.history.silence'),
          })
          return
        }
        history.settle(entryId, {
          spoken: transcript,
          summary: t('voice.lifecycle.askingJev'),
          transcribeMs,
        })
        setPhase('deciding')
        const held = await route(transcript, entryId)
        if (!held) return
        setPendingEntryId(held.entryId)
        setDecision(held.answer)
        setPlan(held.next)
        setWarnings(held.nextWarnings)
      } catch (cause) {
        await speechStopCapture().catch(() => undefined)
        const reason = cause instanceof Error ? cause.message : String(cause)
        history.settle(entryId, {
          status: 'failed',
          summary: t('voice.lifecycle.failed'),
          error: reason,
        })
        useUiStore.getState().pushToast({ title: t('voice.failedToast'), body: reason })
      } finally {
        busyRef.current = false
        setPhase('idle')
      }
    })()
  }, [apiKey, cloudModel, modelId, provider, route, t])

  const toggleRecording = useCallback(() => {
    if (recordingRef.current) transcribe()
    else void listen()
  }, [listen, transcribe])

  const confirm = useCallback(() => {
    if (!plan || plan.kind === 'blocked' || busyRef.current) return
    void execute(plan, pendingEntryId)
    setPendingEntryId(null)
  }, [execute, plan, pendingEntryId])

  useEffect(() => {
    if (!open || !dictationEnabled) return
    let cancelled = false
    void speechListInputDevices()
      .then((devices) => {
        if (!cancelled) setMics(devices)
      })
      .catch(() => undefined)
    if (provider === 'local') void speechPrepare(modelId).catch(() => undefined)
    void speechPrepareVad().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, dictationEnabled, modelId, provider])

  useEffect(() => {
    if (!open || !apiKey || !dictationEnabled) return
    void listen()
  }, [open, apiKey, dictationEnabled, listen])

  // Continuous listening: re-arm the mic after each command until the bar is closed.
  useEffect(() => {
    if (
      !open ||
      !apiKey ||
      !dictationEnabled ||
      !keepListening ||
      message ||
      plan !== null ||
      phase !== 'idle'
    )
      return
    if (recordingRef.current) return
    const id = window.setInterval(() => {
      if (busyRef.current) return
      window.clearInterval(id)
      void listen()
    }, 200)
    return () => window.clearInterval(id)
  }, [open, apiKey, dictationEnabled, keepListening, message, plan, phase, listen])

  useEffect(() => {
    if (phase !== 'listening') return
    let silentPolls = 0
    const endpoint = createSpeechEndpoint()
    const id = window.setInterval(() => {
      void speechVadStatus()
        .then(async (status) => {
          const next = status ? status.level : await speechCaptureLevel()
          setLevels((previous) => [...previous.slice(1), next])
          setVoice(status?.voice ?? false)
          if (next > SILENT_LEVEL) {
            silentPolls = 0
            setMicSilent(false)
          } else {
            silentPolls += 1
            if (silentPolls > SILENT_POLLS_BEFORE_WARNING) setMicSilent(true)
          }
          const ended = status ? vadSpeechEnded(status) : endpoint.push(next, performance.now())
          if (ended) transcribe()
        })
        .catch(() => undefined)
    }, LEVEL_POLL_MS)
    return () => window.clearInterval(id)
  }, [phase, transcribe])

  // Hands-free send: a spoken send phrase ends the recording, and so does a long pause.
  useEffect(() => {
    if (phase !== 'listening' || provider !== 'local') return
    let cancelled = false
    let unsupported = false
    let pending = false
    const id = window.setInterval(() => {
      if (cancelled || unsupported || pending || !recordingRef.current || busyRef.current) return
      pending = true
      void speechTranscribePartial(modelId)
        .then((partial) => {
          if (cancelled || !recordingRef.current) return
          setHeard(partial.trim())
          if (partial && endsWithSendPhrase(partial)) transcribe()
        })
        .catch(() => {
          unsupported = true // backend without partial transcription
        })
        .finally(() => {
          pending = false
        })
    }, PARTIAL_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [phase, modelId, provider, transcribe])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isOpenChord(e) || e.repeat) return
      e.preventDefault()
      e.stopPropagation()
      if (open) close()
      else setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => pillRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'Enter' && runnable) {
        e.preventDefault()
        e.stopPropagation()
        confirm()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, close, runnable, confirm])

  useEffect(() => {
    if (!open || !dictationEnabled || !apiKey) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F9' || e.repeat) return
      e.preventDefault()
      void listen()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'F9') return
      e.preventDefault()
      transcribe()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [open, dictationEnabled, apiKey, listen, transcribe])

  useEffect(
    () => () => {
      sessionRef.current += 1
      if (!recordingRef.current) return
      recordingRef.current = false
      void speechStopCapture().catch(() => undefined)
    },
    [],
  )

  if (!open) return null

  const voiceLevel = Math.min(1, (levels[levels.length - 1] ?? 0) * 4)

  const hint = recording
    ? t('voice.bar.handsFreeHint')
    : phase === 'transcribing'
      ? t('voice.bar.transcribingHint')
      : phase === 'deciding'
        ? t('voice.bar.decidingHint')
        : runnable
          ? t('voice.bar.runnableHint')
          : !apiKey
            ? t('voice.bar.noKeyHint')
            : !dictationEnabled
              ? t('voice.bar.enableVoiceHint')
              : t('voice.bar.voiceOnlyHint')

  return (
    <div
      className={styles.anchor}
      data-phase={phase}
      data-voice={recording && voice}
      style={{ '--voice-level': recording ? voiceLevel : 0 } as CSSProperties}
    >
      <div
        className={styles.scrim}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close()
        }}
      />

      {plan ? (
        <div className={styles.card} role="alertdialog" aria-label={t('voice.bar.title')}>
          <svg className={styles.borderTrace} aria-hidden="true" focusable="false">
            <rect x="1" y="1" rx="32" pathLength="100" />
          </svg>
          <p className={runnable ? styles.summary : styles.blocked}>{summarize(plan, t)}</p>

          {plan.kind === 'reuse' && plan.prompt ? (
            <p className={styles.prompt}>{plan.prompt}</p>
          ) : null}
          {plan.kind === 'spawn'
            ? plan.jobs
                .filter((job) => job.prompt)
                .map((job, index) => (
                  <p key={`${job.agent}-${index}`} className={styles.prompt}>
                    {agentLabel(job.agent)}: {job.prompt}
                  </p>
                ))
            : null}

          {decision ? (
            <p className={styles.detail}>
              {decision.action.choice} {decision.action.confidence.toFixed(2)} |{' '}
              {t('voice.history.projectConf', {
                value: decision.project.confidence.toFixed(2),
              })}{' '}
              | {decision.latencyMs} ms | US$ {decision.costUsd.toFixed(6)}
            </p>
          ) : null}

          {warnings.map((warning) => (
            <p key={warning} className={styles.warning}>
              {t(WARNINGS[warning])}
            </p>
          ))}

          {message ? <p className={styles.blocked}>{message}</p> : null}

          <div className={styles.confirmRow}>
            {runnable ? (
              <button type="button" className={styles.confirmRun} onClick={confirm}>
                <Play size={13} aria-hidden />
                {t('voice.confirm.run')}
              </button>
            ) : null}
            <button type="button" className={styles.confirmCancel} onClick={close}>
              {t('voice.confirm.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      <div
        ref={pillRef}
        className={styles.center}
        data-phase={phase}
        role="dialog"
        tabIndex={-1}
        aria-label={t('voice.bar.title')}
      >
        {apiKey && dictationEnabled ? (
          <button
            type="button"
            className={styles.orb}
            onClick={toggleRecording}
            disabled={busy}
            aria-pressed={recording}
            aria-label={recording ? t('voice.bar.stopRecording') : t('voice.bar.startRecording')}
            title={recording ? t('voice.bar.stopRecording') : t('voice.bar.startRecordingTitle')}
          >
            <span className={styles.ring} aria-hidden="true" />
            {busy ? (
              <Loader2 size={21} strokeWidth={1.7} className={styles.spin} aria-hidden />
            ) : (
              <Mic size={21} strokeWidth={1.7} aria-hidden />
            )}
          </button>
        ) : (
          <span className={styles.orb} data-disabled="true" aria-hidden="true">
            <Mic size={21} strokeWidth={1.7} />
          </span>
        )}

        <div className={styles.captionRow}>
          <p className={styles.caption} aria-live="polite">
            {recording && micSilent
              ? t('voice.bar.micSilent')
              : recording && heard
                ? tailOf(heard)
                : hint}
          </p>

          {apiKey && dictationEnabled ? (
            <button
              type="button"
              className={`${styles.toggleButton} ${keepListening ? styles.toggleButtonOn : ''}`}
              onClick={() => setPreferences({ voiceKeepListening: !keepListening })}
              aria-pressed={keepListening}
              disabled={busy}
              aria-label={t('voice.bar.keepListening')}
              title={t('voice.bar.keepListeningTitle')}
            >
              <Repeat size={12} aria-hidden />
            </button>
          ) : null}

          {apiKey && dictationEnabled && !recording && mics.length > 1 ? (
            <Dropdown
              rootClassName={styles.micSelect}
              className={styles.micSelectTrigger}
              value={micId ?? ''}
              ariaLabel={t('voice.bar.micLabel')}
              options={[
                { value: '', label: t('voice.bar.micDefault') },
                ...mics.map((device) => ({ value: device.deviceId, label: device.label })),
              ]}
              onChange={(value) => {
                const device = mics.find((item) => item.deviceId === value)
                setPreferences({
                  dictationMicrophoneId: value || null,
                  dictationMicrophoneLabel: device?.label ?? null,
                })
              }}
            />
          ) : null}
        </div>

        {message && !plan ? (
          <p className={styles.blocked} role="alert">
            {message}
          </p>
        ) : null}
      </div>

      {recording ? (
        <div className={styles.spectrum} aria-hidden="true">
          {[...levels]
            .reverse()
            .concat(levels)
            .map((value, index) => (
              <span
                key={index}
                className={styles.spectrumBar}
                style={{ transform: `scaleY(${1 + Math.min(1, value * 4) * 11})` }}
              />
            ))}
        </div>
      ) : null}

      <div className={styles.edge} data-phase={phase} aria-hidden="true">
        <span className={styles.edgeBase} />
        <span className={styles.edgePulse} />
        <span className={styles.edgeGlow} />
        <span className={styles.edgeScan} />
      </div>
    </div>
  )
}
