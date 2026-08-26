import { Check, ChevronDown, ChevronRight, Loader2, Plus, RotateCcw, Users } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  syncAddTaskComment,
  syncAssignTask,
  syncCompleteTask,
  syncCreateTask,
  syncListVisibleTasks,
  syncReopenTask,
  type TaskRecord,
} from '../../lib/api/syncTasks'
import { useT } from '../../lib/i18n'
import { syncLocalIdentity, syncSecuritySnapshot } from '../../lib/tauri'
import styles from './TasksPanel.module.css'

type Assignable = { accountId: string; label: string }

type Filter = 'all' | 'open' | 'completed'

export function TasksPanel({ projectId }: { projectId: string }) {
  const t = useT()
  const [identity, setIdentity] = useState<{ deviceId: string; accountRoute: string } | null>(null)
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null)
  const [error, setError] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [assignable, setAssignable] = useState<Assignable[]>([])
  const [newAssignees, setNewAssignees] = useState<string[]>([])
  const [assigning, setAssigning] = useState<string | null>(null)

  const refresh = async (currentIdentity: { deviceId: string; accountRoute: string }) => {
    try {
      const list = await syncListVisibleTasks(
        projectId,
        currentIdentity.deviceId,
        currentIdentity.accountRoute,
      )
      setTasks(list)
      setError(false)
    } catch {
      setError(true)
    }
  }

  useEffect(() => {
    let active = true
    setTasks(null)
    setIdentity(null)
    syncLocalIdentity()
      .then(async (id) => {
        if (!active) return
        setIdentity(id)
        await refresh(id)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Who a task can be assigned to: this account plus every collaborator with an active grant for
  // this specific project — the same set of people who can actually see/act on it.
  useEffect(() => {
    let active = true
    syncSecuritySnapshot()
      .then((snapshot) => {
        if (!active) return
        const self: Assignable[] = snapshot.account
          ? [{ accountId: snapshot.account.accountId, label: t('tasks.assigneeSelf') }]
          : []
        const collaborators: Assignable[] = snapshot.grants
          .filter((grant) => grant.projectId === projectId && !grant.revokedAtMs)
          .map((grant) => ({ accountId: grant.accountId, label: grant.accountId }))
        const seen = new Set<string>()
        const merged = [...self, ...collaborators].filter((entry) => {
          if (seen.has(entry.accountId)) return false
          seen.add(entry.accountId)
          return true
        })
        setAssignable(merged)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [projectId, t])

  const createTask = async () => {
    if (!identity || !newTitle.trim()) return
    setCreating(true)
    try {
      const created = await syncCreateTask(
        projectId,
        identity.deviceId,
        newTitle.trim(),
        newBody.trim(),
        'public',
        [],
      )
      if (newAssignees.length > 0) {
        await syncAssignTask(
          projectId,
          created.taskId,
          identity.deviceId,
          created.revision,
          newAssignees,
        )
      }
      setNewTitle('')
      setNewBody('')
      setNewAssignees([])
      // A freshly created task is always 'open' — if the "Completed" filter was active, it would
      // otherwise be created successfully but immediately hidden, looking exactly like it never
      // got created at all.
      if (filter === 'completed') setFilter('all')
      await refresh(identity)
    } catch {
      setError(true)
    } finally {
      setCreating(false)
    }
  }

  const toggleNewAssignee = (accountId: string) => {
    setNewAssignees((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId],
    )
  }

  const setTaskAssignees = async (task: TaskRecord, assignees: string[]) => {
    if (!identity) return
    setAssigning(task.taskId)
    try {
      await syncAssignTask(projectId, task.taskId, identity.deviceId, task.revision, assignees)
      await refresh(identity)
    } catch {
      setError(true)
    } finally {
      setAssigning(null)
    }
  }

  const completeTask = async (task: TaskRecord) => {
    if (!identity) return
    setBusyTaskId(task.taskId)
    try {
      await syncCompleteTask(projectId, task.taskId, identity.deviceId, task.revision)
      await refresh(identity)
    } catch {
      setError(true)
    } finally {
      setBusyTaskId(null)
    }
  }

  const reopenTask = async (task: TaskRecord) => {
    if (!identity) return
    setBusyTaskId(task.taskId)
    try {
      await syncReopenTask(projectId, task.taskId, identity.deviceId, task.revision)
      await refresh(identity)
    } catch {
      setError(true)
    } finally {
      setBusyTaskId(null)
    }
  }

  const submitComment = async (task: TaskRecord) => {
    if (!identity || !commentDraft.trim()) return
    setBusyTaskId(task.taskId)
    try {
      await syncAddTaskComment(
        projectId,
        task.taskId,
        identity.deviceId,
        task.revision,
        commentDraft.trim(),
      )
      setCommentDraft('')
      await refresh(identity)
    } catch {
      setError(true)
    } finally {
      setBusyTaskId(null)
    }
  }

  const visible = (tasks ?? []).filter((task) => {
    if (filter === 'open') return task.status !== 'completed'
    if (filter === 'completed') return task.status === 'completed'
    return true
  })

  return (
    <div className={styles.container}>
      <div className={styles.composer}>
        <input
          className={styles.titleInput}
          value={newTitle}
          placeholder={t('tasks.newTitlePlaceholder')}
          maxLength={140}
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void createTask()
          }}
        />
        <input
          className={styles.bodyInput}
          value={newBody}
          placeholder={t('tasks.newBodyPlaceholder')}
          onChange={(event) => setNewBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void createTask()
          }}
        />
        {assignable.length > 0 ? (
          <div className={styles.assigneePicker}>
            <span className={styles.assigneePickerLabel}>
              <Users size={12} />
              {t('tasks.assignTo')}
            </span>
            {assignable.map((person) => (
              <label key={person.accountId} className={styles.assigneeOption}>
                <input
                  type="checkbox"
                  checked={newAssignees.includes(person.accountId)}
                  onChange={() => toggleNewAssignee(person.accountId)}
                />
                <span>{person.label}</span>
              </label>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className={styles.addButton}
          disabled={creating || !newTitle.trim()}
          onClick={() => void createTask()}
        >
          {creating ? <Loader2 size={13} className={styles.spin} /> : <Plus size={13} />}
          {t('tasks.add')}
        </button>
      </div>

      <div className={styles.filterRow}>
        {(['all', 'open', 'completed'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={`${styles.filterButton} ${filter === option ? styles.filterButtonActive : ''}`}
            onClick={() => setFilter(option)}
          >
            {t(`tasks.filter.${option}`)}
          </button>
        ))}
      </div>

      {error ? <div className={styles.error}>{t('tasks.loadFailed')}</div> : null}

      {!tasks ? (
        <div className={styles.loading}>
          <Loader2 size={16} className={styles.spin} />
        </div>
      ) : visible.length === 0 ? (
        <div className={styles.empty}>{t('tasks.empty')}</div>
      ) : (
        <ul className={styles.list}>
          {visible.map((task) => {
            const expanded = expandedTaskId === task.taskId
            return (
              <li key={task.taskId} className={styles.item}>
                <div className={styles.itemRow}>
                  <button
                    type="button"
                    className={`${styles.checkButton} ${task.status === 'completed' ? styles.checkButtonDone : ''}`}
                    disabled={busyTaskId === task.taskId}
                    onClick={() =>
                      void (task.status === 'completed' ? reopenTask(task) : completeTask(task))
                    }
                    title={task.status === 'completed' ? t('tasks.reopen') : t('tasks.complete')}
                  >
                    {busyTaskId === task.taskId ? (
                      <Loader2 size={11} className={styles.spin} />
                    ) : task.status === 'completed' ? (
                      <RotateCcw size={11} />
                    ) : (
                      <Check size={12} />
                    )}
                  </button>
                  <button
                    type="button"
                    className={styles.itemMain}
                    onClick={() => setExpandedTaskId(expanded ? null : task.taskId)}
                  >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span
                      className={`${styles.itemTitle} ${task.status === 'completed' ? styles.itemTitleDone : ''}`}
                    >
                      {task.title}
                    </span>
                    {task.assignees.length > 0 ? (
                      <span className={styles.assigneeChips}>
                        {task.assignees.map((accountId) => (
                          <span key={accountId} className={styles.assigneeChip}>
                            {assignable.find((person) => person.accountId === accountId)?.label ??
                              accountId}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {task.comments.length > 0 ? (
                      <span className={styles.commentCount}>{task.comments.length}</span>
                    ) : null}
                  </button>
                </div>
                {expanded ? (
                  <div className={styles.itemDetail}>
                    {task.body ? <p className={styles.itemBody}>{task.body}</p> : null}
                    {assignable.length > 0 ? (
                      <div className={styles.assigneePicker}>
                        <span className={styles.assigneePickerLabel}>
                          <Users size={12} />
                          {t('tasks.assignTo')}
                        </span>
                        {assignable.map((person) => {
                          const checked = task.assignees.includes(person.accountId)
                          return (
                            <label key={person.accountId} className={styles.assigneeOption}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={assigning === task.taskId}
                                onChange={() => {
                                  const next = checked
                                    ? task.assignees.filter((id) => id !== person.accountId)
                                    : [...task.assignees, person.accountId]
                                  void setTaskAssignees(task, next)
                                }}
                              />
                              <span>{person.label}</span>
                            </label>
                          )
                        })}
                      </div>
                    ) : null}
                    {task.comments.map((comment, index) => (
                      <div key={index} className={styles.comment}>
                        <span className={styles.commentAuthor}>{comment.authorDeviceId}</span>
                        <span>{comment.body}</span>
                      </div>
                    ))}
                    <div className={styles.commentRow}>
                      <input
                        className={styles.commentInput}
                        value={commentDraft}
                        placeholder={t('tasks.commentPlaceholder')}
                        onChange={(event) => setCommentDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void submitComment(task)
                        }}
                      />
                      <button
                        type="button"
                        className={styles.commentSend}
                        disabled={busyTaskId === task.taskId || !commentDraft.trim()}
                        onClick={() => void submitComment(task)}
                      >
                        {t('tasks.commentSend')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
