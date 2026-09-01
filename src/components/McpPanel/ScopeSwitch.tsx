import { useT } from '../../lib/i18n'
import type { McpScope } from '../../lib/types'
import styles from './McpPanel.module.css'

type Props = {
  value: McpScope
  projectAvailable: boolean
  onChange: (scope: McpScope) => void
}

/** Project comes first: it is the scope tied to what the user is looking at right now. */
export function ScopeSwitch({ value, projectAvailable, onChange }: Props) {
  const t = useT()
  return (
    <span className={styles.scopeToggle} role="group" aria-label={t('mcp.scopeLabel')}>
      <button
        type="button"
        aria-pressed={value === 'project'}
        disabled={!projectAvailable}
        onClick={() => onChange('project')}
        title={projectAvailable ? t('mcp.scopeProjectHint') : t('mcp.scopeProjectUnavailable')}
      >
        {t('mcp.scopeProject')}
      </button>
      <i aria-hidden />
      <button
        type="button"
        aria-pressed={value === 'global'}
        onClick={() => onChange('global')}
        title={t('mcp.scopeGlobalHint')}
      >
        {t('mcp.scopeGlobal')}
      </button>
    </span>
  )
}
