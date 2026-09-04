import styles from './ProjectSidebar.module.css'
import { TerminalNodeBase, type TerminalNodeProps } from './TerminalNodeBase'

export type { TerminalNodeProps }

export function TerminalNode(props: TerminalNodeProps) {
  return (
    <TerminalNodeBase
      {...props}
      styles={styles}
      menuButtonClass={styles.terminalMenuBtn}
      activitySize={13}
      showUnreadCompletion={false}
    />
  )
}
