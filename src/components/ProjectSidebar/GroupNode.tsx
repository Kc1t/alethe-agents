import { GroupNodeBase, type GroupNodeProps } from './GroupNodeBase'
import styles from './ProjectSidebar.module.css'

export type { GroupNodeProps }

export function GroupNode(props: GroupNodeProps) {
  return <GroupNodeBase {...props} styles={styles} addButtonClass={styles.groupAddButton} />
}
