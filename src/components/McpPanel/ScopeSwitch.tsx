import { useT } from '../../lib/i18n'
import type { McpScope } from '../../lib/types'
import styles from './McpPanel.module.css'

type Props = {
  value: McpScope
  projectAvailable: boolean
  onChange: (scope: McpScope) => void
}

export function ScopeSwitch({ value, projectAvailable, onChange }: Props) {
  const t = useT()
  return (
    <div className={styles.segmented} role="group" aria-label={t('mcp.scopeLabel')}>
      <button
        type="button"
        aria-pressed={value === 'global'}
        onClick={() => onChange('global')}
        title={t('mcp.scopeGlobalHint')}
      >
        {t('mcp.scopeGlobal')}
      </button>
      <button
        type="button"
        aria-pressed={value === 'project'}
        disabled={!projectAvailable}
        onClick={() => onChange('project')}
        title={projectAvailable ? t('mcp.scopeProjectHint') : t('mcp.scopeProjectUnavailable')}
      >
        {t('mcp.scopeProject')}
      </button>
    </div>
  )
}
