import { Mic, VolumeX, X } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../lib/i18n'
import type { MessageKey } from '../../lib/i18n/messages/en'
import type { VoiceApprovalChannel } from '../../lib/types'
import { SPEECH_RATES } from '../../lib/voice/hudState'
import { answerAllowed, type PermissionAnswer } from '../../lib/voice/permissions'
import { displayPhase, type VoicePhase } from '../../lib/voice/stateMachine'
import type { VoiceTarget } from '../../lib/voice/target'
import type { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { Dropdown } from '../ui/Dropdown'
import { VoiceSpectrum } from '../VoiceSpectrum'
import styles from './VoiceConversation.module.css'

export type VoiceConversationViewState = Omit<
  ReturnType<typeof useVoiceConversationStore.getState>,
  'patch' | 'voiceHookedPtyIds' | 'hudDismissed' | 'idleSince' | 'shortcutRecording'
>

export type VoiceConversationAction =
  | { kind: 'answer'; answer: PermissionAnswer; requestId: string }
  | { kind: 'pin'; ptyId: string | null }
  | { kind: 'stop-speaking' }
  | { kind: 'dismiss' }
  | { kind: 'rate'; rate: number }

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
  hint,
  approvalChannel,
  destructiveNeedsHud,
  rate,
  embedded = false,
  onAction,
}: {
  state: VoiceConversationViewState
  targets: VoiceTarget[]
  hint: string
  approvalChannel: VoiceApprovalChannel
  destructiveNeedsHud: boolean
  rate: number
  /** Fills its window instead of floating over the app (the HUD window). */
  embedded?: boolean
  onAction: (action: VoiceConversationAction) => void
}) {
  const t = useT()
  const [micSilent, setMicSilent] = useState(false)
  const phase = displayPhase(state.capture, state.turn)
  const visible = phase !== 'idle' || state.notice || state.transcript || state.permission
  if (!visible) return null

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
      className={`${styles.dock} ${embedded ? styles.embedded : ''}`}
      aria-live="polite"
      aria-label={t('voice.conv.title')}
    >
      <header className={styles.header}>
        <Mic size={14} aria-hidden className={styles.icon} data-phase={phase} />
        <span className={styles.phase}>{t(PHASE_LABEL[phase])}</span>
        {targets.length > 1 ? (
          <Dropdown
            rootClassName={styles.target}
            value={state.target?.ptyId ?? state.pinnedPtyId ?? ''}
            ariaLabel={t('voice.conv.target')}
            options={targets.map((item) => ({ value: item.ptyId, label: item.label }))}
            onChange={(value) => onAction({ kind: 'pin', ptyId: value || null })}
          />
        ) : state.target ? (
          <span className={styles.targetLabel}>{state.target.label}</span>
        ) : null}
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onAction({ kind: 'stop-speaking' })}
          aria-label={t('voice.conv.stopSpeaking')}
          title={t('voice.conv.stopSpeaking')}
        >
          <VolumeX size={14} aria-hidden />
        </button>
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

      <VoiceSpectrum live={state.capture === 'listening'} onSilent={setMicSilent} />
      {state.capture === 'listening' && micSilent ? (
        <p className={styles.notice}>{t('voice.bar.micSilent')}</p>
      ) : null}

      {state.transcript ? <p className={styles.transcript}>{state.transcript}</p> : null}
      {state.narration ? <p className={styles.narration}>{state.narration}</p> : null}

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
