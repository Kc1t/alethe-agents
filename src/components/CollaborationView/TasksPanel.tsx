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
import {
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import {
  syncAddTaskComment,
  syncAssignTask,
  syncCompleteTask,
  syncCreateTask,
  syncDeleteTask,
  syncListVisibleTasks,
  syncReopenTask,
  syncUpdateTask,
  type TaskRecord,
} from '../../lib/api/syncTasks'
import { type TFunction, useT } from '../../lib/i18n'
import { withFallback } from '../../lib/resilience'
import { syncLocalIdentity, syncSecuritySnapshot } from '../../lib/tauri'
import styles from './TasksPanel.module.css'

type Assignable = { accountId: string; label: string }

// One column per category, always. NO_CATEGORY is the fixed column for tasks with no label yet —
// it can't be renamed or deleted, since it isn't a real category.
const NO_CATEGORY = '__none__'

// Categories are a purely client-side concept — the backend only ever stores labels on individual
// tasks, nothing tracks "this category/column exists" on its own. Without this, a freshly created
// empty column (before it's ever assigned to a task) would vanish the moment this component
// remounts — e.g. switching project tabs — since it only lived in React state.
function categoriesStorageKey(projectId: string): string {
  return `alethe.tasks.categories.${projectId}`
}

function loadStoredCategories(projectId: string): string[] {
  try {
    const raw = window.localStorage.getItem(categoriesStorageKey(projectId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

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
  const [newCategory, setNewCategory] = useState<string>(NO_CATEGORY)
  const [extraCategories, setExtraCategories] = useState<string[]>(() =>
    loadStoredCategories(projectId),
  )
  const [addingColumn, setAddingColumn] = useState(false)
  const [newColumnName, setNewColumnName] = useState('')
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
    setExtraCategories(loadStoredCategories(projectId))
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
      .catch(withFallback('setAssignable', undefined))
    return () => {
      active = false
    }
  }, [projectId, t])

  const persistCategories = (next: string[]) => {
    try {
      window.localStorage.setItem(categoriesStorageKey(projectId), JSON.stringify(next))
    } catch {
      // Best-effort — the column still works for the rest of this session either way.
    }
  }

  const confirmNewColumn = () => {
    const name = newColumnName.trim()
    if (!name || name === NO_CATEGORY) return
    setExtraCategories((current) => {
      if (current.includes(name)) return current
      const next = [...current, name]
      persistCategories(next)
      return next
    })
    setNewColumnName('')
    setAddingColumn(false)
  }

  const renameColumn = async (oldName: string) => {
    const input = window.prompt(t('tasks.renameCategoryPrompt'), oldName)
    const newName = input?.trim()
    if (!newName || newName === oldName) return
    setExtraCategories((current) => {
      const next = [...new Set(current.filter((c) => c !== oldName).concat(newName))]
      persistCategories(next)
      return next
    })
    if (identity) {
      const affected = all.filter((task) => task.labels.includes(oldName))
      for (const task of affected) {
        const nextLabels = [
          ...new Set(task.labels.map((label) => (label === oldName ? newName : label))),
        ]
        try {
          await syncUpdateTask(projectId, task.taskId, identity.deviceId, task.revision, {
            labels: nextLabels,
          })
        } catch {
          setError(true)
        }
      }
      await refresh(identity)
    }
  }

  const deleteColumn = async (name: string) => {
    if (!window.confirm(t('tasks.deleteCategoryConfirm'))) return
    setExtraCategories((current) => {
      const next = current.filter((c) => c !== name)
      persistCategories(next)
      return next
    })
    if (newCategory === name) setNewCategory(NO_CATEGORY)
    if (identity) {
      const affected = all.filter((task) => task.labels.includes(name))
      for (const task of affected) {
        const nextLabels = task.labels.filter((label) => label !== name)
        try {
          await syncUpdateTask(projectId, task.taskId, identity.deviceId, task.revision, {
            labels: nextLabels,
          })
        } catch {
          setError(true)
        }
      }
      await refresh(identity)
    }
  }

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
      let latestRevision = created.revision
      if (newAssignees.length > 0) {
        const assigned = await syncAssignTask(
          projectId,
          created.taskId,
          identity.deviceId,
          latestRevision,
          newAssignees,
        )
        latestRevision = assigned.revision
      }
      if (newCategory !== NO_CATEGORY) {
        await syncUpdateTask(projectId, created.taskId, identity.deviceId, latestRevision, {
          labels: [newCategory],
        })
      }
      setNewTitle('')
      setNewBody('')
      setNewAssignees([])
      setNewCategory(NO_CATEGORY)
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

  const setTaskColumn = async (task: TaskRecord, columnId: string) => {
    if (!identity) return
    setBusyTaskId(task.taskId)
    try {
      await syncUpdateTask(projectId, task.taskId, identity.deviceId, task.revision, {
        labels: columnId === NO_CATEGORY ? [] : [columnId],
      })
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

  const deleteTask = async (task: TaskRecord) => {
    if (!identity) return
    if (!window.confirm(t('tasks.deleteConfirm'))) return
    setBusyTaskId(task.taskId)
    try {
      await syncDeleteTask(projectId, task.taskId, identity.deviceId, task.revision)
      if (expandedTaskId === task.taskId) setExpandedTaskId(null)
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

  const categories = (() => {
    const seen = new Set<string>(extraCategories)
    for (const task of all) {
      for (const label of task.labels) seen.add(label)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  })()

  const columns = [
    { id: NO_CATEGORY, name: t('tasks.noCategory') },
    ...categories.map((category) => ({ id: category, name: category })),
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
    const columnId = String(over.id).replace(/^column:/, '')
    const task = all.find((entry) => entry.taskId === taskId)
    if (!task) return
    const currentColumn = task.labels[0] ?? NO_CATEGORY
    if (currentColumn === columnId) return
    void setTaskColumn(task, columnId)
  }

  const activeDragTask = activeDragTaskId
    ? all.find((task) => task.taskId === activeDragTaskId)
    : null

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
        <div className={styles.assigneePicker}>
          <span className={styles.assigneePickerLabel}>{t('tasks.category')}</span>
          <select
            className={styles.categorySelect}
            value={newCategory}
            onChange={(event) => setNewCategory(event.target.value)}
          >
            <option value={NO_CATEGORY}>{t('tasks.noCategory')}</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
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
                removable={column.id !== NO_CATEGORY}
                tasks={all.filter((task) => (task.labels[0] ?? NO_CATEGORY) === column.id)}
                onRename={() => void renameColumn(column.id)}
                onDeleteColumn={() => void deleteColumn(column.id)}
              >
                {(task) => (
                  <TaskCard
                    key={task.taskId}
                    task={task}
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
                    onDelete={() => void deleteTask(task)}
                    onSetAssignees={(assignees) => void setTaskAssignees(task, assignees)}
                    onCommentDraftChange={setCommentDraft}
                    onSubmitComment={() => void submitComment(task)}
                    t={t}
                  />
                )}
              </TaskColumn>
            ))}
            <div className={styles.addColumn}>
              {addingColumn ? (
                <span className={styles.newCategoryInline}>
                  <input
                    autoFocus
                    className={styles.newCategoryInput}
                    value={newColumnName}
                    placeholder={t('tasks.newCategoryPlaceholder')}
                    maxLength={40}
                    onChange={(event) => setNewColumnName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') confirmNewColumn()
                      if (event.key === 'Escape') {
                        setAddingColumn(false)
                        setNewColumnName('')
                      }
                    }}
                  />
                  <button type="button" className={styles.iconButton} onClick={confirmNewColumn}>
                    <Check size={12} />
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => {
                      setAddingColumn(false)
                      setNewColumnName('')
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.addCategoryButton}
                  title={t('tasks.addCategory')}
                  onClick={() => setAddingColumn(true)}
                >
                  <Plus size={13} />
                  {t('tasks.addCategory')}
                </button>
              )}
            </div>
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
  removable,
  onRename,
  onDeleteColumn,
  children,
}: {
  id: string
  name: string
  tasks: TaskRecord[]
  removable: boolean
  onRename: () => void
  onDeleteColumn: () => void
  children: (task: TaskRecord) => ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${id}` })
  return (
    <div ref={setNodeRef} className={`${styles.column} ${isOver ? styles.columnOver : ''}`}>
      <div className={styles.columnHeader}>
        <span className={styles.columnName}>{name}</span>
        <span className={styles.columnCount}>{tasks.length}</span>
        {removable ? (
          <span className={styles.columnActions}>
            <button type="button" className={styles.iconButton} onClick={onRename}>
              <Pencil size={11} />
            </button>
            <button type="button" className={styles.iconButton} onClick={onDeleteColumn}>
              <Trash2 size={11} />
            </button>
          </span>
        ) : null}
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
  expanded,
  busy,
  assignable,
  commentDraft,
  onToggleExpand,
  onToggleComplete,
  onDelete,
  onSetAssignees,
  onCommentDraftChange,
  onSubmitComment,
  t,
}: {
  task: TaskRecord
  expanded: boolean
  busy: boolean
  assignable: Assignable[]
  commentDraft: string
  onToggleExpand: () => void
  onToggleComplete: () => void
  onDelete: () => void
  onSetAssignees: (assignees: string[]) => void
  onCommentDraftChange: (value: string) => void
  onSubmitComment: () => void
  t: TFunction
}) {
  const draggableHook = useDraggable({ id: `task:${task.taskId}` })
  return (
    <div
      ref={draggableHook.setNodeRef}
      className={styles.item}
      style={{ opacity: draggableHook.isDragging ? 0.4 : 1 }}
    >
      <div className={styles.itemRow}>
        <button
          type="button"
          className={styles.dragHandle}
          {...draggableHook.listeners}
          {...draggableHook.attributes}
          title={t('tasks.dragHandle')}
        >
          <GripVertical size={12} />
        </button>
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
        <button
          type="button"
          className={styles.deleteButton}
          disabled={busy}
          onClick={onDelete}
          title={t('tasks.delete')}
        >
          <Trash2 size={12} />
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
