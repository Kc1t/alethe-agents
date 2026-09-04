import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { TasksPanel } from './TasksPanel'
import styles from './TasksTab.module.css'

export function TasksTab({ activeProjectId }: { activeProjectId: string }) {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const [selectedProjectId, setSelectedProjectId] = useState(activeProjectId)

  useEffect(() => {
    setSelectedProjectId(activeProjectId)
  }, [activeProjectId])

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>{t('tasks.projectsHeader')}</div>
        <ul className={styles.projectList}>
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={`${styles.projectRow} ${
                  project.id === selectedProjectId ? styles.projectRowActive : ''
                }`}
                onClick={() => setSelectedProjectId(project.id)}
                title={project.name}
              >
                <Folder size={13} className={styles.projectIcon} />
                <span className={styles.projectName}>{project.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.tasksArea}>
        <TasksPanel key={selectedProjectId} projectId={selectedProjectId} />
      </div>
    </div>
  )
}
