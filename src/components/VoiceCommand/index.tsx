import { Loader2, Mic, Play, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agentInputFor, waitForAgentInput } from '../../lib/agentInputRegistry'
import { PaneHiddenError, TerminalPromptOpenError } from '../../lib/agentPromptDelivery'
import { agentLabel } from '../../lib/agentProviders'
import { type TFunction, useT } from '../../lib/i18n'
import { isMacOS } from '../../lib/platform'
import {
  CaptureGate,
  openCapture,
  transcribeCapture,
  transcriptionFailureText,
} from '../../lib/speech/capture'
import { sttChoiceFor } from '../../lib/speech/engine'
import { isSpeechTooShort } from '../../lib/speech/errors'
import {
  jevDecide,
  type JevDecision,
  type SpeechInputDevice,
  speechListInputDevices,
  speechPrepare,
  speechStopCapture,
  writePty,
} from '../../lib/tauri'
import { type AgentType, isShellAgentType } from '../../lib/types'
import { isJevKeyConfigured, migrateLegacyJevKey, saveJevKey } from '../../lib/voice/jevKey'
import { acceleratorLabel, matchesAccelerator, parseAccelerator } from '../../lib/voice/shortcut'
import {
  BLOCK_REASONS,
  needsConfirmation,
  planFromDecision,
  planWarnings,
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
import { isRecordingShortcut } from '../../stores/voiceConversationStore'
import { useVoiceHistoryStore } from '../../stores/voiceHistoryStore'
import { Dropdown } from '../ui/Dropdown'
import { VoiceSpectrum } from '../VoiceSpectrum'
import styles from './VoiceCommand.module.css'

const DECIDE_TIMEOUT_MS = 20000

function withTimeout<T>(work: Promise<T>, timeoutMessage: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      window.setTimeout(() => reject(new Error(timeoutMessage)), DECIDE_TIMEOUT_MS),
    ),
  ])
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
}

/** Why the pane refused a submit, as the person reads it; null for any other failure. */
function refusalText(cause: unknown, t: TFunction): string | null {
  if (cause instanceof TerminalPromptOpenError) return t('voice.conv.terminalPromptOpen')
  if (cause instanceof PaneHiddenError) return t('voice.bar.paneHidden')
  return null
}

/**
 * Types a prompt into an agent through its pane's guarded submit: bracketed paste, the completion
 * monitor, and a refusal while the agent's own approval menu is open, where an Enter approves.
 * Resolves to the refusal text, or null once sent.
 */
async function submitToAgent(ptyId: string, prompt: string, t: TFunction): Promise<string | null> {
  let input = agentInputFor(ptyId) ?? (await waitForAgentInput(ptyId))
  for (let attempt = 0; input; attempt++) {
    try {
      await input.submit(prompt)
      return null
    } catch (cause) {
      const refusal = refusalText(cause, t)
      if (refusal === null) throw cause
      // Just brought to front: the pane reports itself visible once it renders. Once only.
      if (!(cause instanceof PaneHiddenError) || attempt > 0) return refusal
      input = await waitForAgentInput(ptyId)
    }
  }
  return t('voice.bar.paneHidden')
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
    // Focused first: a hidden pane has no live screen for the approval-menu guard to read.
    focusTerminal(plan.projectId, plan.terminalId)
    if (isShellAgentType(plan.agent)) await writePty(plan.ptyId, `${plan.prompt}\r`)
    else {
      const refusal = await submitToAgent(plan.ptyId, plan.prompt, t)
      if (refusal) throw new Error(refusal)
    }
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
  const keyReady = useProjectsStore((s) => isJevKeyConfigured(s.preferences.voiceProviders))
  const legacyKey = useProjectsStore((s) => s.preferences.voiceCommandApiKey)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const dictationEnabled = useProjectsStore((s) => s.preferences.dictationEnabled)
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const engine = useMemo(() => sttChoiceFor({ voiceStt }, 'conversation'), [voiceStt])
  const micId = useProjectsStore((s) => s.preferences.dictationMicrophoneId)
  const conversationEnabled = useProjectsStore((s) => s.preferences.voiceConversationEnabled)
  const conversationShortcut = useProjectsStore((s) => s.preferences.voiceShortcut)
  const commandShortcut = useProjectsStore((s) => s.preferences.voiceCommandShortcut)
  // Either voice feature means the mic and an engine are set up; the bar uses the conversation one.
  const voiceInput = keyReady && (dictationEnabled || conversationEnabled)
  const voiceCommandRequest = useUiStore((s) => s.voiceCommandRequest)
  const handledNonce = useRef<number | null>(null)

  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'idle' | 'listening' | 'transcribing' | 'deciding'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [decision, setDecision] = useState<JevDecision | null>(null)
  const [plan, setPlan] = useState<VoicePlan | null>(null)
  const [warnings, setWarnings] = useState<VoiceWarning[]>([])
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null)
  const [mics, setMics] = useState<SpeechInputDevice[]>([])
  const [micSilent, setMicSilent] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  const gateRef = useRef(new CaptureGate())
  const busyRef = useRef(false)
  const transcribeRef = useRef<() => void>(() => undefined)

  const recording = phase === 'listening'
  const busy = phase === 'transcribing' || phase === 'deciding'
  const runnable = plan !== null && plan.kind !== 'blocked'

  const close = useCallback(() => {
    setOpen(false)
    setText('')
    setMessage(null)
    setDecision(null)
    setPlan(null)
    setWarnings([])
    setPendingEntryId(null)
    setMicSilent(false)
    setKeyDraft('')
    setPhase('idle')
    if (gateRef.current.abandon()) void speechStopCapture().catch(() => undefined)
  }, [])

  const execute = useCallback(
    async (pending: VoicePlan, entryId: string | null) => {
      close()
      try {
        const actions = await runPlan(pending, t)
        if (entryId) {
          useVoiceHistoryStore.getState().settle(entryId, { status: 'ran', actions })
        }
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        if (entryId) {
          useVoiceHistoryStore.getState().settle(entryId, { status: 'failed', error: reason })
        }
        useUiStore.getState().pushToast({ title: t('voice.failedToast'), body: reason })
      }
    },
    [close, t],
  )

  const route = useCallback(
    async (spoken: string, entryId: string) => {
      const history = useVoiceHistoryStore.getState()
      const workspace = readWorkspace()
      const startedAt = performance.now()
      const answer = await withTimeout(
        jevDecide(spoken, toJevContext(workspace)),
        t('voice.error.timeout'),
      )
      const decideMs = Math.round(performance.now() - startedAt)
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
        void execute(next, entryId)
        return null
      }
      return { answer, next, nextWarnings, entryId }
    },
    [execute, t],
  )

  const decide = useCallback(
    async (spoken: string) => {
      const trimmed = spoken.trim()
      if (!trimmed) {
        setMessage(t('voice.bar.nothingToDecide'))
        return
      }
      if (busyRef.current) {
        setMessage(t('voice.bar.busy'))
        return
      }
      busyRef.current = true
      setPhase('deciding')
      setMessage(null)
      const history = useVoiceHistoryStore.getState()
      const entryId = history.start(trimmed, 'typed', t('voice.lifecycle.askingJev'))
      try {
        const held = await route(trimmed, entryId)
        if (!held) return
        setPendingEntryId(held.entryId)
        setDecision(held.answer)
        setPlan(held.next)
        setWarnings(held.nextWarnings)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        history.settle(entryId, {
          status: 'failed',
          summary: t('voice.lifecycle.failed'),
          error: reason,
        })
        setMessage(reason)
      } finally {
        busyRef.current = false
        setPhase('idle')
      }
    },
    [route, t],
  )

  // Voice conversation hands Jev requests over here (trigger word or modifier).
  useEffect(() => {
    if (!voiceCommandRequest || handledNonce.current === voiceCommandRequest.nonce) return
    handledNonce.current = voiceCommandRequest.nonce
    setOpen(true)
    setText(voiceCommandRequest.text)
    if (voiceCommandRequest.text) void decide(voiceCommandRequest.text)
  }, [voiceCommandRequest, decide])

  const listen = useCallback(async () => {
    if (gateRef.current.active || busyRef.current) return
    try {
      await gateRef.current.start(
        async () => {
          const block = await openCapture(engine, micId)
          if (block) {
            if (block !== 'cancelled') setMessage(t(block))
            return false
          }
          setMicSilent(false)
          setMessage(null)
          setPhase('listening')
          return true
        },
        () => transcribeRef.current(),
      )
    } catch (cause) {
      setPhase('idle')
      setMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }, [engine, micId, t])

  const transcribe = useCallback(() => {
    if (!gateRef.current.takeStop()) return
    const history = useVoiceHistoryStore.getState()
    const entryId = history.start('', 'voice', t('voice.lifecycle.transcribing'))
    history.settle(entryId, { summary: t('voice.lifecycle.transcribing') })
    useUiStore.getState().setRightSidebarMode('jev')
    close()

    void (async () => {
      try {
        const startedAt = performance.now()
        const transcript = await transcribeCapture(engine, 'conversation')
        const transcribeMs = Math.round(performance.now() - startedAt)
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
        const held = await route(transcript, entryId)
        if (!held) return
        setPendingEntryId(held.entryId)
        setText(transcript)
        setDecision(held.answer)
        setPlan(held.next)
        setWarnings(held.nextWarnings)
        setOpen(true)
      } catch (cause) {
        // A tap too short to record is not a failure: a hint, no failed entry, no toast.
        if (isSpeechTooShort(cause)) {
          history.settle(entryId, { status: 'blocked', summary: t('dictation.tooShort') })
          return
        }
        const reason = transcriptionFailureText(cause, engine.provider, t)
        history.settle(entryId, {
          status: 'failed',
          summary: t('voice.lifecycle.failed'),
          error: reason,
        })
        useUiStore.getState().pushToast({ title: t('voice.failedToast'), body: reason })
      }
    })()
  }, [close, engine, route, t])

  useEffect(() => {
    transcribeRef.current = transcribe
  }, [transcribe])

  const toggleRecording = useCallback(() => {
    if (gateRef.current.active) transcribe()
    else void listen()
  }, [listen, transcribe])

  const saveKey = useCallback(async () => {
    const draft = keyDraft.trim()
    if (!draft) return
    setMessage(null)
    try {
      await saveJevKey(draft)
      setKeyDraft('')
    } catch {
      setMessage(t('prefs.voiceKeyRejected'))
    }
  }, [keyDraft, t])

  // Older versions kept the key in plaintext preferences; it moves to the keychain once.
  useEffect(() => {
    if (legacyKey) void migrateLegacyJevKey().catch(() => undefined)
  }, [legacyKey])

  const confirm = useCallback(() => {
    if (!plan || plan.kind === 'blocked') return
    void execute(plan, pendingEntryId)
    setPendingEntryId(null)
  }, [execute, plan, pendingEntryId])

  useEffect(() => {
    if (!open || !(dictationEnabled || conversationEnabled)) return
    let cancelled = false
    void speechListInputDevices()
      .then((devices) => {
        if (!cancelled) setMics(devices)
      })
      .catch(() => undefined)
    // Apple's prepare asks for the speech permission, which a typed request never needs; listen()
    // prepares it right before capture instead.
    if (engine.provider === 'local')
      void speechPrepare(engine.modelId, engine.locale, engine.provider).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, dictationEnabled, conversationEnabled, engine])

  useEffect(() => {
    const own = parseAccelerator(commandShortcut)
    const conversation = parseAccelerator(conversationShortcut)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || isRecordingShortcut()) return
      const mac = isMacOS()
      const isConversationChord = !!conversation && matchesAccelerator(e, conversation, mac).matched
      if (own && matchesAccelerator(e, own, mac).matched) {
        // Voice conversation keeps its chord while it is on, should both ever be the same.
        if (conversationEnabled && isConversationChord) return
        e.preventDefault()
        e.stopPropagation()
        setOpen((current) => !current)
        return
      }
      // While off, the conversation chord would otherwise do nothing at all: say why.
      if (!conversationEnabled && isConversationChord) {
        e.preventDefault()
        e.stopPropagation()
        useUiStore.getState().pushToast({
          title: t('voice.conv.offTitle'),
          body: t('voice.conv.offBody', { shortcut: acceleratorLabel(commandShortcut) }),
        })
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [commandShortcut, conversationEnabled, conversationShortcut, t])

  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  useEffect(() => {
    if (!open || !voiceInput) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F9' || e.repeat || isRecordingShortcut()) return
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
  }, [open, voiceInput, listen, transcribe])

  useEffect(
    () => () => {
      if (gateRef.current.abandon()) void speechStopCapture().catch(() => undefined)
    },
    [],
  )

  if (!open) return null

  const hint = recording
    ? t('voice.bar.stopHint')
    : phase === 'transcribing'
      ? t('voice.bar.transcribingHint')
      : phase === 'deciding'
        ? t('voice.bar.decidingHint')
        : runnable
          ? t('voice.bar.runnableHint')
          : keyReady
            ? t('voice.bar.idleHint')
            : t('voice.bar.noKeyHint')

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className={styles.panel} role="dialog" aria-label={t('voice.bar.title')}>
        <div className={styles.inputRow}>
          {voiceInput ? (
            <button
              type="button"
              className={`${styles.micButton} ${recording ? styles.micButtonLive : ''}`}
              onClick={toggleRecording}
              disabled={busy}
              aria-pressed={recording}
              aria-label={recording ? t('voice.bar.stopRecording') : t('voice.bar.startRecording')}
              title={recording ? t('voice.bar.stopRecording') : t('voice.bar.startRecordingTitle')}
            >
              {busy ? (
                <Loader2 size={17} className={styles.spin} aria-hidden />
              ) : recording ? (
                <Square size={15} aria-hidden />
              ) : (
                <Mic size={17} aria-hidden />
              )}
            </button>
          ) : null}

          <input
            ref={inputRef}
            className={styles.input}
            type={keyReady ? 'text' : 'password'}
            value={keyReady ? text : keyDraft}
            spellCheck={false}
            placeholder={
              keyReady
                ? recording
                  ? t('voice.bar.listeningPlaceholder')
                  : t('voice.bar.speakPlaceholder')
                : t('voice.bar.keyPlaceholder')
            }
            aria-label={keyReady ? t('voice.bar.inputLabel') : t('voice.bar.keyInputLabel')}
            onChange={(event) => {
              if (!keyReady) {
                setKeyDraft(event.target.value)
                return
              }
              setText(event.target.value)
              setDecision(null)
              setPlan(null)
              setWarnings([])
              setPendingEntryId(null)
              setMessage(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (!keyReady) void saveKey()
              else if (runnable) confirm()
              else void decide(text)
            }}
          />
        </div>

        {voiceInput ? (
          <div className={styles.spectrumRow}>
            <VoiceSpectrum live={recording} onSilent={setMicSilent} />
            {mics.length > 1 ? (
              <Dropdown
                rootClassName={styles.micSelect}
                className={styles.micSelectTrigger}
                value={micId ?? ''}
                disabled={recording}
                ariaLabel={t('voice.bar.micLabel')}
                options={[
                  { value: '', label: t('voice.bar.micDefault') },
                  ...mics.map((device) => ({
                    value: device.deviceId,
                    label: device.label,
                  })),
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
        ) : null}

        {recording && micSilent ? (
          <p className={styles.warning}>{t('voice.bar.micSilent')}</p>
        ) : null}

        {plan ? (
          <p className={runnable ? styles.summary : styles.blocked}>{summarize(plan, t)}</p>
        ) : message ? (
          <p className={styles.blocked}>{message}</p>
        ) : null}

        {plan?.kind === 'reuse' && plan.prompt ? (
          <p className={styles.prompt}>{plan.prompt}</p>
        ) : null}
        {plan?.kind === 'spawn'
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

        {runnable ? (
          <div className={styles.confirmRow}>
            <button type="button" className={styles.confirmRun} onClick={confirm}>
              <Play size={13} aria-hidden />
              {t('voice.confirm.run')}
            </button>
            <button type="button" className={styles.confirmCancel} onClick={close}>
              {t('voice.confirm.cancel')}
            </button>
          </div>
        ) : null}

        <p className={styles.hint}>{hint}</p>
      </div>
    </div>
  )
}
