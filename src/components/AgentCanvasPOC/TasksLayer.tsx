import { ListTodo } from 'lucide-react'
import { type MutableRefObject } from 'react'

import { useT } from '../../lib/i18n'
import type { TeamTask } from '../../stores/agentCanvasStore'
import styles from './AgentCanvasPOC.module.css'

type TasksLayerProps = {
  tasks: TeamTask[]
  teamName: string | null
                                                                       
  taskRefs: MutableRefObject<Map<string, HTMLDivElement>>
}

/** Team task DAG; each task connects to its owning teammate. */
export function TasksLayer({ tasks, teamName, taskRefs }: TasksLayerProps) {
  const t = useT()
  return (
    <div className={styles.tasksLayer}>
      <div className={styles.tasksLayerTitle}>
        <ListTodo size={13} /> {t('ws.tasksTitle')}
        {teamName ? ` · ${teamName}` : ''}
      </div>
      <div className={styles.tasksLayerGrid}>
        {tasks.map((task) => (
          <div
            key={task.id}
            ref={(el) => {
              if (el) taskRefs.current.set(task.id, el)
              else taskRefs.current.delete(task.id)
            }}
            className={
              task.status === 'completed'
                ? `${styles.taskNode} ${styles.taskNodeDone}`
                : styles.taskNode
            }
          >
            <div className={styles.taskNodeHead}>
              <span
                className={
                  task.status === 'completed'
                    ? styles.taskDotDone
                    : task.status === 'in_progress'
                      ? styles.taskDotActive
                      : styles.taskDot
                }
              />
              <span className={styles.taskNodeSubject}>{task.subject}</span>
            </div>
            <div className={styles.taskNodeMeta}>
              #{task.id}
              {task.owner ? ` · ${task.owner}` : ''} ·{' '}
              {task.status === 'completed'
                ? t('ws.taskCompleted')
                : task.status === 'in_progress'
                  ? t('ws.taskInProgress')
                  : t('ws.taskPending')}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
