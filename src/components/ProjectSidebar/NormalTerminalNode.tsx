import styles from './NormalProjectSidebar.module.css'
import { TerminalNodeBase, type TerminalNodeProps } from './TerminalNodeBase'

export type NormalTerminalNodeProps = TerminalNodeProps

export function NormalTerminalNode(props: NormalTerminalNodeProps) {
  return (
    <TerminalNodeBase
      {...props}
      styles={styles}
      menuButtonClass={styles.rowHoverBtn}
      activitySize={14}
      showUnreadCompletion
    />
  )
}
