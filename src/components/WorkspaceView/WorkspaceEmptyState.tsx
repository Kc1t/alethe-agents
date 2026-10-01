import styles from './WorkspaceEmptyState.module.css'

export type WorkspaceEmptyAction = {
  label: string
  onClick: () => void
  shortcut?: string
}

function Shortcut({ value }: { value: string }) {
  const keys = value.includes('+') ? value.split('+') : [value]
  return (
    <span className={styles.shortcut} aria-hidden="true">
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  )
}

export function WorkspaceEmptyState({ actions }: { actions: WorkspaceEmptyAction[] }) {
  return (
    <div className={styles.root}>
      <div className={styles.mark} aria-hidden="true" />
      <div className={styles.actions}>
        {actions.map((action) => (
          <button key={action.label} type="button" onClick={action.onClick}>
            <span>{action.label}</span>
            {action.shortcut ? <Shortcut value={action.shortcut} /> : null}
          </button>
        ))}
      </div>
    </div>
  )
}
