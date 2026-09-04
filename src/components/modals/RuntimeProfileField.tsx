import { useT } from '../../lib/i18n'
import type { AgentRuntimeProfile, AgentType } from '../../lib/types'
import controls from './controls.module.css'

const RUNTIME_PROFILES: AgentRuntimeProfile[] = ['full', 'lean', 'diagnostic']

type RuntimeProfileFieldProps = {
  agentType: AgentType
  value: AgentRuntimeProfile
  onChange: (profile: AgentRuntimeProfile) => void
  showOpenCodeNote?: boolean
}

export function RuntimeProfileField({
  agentType,
  value,
  onChange,
  showOpenCodeNote = false,
}: RuntimeProfileFieldProps) {
  const t = useT()

  if (agentType === 'shell') return null

  return (
    <div className={controls.field}>
      <label className={controls.label}>{t('term.runtimeProfile')}</label>
      <div className={controls.pillRow}>
        {RUNTIME_PROFILES.map((profile) => (
          <button
            key={profile}
            type="button"
            className={`${controls.pill} ${value === profile ? controls.pillActive : ''}`}
            onClick={() => onChange(profile)}
            title={t(`term.runtimeProfile.${profile}.desc`)}
          >
            {t(`term.runtimeProfile.${profile}`)}
          </button>
        ))}
      </div>
      <span className={controls.hint}>
        {showOpenCodeNote && agentType === 'opencode'
          ? t('term.runtimeProfile.opencodeNote')
          : t(`term.runtimeProfile.${value}.desc`)}
      </span>
    </div>
  )
}
