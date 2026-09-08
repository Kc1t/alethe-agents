import { GroupNodeBase, type GroupNodeProps } from './GroupNodeBase'
import styles from './NormalProjectSidebar.module.css'

export type NormalGroupNodeProps = GroupNodeProps

export function NormalGroupNode(props: NormalGroupNodeProps) {
  return <GroupNodeBase {...props} styles={styles} addButtonClass={styles.groupAddBtn} />
}
