import { Loader2, Mic, Play, Repeat } from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agentInputFor, waitForAgentInput } from '../../lib/agentInputRegistry'
import { PaneHiddenError, TerminalPromptOpenError } from '../../lib/agentPromptDelivery'
import { agentLabel } from '../../lib/agentProviders'
import { type TFunction, useT } from '../../lib/i18n'
import { isMacOS } from '../../lib/platform'
import { openCapture, transcribeCapture, transcriptionFailureText } from '../../lib/speech/capture'
import { createSpeechEndpoint, vadSpeechEnded } from '../../lib/speech/endpoint'
import { sttChoiceFor } from '../../lib/speech/engine'
import { isSpeechTooShort } from '../../lib/speech/errors'
import {
  jevDecide,
  type JevDecision,
  speechCaptureLevel,
  type SpeechInputDevice,
  speechListInputDevices,
  speechPrepare,
  speechPrepareVad,
  speechStopCapture,
  speechTranscribePartial,
  speechVadStatus,
  writePty,
} from '../../lib/tauri'
import { type AgentType, isShellAgentType } from '../../lib/types'
import { isJevKeyConfigured, migrateLegacyJevKey } from '../../lib/voice/jevKey'
import { acceleratorLabel, matchesAccelerator, parseAccelerator } from '../../lib/voice/shortcut'
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
import { isRecordingShortcut } from '../../stores/voiceConversationStore'
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
  const conversationEnabled = useProjectsStore((s) => s.preferences.voiceConversationEnabled)
  const keepListening = useProjectsStore((s) => s.preferences.voiceKeepListening)
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const engine = useMemo(() => sttChoiceFor({ voiceStt }, 'conversation'), [voiceStt])
  const micId = useProjectsStore((s) => s.preferences.dictationMicrophoneId)
  const conversationShortcut = useProjectsStore((s) => s.preferences.voiceShortcut)
  const commandShortcut = useProjectsStore((s) => s.preferences.voiceCommandShortcut)
  // Either voice feature means the mic and an engine are set up; the bar uses the conversation one.
  const voiceEnabled = dictationEnabled || conversationEnabled
  const voiceInput = keyReady && voiceEnabled
  const voiceCommandRequest = useUiStore((s) => s.voiceCommandRequest)
  const handledNonce = useRef<number | null>(null)

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
        isJevKeyConfigured(prefs.voiceProviders) &&
        (prefs.dictationEnabled || prefs.voiceConversationEnabled) &&
        prefs.voiceKeepListening
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
        jevDecide(spoken, toJevContext(workspace)),
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
    if (voiceCommandRequest.text) void decide(voiceCommandRequest.text)
  }, [voiceCommandRequest, decide])

  const listen = useCallback(async () => {
    if (recordingRef.current || busyRef.current || startingRef.current) return
    const session = sessionRef.current
    startingRef.current = true
    try {
      const block = await openCapture(engine, micId, {
        cancelled: () => session !== sessionRef.current,
      })
      if (block) {
        if (block !== 'cancelled') setMessage(t(block))
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
  }, [engine, micId, t])

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
        const transcript = stripSendPhrase(await transcribeCapture(engine, 'conversation'))
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
      } finally {
        busyRef.current = false
        setPhase('idle')
      }
    })()
  }, [engine, route, t])

  const toggleRecording = useCallback(() => {
    if (recordingRef.current) transcribe()
    else void listen()
  }, [listen, transcribe])

  // Older versions kept the key in plaintext preferences; it moves to the keychain once.
  useEffect(() => {
    if (legacyKey) void migrateLegacyJevKey().catch(() => undefined)
  }, [legacyKey])

  const confirm = useCallback(() => {
    if (!plan || plan.kind === 'blocked' || busyRef.current) return
    void execute(plan, pendingEntryId)
    setPendingEntryId(null)
  }, [execute, plan, pendingEntryId])

  useEffect(() => {
    if (!open || !voiceEnabled) return
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
    void speechPrepareVad().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, voiceEnabled, engine])

  useEffect(() => {
    if (!open || !voiceInput) return
    void listen()
  }, [open, voiceInput, listen])

  // Continuous listening: re-arm the mic after each command until the bar is closed.
  useEffect(() => {
    if (!open || !voiceInput || !keepListening || message || plan !== null || phase !== 'idle')
      return
    if (recordingRef.current) return
    const id = window.setInterval(() => {
      if (busyRef.current) return
      window.clearInterval(id)
      void listen()
    }, 200)
    return () => window.clearInterval(id)
  }, [open, voiceInput, keepListening, message, plan, phase, listen])

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
    if (phase !== 'listening' || engine.provider !== 'local') return
    let cancelled = false
    let unsupported = false
    let pending = false
    const id = window.setInterval(() => {
      if (cancelled || unsupported || pending || !recordingRef.current || busyRef.current) return
      pending = true
      void speechTranscribePartial(engine.modelId)
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
  }, [phase, engine, transcribe])

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
        if (open) close()
        else setOpen(true)
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
  }, [close, commandShortcut, conversationEnabled, conversationShortcut, open, t])

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
          : !keyReady
            ? t('voice.bar.noKeyHint')
            : !voiceEnabled
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
        {voiceInput ? (
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

          {voiceInput ? (
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

          {voiceInput && !recording && mics.length > 1 ? (
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
