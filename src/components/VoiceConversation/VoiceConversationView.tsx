import { Mic, Pause, Play, RotateCw, Square, Volume2, VolumeX, X } from 'lucide-react'
import {
  type CSSProperties,
  type HTMLAttributes,
  type Ref,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useT } from '../../lib/i18n'
import type { MessageKey } from '../../lib/i18n/messages/en'
import type { VoiceApprovalChannel } from '../../lib/types'
import { SPEECH_RATES } from '../../lib/voice/hudState'
import { answerAllowed, type PermissionAnswer } from '../../lib/voice/permissions'
import { spokenParts } from '../../lib/voice/spokenWords'
import { displayPhase, type VoicePhase } from '../../lib/voice/stateMachine'
import type { VoiceTarget } from '../../lib/voice/target'
import type { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { Dropdown } from '../ui/Dropdown'
import { VoiceSpectrum } from '../VoiceSpectrum'
import styles from './VoiceConversation.module.css'

export type VoiceConversationViewState = Omit<
  ReturnType<typeof useVoiceConversationStore.getState>,
  | 'patch'
  | 'voiceHookedPtyIds'
  | 'lastAgentPtyId'
  | 'hudDismissed'
  | 'idleSince'
  | 'shortcutRecording'
>

export type VoiceConversationAction =
  | { kind: 'answer'; answer: PermissionAnswer; requestId: string }
  | { kind: 'pin'; ptyId: string | null }
  /** Discards the rest of the narration. */
  | { kind: 'stop-speaking' }
  | { kind: 'toggle-mute' }
  | { kind: 'toggle-pause' }
  | { kind: 'dismiss' }
  | { kind: 'rate'; rate: number }
  /** Relaunches a session that has no voice hooks, resuming its conversation, so it gets them. */
  | { kind: 'restart-session'; ptyId: string }

/** The picker value for "no pin": voice follows the active pane. */
const FOLLOW_ACTIVE = ''
/** Picker values of a session without voice hooks, and of the restart offered under it. */
const STALE = 'stale:'
const RESTART = 'restart:'

const PHASE_LABEL: Record<VoicePhase, MessageKey> = {
  idle: 'voice.conv.phase.idle',
  listening: 'voice.conv.phase.listening',
  transcribing: 'voice.conv.phase.transcribing',
  sending: 'voice.conv.phase.sending',
  working: 'voice.conv.phase.working',
  'awaiting-permission': 'voice.conv.phase.awaitingPermission',
}

/** Pure view: everything comes in as props, so phase 2 can mount it in the HUD window. */
export function VoiceConversationView({
  state,
  targets,
  restartable = [],
  current = null,
  hint,
  approvalChannel,
  destructiveNeedsHud,
  rate,
  embedded = false,
  reducedMotion = false,
  drag,
  sectionRef,
  style,
  onAction,
}: {
  state: VoiceConversationViewState
  targets: VoiceTarget[]
  /** Running sessions launched without the voice hooks: listed, not pickable, with a restart. */
  restartable?: VoiceTarget[]
  /** The session the next utterance goes to: the pinned one, else the one the active pane gives. */
  current?: VoiceTarget | null
  hint: string
  approvalChannel: VoiceApprovalChannel
  destructiveNeedsHud: boolean
  rate: number
  /** Fills its window instead of floating over the app (the HUD window). */
  embedded?: boolean
  /** The app's reduced-motion preference; the OS one is honored by the stylesheet. */
  reducedMotion?: boolean
  /** Pointer handlers of a drag strip along the top (the in-app panel; the HUD has its own). */
  drag?: HTMLAttributes<HTMLDivElement>
  sectionRef?: Ref<HTMLElement>
  /** Where the in-app panel was dragged; the stylesheet's bottom center without it. */
  style?: CSSProperties
  onAction: (action: VoiceConversationAction) => void
}) {
  const t = useT()
  const [micSilent, setMicSilent] = useState(false)
  const phase = displayPhase(state.capture, state.turn)
  // The HUD window stays open while the main window shows it, so it never renders blank. The
  // in-app panel leaves with the turn: the last narration alone does not keep it (a paused
  // narration keeps the turn, and so the panel, going). Narration still speaking does, so a
  // selection read aloud outside a turn shows with its controls.
  const visible =
    embedded ||
    phase !== 'idle' ||
    state.notice ||
    state.transcript ||
    state.permission ||
    state.narrationActive
  if (!visible) return null
  const muteLabel = t(state.muted ? 'voice.conv.unmute' : 'voice.conv.mute')
  const pauseLabel = t(state.narrationPaused ? 'voice.conv.resume' : 'voice.conv.pause')

  const followLabel = t('voice.conv.followActive')
  const shownTarget = current?.label ?? followLabel
  const pinned = targets.find((item) => item.ptyId === state.pinnedPtyId)
  const card = state.permission
  const guarded = Boolean(card?.destructive && destructiveNeedsHud)
  const showButtons = card
    ? answerAllowed(
        { kind: 'allow' },
        card.destructive,
        { channel: approvalChannel, destructiveNeedsHud },
        'hud',
      )
    : false

  return (
    <section
      ref={sectionRef}
      className={`${styles.dock} ${embedded ? styles.embedded : ''} ${drag ? styles.draggable : ''}`}
      style={style}
      aria-live="polite"
      aria-label={t('voice.conv.title')}
    >
      {drag ? (
        <div
          className={styles.dragStrip}
          aria-label={t('voice.hud.drag')}
          title={t('voice.hud.drag')}
          {...drag}
        />
      ) : null}
      <header className={styles.header}>
        <Mic size={14} aria-hidden className={styles.icon} data-phase={phase} />
        <span className={styles.phase}>{t(PHASE_LABEL[phase])}</span>
        {/* Not searchable: the HUD window never takes keyboard focus. */}
        <Dropdown
          rootClassName={styles.target}
          value={pinned ? pinned.ptyId : FOLLOW_ACTIVE}
          displayValue={shownTarget}
          ariaLabel={t('voice.conv.target')}
          title={shownTarget}
          options={[
            { value: FOLLOW_ACTIVE, label: followLabel },
            ...targets.map((item) => ({ value: item.ptyId, label: item.label })),
            ...restartable.flatMap((item) => [
              {
                value: `${STALE}${item.ptyId}`,
                disabled: true,
                label: (
                  <span className={styles.staleOption}>
                    <span className={styles.staleLabel}>{item.label}</span>
                    <span className={styles.staleHint}>{t('voice.conv.needsRestart')}</span>
                  </span>
                ),
              },
              {
                value: `${RESTART}${item.ptyId}`,
                label: (
                  <span className={styles.restartOption}>
                    <RotateCw size={12} aria-hidden />
                    {t('voice.conv.restartSession')}
                  </span>
                ),
              },
            ]),
          ]}
          onChange={(value) => {
            if (value.startsWith(RESTART)) {
              onAction({ kind: 'restart-session', ptyId: value.slice(RESTART.length) })
            } else if (!value.startsWith(STALE)) {
              onAction({ kind: 'pin', ptyId: value || null })
            }
          }}
        />
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onAction({ kind: 'dismiss' })}
          aria-label={t('voice.conv.close')}
          title={t('voice.conv.close')}
        >
          <X size={14} aria-hidden />
        </button>
      </header>

      <div className={styles.playback}>
        <div className={styles.rates} role="group" aria-label={t('voice.conv.rate')}>
          {SPEECH_RATES.map((step) => (
            <button
              key={step}
              type="button"
              className={styles.rateButton}
              aria-pressed={rate === step}
              onClick={() => onAction({ kind: 'rate', rate: step })}
            >
              {t('voice.conv.rateValue', { rate: step })}
            </button>
          ))}
        </div>
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.iconButton}
            data-active={state.muted}
            onClick={() => onAction({ kind: 'toggle-mute' })}
            aria-label={muteLabel}
            title={muteLabel}
          >
            {state.muted ? <VolumeX size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            data-active={state.narrationPaused}
            // Resume stays reachable; a pause needs narration to hold.
            disabled={!state.narrationPaused && !state.narrationActive}
            onClick={() => onAction({ kind: 'toggle-pause' })}
            aria-label={pauseLabel}
            title={pauseLabel}
          >
            {state.narrationPaused ? (
              <Play size={14} aria-hidden />
            ) : (
              <Pause size={14} aria-hidden />
            )}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onAction({ kind: 'stop-speaking' })}
            aria-label={t('voice.conv.stopSpeaking')}
            title={t('voice.conv.stopSpeaking')}
          >
            <Square size={14} aria-hidden />
          </button>
        </div>
      </div>

      <VoiceSpectrum live={state.capture === 'listening'} onSilent={setMicSilent} />
      {state.capture === 'listening' && micSilent ? (
        <p className={styles.notice}>{t('voice.bar.micSilent')}</p>
      ) : null}

      {state.transcript ? <p className={styles.transcript}>{state.transcript}</p> : null}
      {state.narration ? (
        <NarrationText
          text={state.narration}
          offset={state.narrationSpokenOffset}
          reducedMotion={reducedMotion}
        />
      ) : null}

      {card ? (
        <div className={styles.card} data-destructive={card.destructive}>
          <p className={styles.cardTool}>{card.tool}</p>
          <p className={styles.cardSubject}>{card.subject}</p>
          {guarded ? (
            <p className={styles.cardWarning}>{t('voice.conv.permissionDestructive')}</p>
          ) : null}
          <div className={styles.cardActions}>
            {showButtons ? (
              <>
                <button
                  type="button"
                  className={styles.allow}
                  onClick={() =>
                    onAction({
                      kind: 'answer',
                      answer: { kind: 'allow' },
                      requestId: card.requestId,
                    })
                  }
                >
                  {t('voice.conv.allow')}
                </button>
                <button
                  type="button"
                  className={styles.deny}
                  onClick={() =>
                    onAction({
                      kind: 'answer',
                      answer: { kind: 'deny' },
                      requestId: card.requestId,
                    })
                  }
                >
                  {t('voice.conv.deny')}
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={styles.defer}
              onClick={() =>
                onAction({ kind: 'answer', answer: { kind: 'defer' }, requestId: card.requestId })
              }
            >
              {t('voice.conv.answerInTerminal')}
            </button>
          </div>
        </div>
      ) : null}

      {state.notice ? (
        <p className={styles.notice}>{t(state.notice.key, state.notice.params)}</p>
      ) : null}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </section>
  )
}

/**
 * The narration with what was already said, the word being said and what is still to come told
 * apart; the box scrolls to keep that word in view. Plain text without an offset.
 */
function NarrationText({
  text,
  offset,
  reducedMotion,
}: {
  text: string
  offset: number | null
  reducedMotion: boolean
}) {
  const parts = useMemo(() => spokenParts(text, offset), [text, offset])
  const boxRef = useRef<HTMLParagraphElement>(null)
  const wordRef = useRef<HTMLSpanElement>(null)
  const spokenLength = parts?.spoken.length ?? 0

  useLayoutEffect(() => {
    const box = boxRef.current
    const word = wordRef.current
    if (!box || !word) return
    // The box is the word's offset parent (positioned), so these are box coordinates.
    const top = word.offsetTop
    const bottom = top + word.offsetHeight
    if (top < box.scrollTop) box.scrollTop = top
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight
  }, [spokenLength, text])

  if (!parts) return <p className={styles.narration}>{text}</p>
  return (
    <p
      ref={boxRef}
      className={`${styles.narration} ${styles.highlighted}`}
      data-highlight="true"
      data-motion={reducedMotion ? 'reduced' : undefined}
    >
      {parts.spoken ? (
        <span data-part="spoken" className={styles.spoken}>
          {parts.spoken}
        </span>
      ) : null}
      {parts.current ? (
        // Keyed by position, so each new word fades its glow in.
        <span key={spokenLength} ref={wordRef} data-part="current" className={styles.currentWord}>
          {parts.current}
        </span>
      ) : null}
      {parts.upcoming ? <span data-part="upcoming">{parts.upcoming}</span> : null}
    </p>
  )
}
