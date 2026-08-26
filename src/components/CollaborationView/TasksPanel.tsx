import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { Check, ChevronDown, ChevronRight, GripVertical, Loader2, Plus, RotateCcw, Users } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import {
  syncAddTaskComment,
  syncAssignTask,
  syncCompleteTask,
  syncCreateTask,
  syncListVisibleTasks,
  syncReopenTask,
  type TaskRecord,
} from '../../lib/api/syncTasks'
import { type TFunction, useT } from '../../lib/i18n'
import { syncLocalIdentity, syncSecuritySnapshot } from '../../lib/tauri'
import styles from './TasksPanel.module.css'

type Assignable = { accountId: string; label: string }
type ColumnId = 'all' | 'open' | 'completed'

export function TasksPanel({ projectId }: { projectId: string }) {
  const t = useT()
  const [identity, setIdentity] = useState<{ deviceId: string; accountRoute: string } | null>(null)
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null)
  const [error, setError] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [assignable, setAssignable] = useState<Assignable[]>([])
  const [newAssignees, setNewAssignees] = useState<string[]>([])
  const [activeDragTaskId, setActiveDragTaskId] = useState<string | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

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
        await syncAssignTask(projectId, created.taskId, identity.deviceId, created.revision, newAssignees)
      }
      setNewTitle('')
      setNewBody('')
      setNewAssignees([])
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
    setBusyTaskId(task.taskId)
    try {
      await syncAssignTask(projectId, task.taskId, identity.deviceId, task.revision, assignees)
      await refresh(identity)
    } catch {
      setError(true)
    } finally {
      setBusyTaskId(null)
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

  const all = tasks ?? []
  const open = all.filter((task) => task.status !== 'completed')
  const completed = all.filter((task) => task.status === 'completed')

  const columns: { id: ColumnId; name: string; tasks: TaskRecord[]; draggable: boolean }[] = [
    { id: 'all', name: t('tasks.filter.all'), tasks: all, draggable: false },
    { id: 'open', name: t('tasks.filter.open'), tasks: open, draggable: true },
    { id: 'completed', name: t('tasks.filter.completed'), tasks: completed, draggable: true },
  ]

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    if (id.startsWith('task:')) setActiveDragTaskId(id.slice(5))
  }

  const onDragEnd = (event: DragEndEvent) => {
    setActiveDragTaskId(null)
    const { active, over } = event
    if (!over) return
    const taskId = String(active.id).replace(/^task:/, '')
    const columnId = String(over.id).replace(/^column:/, '') as ColumnId
    const task = all.find((entry) => entry.taskId === taskId)
    if (!task) return
    if (columnId === 'completed' && task.status !== 'completed') void completeTask(task)
    if (columnId === 'open' && task.status === 'completed') void reopenTask(task)
  }

  const activeDragTask = activeDragTaskId ? all.find((task) => task.taskId === activeDragTaskId) : null

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

      {error ? <div className={styles.error}>{t('tasks.loadFailed')}</div> : null}

      {!tasks ? (
        <div className={styles.loading}>
          <Loader2 size={16} className={styles.spin} />
        </div>
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className={styles.board}>
            {columns.map((column) => (
              <TaskColumn
                key={column.id}
                id={column.id}
                name={column.name}
                tasks={column.tasks}
                droppable={column.draggable}
              >
                {(task) => (
                  <TaskCard
                    key={task.taskId}
                    task={task}
                    draggable={column.draggable}
                    expanded={expandedTaskId === task.taskId}
                    busy={busyTaskId === task.taskId}
                    assignable={assignable}
                    commentDraft={commentDraft}
                    onToggleExpand={() =>
                      setExpandedTaskId(expandedTaskId === task.taskId ? null : task.taskId)
                    }
                    onToggleComplete={() =>
                      void (task.status === 'completed' ? reopenTask(task) : completeTask(task))
                    }
                    onSetAssignees={(assignees) => void setTaskAssignees(task, assignees)}
                    onCommentDraftChange={setCommentDraft}
                    onSubmitComment={() => void submitComment(task)}
                    t={t}
                  />
                )}
              </TaskColumn>
            ))}
          </div>
          <DragOverlay>
            {activeDragTask ? (
              <div className={styles.dragOverlayCard}>{activeDragTask.title}</div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  )
}

function TaskColumn({
  id,
  name,
  tasks,
  droppable,
  children,
}: {
  id: ColumnId
  name: string
  tasks: TaskRecord[]
  droppable: boolean
  children: (task: TaskRecord) => ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${id}`, disabled: !droppable })
  return (
    <div ref={setNodeRef} className={`${styles.column} ${isOver ? styles.columnOver : ''}`}>
      <div className={styles.columnHeader}>
        <span className={styles.columnName}>{name}</span>
        <span className={styles.columnCount}>{tasks.length}</span>
      </div>
      <div className={styles.columnBody}>
        {tasks.length === 0 ? (
          <div className={styles.columnEmpty} />
        ) : (
          tasks.map((task) => children(task))
        )}
      </div>
    </div>
  )
}

function TaskCard({
  task,
  draggable,
  expanded,
  busy,
  assignable,
  commentDraft,
  onToggleExpand,
  onToggleComplete,
  onSetAssignees,
  onCommentDraftChange,
  onSubmitComment,
  t,
}: {
  task: TaskRecord
  draggable: boolean
  expanded: boolean
  busy: boolean
  assignable: Assignable[]
  commentDraft: string
  onToggleExpand: () => void
  onToggleComplete: () => void
  onSetAssignees: (assignees: string[]) => void
  onCommentDraftChange: (value: string) => void
  onSubmitComment: () => void
  t: TFunction
}) {
  const draggableHook = useDraggable({ id: `task:${task.taskId}`, disabled: !draggable })
  return (
    <div
      ref={draggableHook.setNodeRef}
      className={styles.item}
      style={{ opacity: draggableHook.isDragging ? 0.4 : 1 }}
    >
      <div className={styles.itemRow}>
        {draggable ? (
          <button
            type="button"
            className={styles.dragHandle}
            {...draggableHook.listeners}
            {...draggableHook.attributes}
            title={t('tasks.dragHandle')}
          >
            <GripVertical size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.checkButton} ${task.status === 'completed' ? styles.checkButtonDone : ''}`}
          disabled={busy}
          onClick={onToggleComplete}
          title={task.status === 'completed' ? t('tasks.reopen') : t('tasks.complete')}
        >
          {busy ? (
            <Loader2 size={11} className={styles.spin} />
          ) : task.status === 'completed' ? (
            <RotateCcw size={11} />
          ) : (
            <Check size={12} />
          )}
        </button>
        <button type="button" className={styles.itemMain} onClick={onToggleExpand}>
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
                  {assignable.find((person) => person.accountId === accountId)?.label ?? accountId}
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
                      disabled={busy}
                      onChange={() => {
                        const next = checked
                          ? task.assignees.filter((id) => id !== person.accountId)
                          : [...task.assignees, person.accountId]
                        onSetAssignees(next)
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
              onChange={(event) => onCommentDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSubmitComment()
              }}
            />
            <button
              type="button"
              className={styles.commentSend}
              disabled={busy || !commentDraft.trim()}
              onClick={onSubmitComment}
            >
              {t('tasks.commentSend')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
