import {
  Check,
  ChevronDown,
  FolderKanban,
  GripVertical,
  ListTodo,
  Pencil,
  Plus,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { type GsdSyncSession, useGsdSyncSessions } from '../../hooks/useGsdSyncSessions'
import { useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import { type PlanningStatus, readPlanningStatus } from '../../lib/tauri'
import { TODO_TITLE_MAX_LENGTH } from '../../lib/todos'
import type { Terminal, TodoItem } from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './TodoSidebar.module.css'

function GsdSyncSection() {
  const t = useT()
  const activeProject = useProjectsStore(selectActiveProject)
  const setFullscreenPane = useProjectsStore((state) => state.setFullscreenPane)
  const sessions = useGsdSyncSessions()
  const projectSessions = activeProject
    ? sessions.filter((session) => session.projectId === activeProject.id)
    : []

  if (!activeProject || projectSessions.length === 0) return null

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>{t('todo.gsdSectionTitle')}</span>
        <span className={styles.sectionCount}>{projectSessions.length}</span>
      </div>
      <div className={styles.list}>
        {projectSessions.map((session) => {
          const terminal = activeProject.terminals.find((term) => term.cwd === session.worktreePath)
          if (!terminal) return null
          return (
            <GsdSyncRow
              key={session.id}
              terminal={terminal}
              session={session}
              onOpen={() => setFullscreenPane(terminal.id)}
            />
          )
        })}
      </div>
    </section>
  )
}

function GsdSyncRow({
  terminal,
  session,
  onOpen,
}: {
  terminal: Terminal
  session: GsdSyncSession
  onOpen: () => void
}) {
  const t = useT()
  const [status, setStatus] = useState<PlanningStatus | null>(null)

  useEffect(() => {
    if (!terminal.cwd) return
    let cancelled = false
    readPlanningStatus(terminal.cwd)
      .then((result) => {
        if (!cancelled) setStatus(result)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [terminal.cwd, session.busy])

  const statusLabel = session.hasError ? t('todo.gsdError') : session.busy ? t('todo.gsdBusy') : t('todo.gsdIdle')
  const progressLabel =
    status?.roadmapTotalCount != null && status.roadmapPendingCount != null
      ? t('todo.gsdProgress', {
          done: status.roadmapTotalCount - status.roadmapPendingCount,
          total: status.roadmapTotalCount,
        })
      : null

  return (
    <button type="button" className={styles.gsdRow} onClick={onOpen} title={terminal.name}>
      <span className={styles.gsdRowState}>
        {session.hasError ? (
          <span className={styles.gsdErrorDot} />
        ) : session.busy ? (
          <DotmCircular2 size={13} dotSize={2} cellPadding={1} speed={1.2} bloom ariaLabel={statusLabel} />
        ) : (
          <span className={styles.gsdIdleDot} />
        )}
      </span>
      <span className={styles.gsdRowBody}>
        <span className={styles.gsdRowName}>{terminal.name}</span>
        <span className={styles.gsdRowMeta}>{progressLabel ?? statusLabel}</span>
      </span>
    </button>
  )
}

export function TodoSidebar() {
  const t = useT()
  const todos = useProjectsStore((state) => state.todos)
  const projects = useProjectsStore((state) => state.projects)
  const createTodo = useProjectsStore((state) => state.createTodo)
  const renameTodo = useProjectsStore((state) => state.renameTodo)
  const updateTodoTags = useProjectsStore((state) => state.updateTodoTags)
  const setTodoProject = useProjectsStore((state) => state.setTodoProject)
  const toggleTodo = useProjectsStore((state) => state.toggleTodo)
  const deleteTodo = useProjectsStore((state) => state.deleteTodo)
  const reorderTodo = useProjectsStore((state) => state.reorderTodo)
  const [title, setTitle] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [projectDraft, setProjectDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all')
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(['completed']),
  )
  const addInputRef = useRef<HTMLInputElement>(null)

  const active = todos.filter((todo) => !todo.completed)
  const completed = todos.filter((todo) => todo.completed)
  const progress = todos.length > 0 ? Math.round((completed.length / todos.length) * 100) : 0
  const activeProjectSections = projects
    .map((project) => ({
      key: `project:${project.id}`,
      label: project.name,
      projectId: project.id,
      iconUrl: project.iconUrl,
      items: active.filter((todo) => todo.projectId === project.id),
    }))
    .filter((section) => section.items.length > 0)
  const unassigned = active.filter((todo) => !todo.projectId)

  useEffect(() => {
    const focusComposer = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      setComposerExpanded(true)
      addInputRef.current?.focus()
    }
    window.addEventListener('keydown', focusComposer, true)
    return () => window.removeEventListener('keydown', focusComposer, true)
  }, [])

  const submit = () => {
    if (!createTodo(title, parseTags(tagDraft), projectDraft || undefined)) return
    setTitle('')
    setTagDraft('')
    setProjectDraft('')
    setComposerExpanded(false)
  }

  const toggleSection = (key: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const startProjectTodo = (projectId = '') => {
    setProjectDraft(projectId)
    setComposerExpanded(true)
    window.requestAnimationFrame(() => addInputRef.current?.focus())
  }

  const startEditing = (todo: TodoItem) => {
    setEditingId(todo.id)
    setEditTitle(todo.title)
  }

  const finishEditing = () => {
    if (!editingId) return
    if (editTitle.trim()) renameTodo(editingId, editTitle)
    setEditingId(null)
    setEditTitle('')
  }

  const editTags = (todo: TodoItem) => {
    const value = window.prompt(t('todo.tagsPrompt'), todo.tags.join(', '))
    if (value === null) return
    updateTodoTags(todo.id, parseTags(value))
  }

  const renderSection = ({
    key,
    label,
    items,
    completedSection = false,
    projectId,
    iconUrl,
  }: {
    key: string
    label: string
    items: TodoItem[]
    completedSection?: boolean
    projectId?: string
    iconUrl?: string
  }) => {
    const collapsed = collapsedSections.has(key)
    return (
    <section key={key} className={styles.section}>
      <div className={styles.sectionHeader}>
        <button
          type="button"
          className={styles.sectionToggle}
          onClick={() => toggleSection(key)}
          aria-expanded={!collapsed}
        >
          <ChevronDown
            size={13}
            className={`${styles.sectionChevron} ${collapsed ? styles.sectionChevronClosed : ''}`}
          />
          {iconUrl ? <img src={iconUrl} alt="" className={styles.sectionIcon} /> : null}
          <span className={styles.sectionName}>{label}</span>
          <span className={styles.sectionCount}>{items.length}</span>
          <span className={styles.sectionRule} />
        </button>
        {!completedSection ? (
          <button
            type="button"
            className={styles.sectionAdd}
            onClick={() => startProjectTodo(projectId)}
            title={t('todo.add')}
            aria-label={t('todo.add')}
          >
            <Plus size={13} />
          </button>
        ) : null}
      </div>
      {!collapsed && items.length > 0 ? (
        <div className={styles.list}>
          {items.map((todo) => {
            const editing = editingId === todo.id
            return (
              <div
                key={todo.id}
                className={[
                  styles.todoRow,
                  todo.completed ? styles.todoRowCompleted : '',
                  draggedId === todo.id ? styles.todoRowDragging : '',
                  dropTargetId === todo.id && draggedId !== todo.id ? styles.todoRowDropTarget : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable={!editing}
                onDragStart={(event) => {
                  setDraggedId(todo.id)
                  setDropTargetId(null)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', todo.id)
                }}
                onDragEnd={() => {
                  setDraggedId(null)
                  setDropTargetId(null)
                }}
                onDragOver={(event) => {
                  if (!draggedId) return
                  const dragged = todos.find((item) => item.id === draggedId)
                  if (dragged?.completed !== todo.completed) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTargetId(todo.id)
                }}
                onDragLeave={() => {
                  if (dropTargetId === todo.id) setDropTargetId(null)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (draggedId) reorderTodo(draggedId, todo.id)
                  setDraggedId(null)
                  setDropTargetId(null)
                }}
              >
                <button
                  type="button"
                  className={styles.dragHandle}
                  title={t('todo.drag')}
                  aria-label={t('todo.drag')}
                  tabIndex={-1}
                >
                  <GripVertical size={13} />
                </button>
                <button
                  type="button"
                  className={styles.checkButton}
                  onClick={() => toggleTodo(todo.id)}
                  title={todo.completed ? t('todo.reopen') : t('todo.complete')}
                  aria-label={todo.completed ? t('todo.reopen') : t('todo.complete')}
                >
                  {todo.completed ? <Check size={12} /> : null}
                </button>

                {editing ? (
                  <input
                    autoFocus
                    className={styles.editInput}
                    value={editTitle}
                    maxLength={TODO_TITLE_MAX_LENGTH}
                    onChange={(event) => setEditTitle(event.target.value)}
                    onBlur={() => {
                      setEditingId(null)
                      setEditTitle('')
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') finishEditing()
                      if (event.key === 'Escape') {
                        setEditingId(null)
                        setEditTitle('')
                      }
                    }}
                    aria-label={t('todo.edit')}
                  />
                ) : (
                  <div className={styles.todoTitle}>
                    <button
                      type="button"
                      className={styles.titleButton}
                      onClick={() => startEditing(todo)}
                      title={todo.title}
                    >
                      <span className={styles.todoTitleText}>{todo.title}</span>
                    </button>
                    {todo.tags.length > 0 ? (
                      <span className={styles.tags}>
                        {todo.tags.map((tag) => (
                          <span key={tag} className={styles.tag}>
                            #{tag}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <ProjectPicker
                      value={todo.projectId ?? ''}
                      projects={projects}
                      noProjectLabel={t('todo.noProject')}
                      ariaLabel={t('todo.linkProject')}
                      compact
                      onChange={(projectId) => setTodoProject(todo.id, projectId || null)}
                    />
                  </div>
                )}

                <div className={styles.rowActions}>
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className={styles.rowAction}
                        onClick={() => editTags(todo)}
                        title={t('todo.editTags')}
                        aria-label={t('todo.editTags')}
                      >
                        <Tag size={12} />
                      </button>
                      <button
                        type="button"
                        className={styles.rowAction}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={finishEditing}
                        title={t('todo.saveEdit')}
                        aria-label={t('todo.saveEdit')}
                      >
                        <Check size={13} />
                      </button>
                      <button
                        type="button"
                        className={styles.rowAction}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setEditingId(null)
                          setEditTitle('')
                        }}
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                      >
                        <X size={13} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={styles.rowAction}
                        onClick={() => startEditing(todo)}
                        title={t('todo.edit')}
                        aria-label={t('todo.edit')}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className={`${styles.rowAction} ${styles.deleteAction}`}
                        onClick={() => deleteTodo(todo.id)}
                        title={t('todo.delete')}
                        aria-label={t('todo.delete')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : completedSection && todos.length > 0 ? (
        <p className={styles.sectionEmpty}>{t('todo.emptyCompleted')}</p>
      ) : null}
    </section>
    )
  }

  return (
    <aside className={styles.sidebar} aria-label={t('todo.title')}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.heading}>
            <ListTodo size={17} />
            <span>{t('todo.title')}</span>
          </div>
        </div>
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={todos.length}
          aria-valuenow={completed.length}
        >
          <span className={styles.progressTrack}>
            <span className={styles.progressFill} style={{ width: `${progress}%` }} />
          </span>
          <span className={styles.progressCount}>
            {completed.length} / {todos.length}
          </span>
        </div>
        <div className={styles.filters} role="tablist" aria-label={t('todo.filters')}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`${styles.filterButton} ${filter === 'all' ? styles.filterButtonActive : ''}`}
            onClick={() => setFilter('all')}
          >
            {t('todo.all')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'active'}
            className={`${styles.filterButton} ${filter === 'active' ? styles.filterButtonActive : ''}`}
            onClick={() => setFilter('active')}
          >
            {t('todo.active')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'completed'}
            className={`${styles.filterButton} ${filter === 'completed' ? styles.filterButtonActive : ''}`}
            onClick={() => setFilter('completed')}
          >
            {t('todo.completed')}
          </button>
        </div>
      </header>

      <form
        className={styles.addForm}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className={styles.composerBox}>
          <button
            type="submit"
            className={styles.composerSubmit}
            disabled={!title.trim()}
            title={t('todo.add')}
            aria-label={t('todo.add')}
          >
            <Plus size={15} />
          </button>
          <input
            ref={addInputRef}
            className={styles.composerInput}
            value={title}
            maxLength={TODO_TITLE_MAX_LENGTH}
            onFocus={() => setComposerExpanded(true)}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !title.trim()) setComposerExpanded(false)
            }}
            placeholder={t('todo.addPlaceholder')}
            aria-label={t('todo.addPlaceholder')}
          />
          <kbd className={styles.composerShortcut}>{formatShortcut('Ctrl+N')}</kbd>
        </div>
        {composerExpanded ? (
          <div className={styles.composerDetails}>
            <div className={styles.tagInputWrap}>
              <Tag size={13} aria-hidden="true" />
              <input
                className={`${styles.addInput} ${styles.addTagInput}`}
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                placeholder={t('todo.tagsPlaceholder')}
                aria-label={t('todo.tagsPlaceholder')}
              />
            </div>
            <ProjectPicker
              value={projectDraft}
              projects={projects}
              noProjectLabel={t('todo.noProject')}
              ariaLabel={t('todo.linkProject')}
              onChange={setProjectDraft}
            />
          </div>
        ) : null}
      </form>

      <div className={styles.content}>
        {filter !== 'completed' ? <GsdSyncSection /> : null}
        {todos.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>
              <ListTodo size={20} />
            </div>
            <strong>{t('todo.emptyTitle')}</strong>
            <span>{t('todo.emptyDescription')}</span>
          </div>
        ) : (
          <>
            {filter !== 'completed'
              ? activeProjectSections.map((section) => renderSection(section))
              : null}
            {filter !== 'completed' && unassigned.length > 0
              ? renderSection({
                  key: 'unassigned',
                  label: t('todo.noProject'),
                  items: unassigned,
                })
              : null}
            {filter !== 'active'
              ? renderSection({
                  key: 'completed',
                  label: t('todo.completed'),
                  items: completed,
                  completedSection: true,
                })
              : null}
            {filter === 'active' && active.length === 0 ? (
              <p className={styles.filterEmpty}>{t('todo.emptyTitle')}</p>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}

function ProjectPicker({
  value,
  projects,
  noProjectLabel,
  ariaLabel,
  compact = false,
  onChange,
}: {
  value: string
  projects: Array<{ id: string; name: string }>
  noProjectLabel: string
  ariaLabel: string
  compact?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, width: 240 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedLabel = projects.find((project) => project.id === value)?.name ?? noProjectLabel

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', closeOnOutsideClick)
    return () => document.removeEventListener('click', closeOnOutsideClick)
  }, [open])

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(300, Math.max(220, rect.width), window.innerWidth - 16)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      const estimatedHeight = Math.min(240, (projects.length + 1) * 32 + 8)
      const roomBelow = window.innerHeight - rect.bottom - 8
      const top = roomBelow >= Math.min(estimatedHeight, 180)
        ? rect.bottom + 5
        : Math.max(8, rect.top - estimatedHeight - 5)
      setMenuPosition({ left, top, width })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, projects.length])

  const choose = (nextValue: string) => {
    onChange(nextValue)
    setOpen(false)
  }

  return (
    <div className={compact ? styles.projectLink : styles.projectInputWrap}>
      <FolderKanban size={compact ? 11 : 13} aria-hidden="true" />
      <button
        ref={triggerRef}
        type="button"
        className={styles.projectPickerButton}
        aria-label={ariaLabel}
        aria-expanded={open}
        title={selectedLabel}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span>{selectedLabel}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.projectMenu}
              role="listbox"
              aria-label={ariaLabel}
              style={menuPosition}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="option"
                aria-selected={!value}
                className={`${styles.projectOption} ${!value ? styles.projectOptionSelected : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  choose('')
                }}
              >
                {noProjectLabel}
              </button>
              {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="option"
              aria-selected={project.id === value}
              className={`${styles.projectOption} ${project.id === value ? styles.projectOptionSelected : ''}`}
              title={project.name}
              onClick={(event) => {
                event.stopPropagation()
                choose(project.id)
              }}
            >
              {project.name}
            </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function parseTags(value: string): string[] {
  return value
    .split(/[,#\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}
