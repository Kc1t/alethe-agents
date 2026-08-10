import {
  Check,
  CheckCircle2,
  Circle,
  FolderKanban,
  GripVertical,
  ListTodo,
  PanelRightClose,
  Pencil,
  Plus,
  Settings,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useT } from '../../lib/i18n'
import { TODO_TITLE_MAX_LENGTH } from '../../lib/todos'
import type { TodoItem } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './TodoSidebar.module.css'

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
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const openModal = useUiStore((state) => state.openModal_)
  const [title, setTitle] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [projectDraft, setProjectDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const active = todos.filter((todo) => !todo.completed)
  const completed = todos.filter((todo) => todo.completed)

  const submit = () => {
    if (!createTodo(title, parseTags(tagDraft), projectDraft || undefined)) return
    setTitle('')
    setTagDraft('')
    setProjectDraft('')
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

  const renderSection = (items: TodoItem[], completedSection: boolean) => (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>{completedSection ? t('todo.completed') : t('todo.active')}</span>
        <span className={styles.sectionCount}>{items.length}</span>
      </div>
      {items.length > 0 ? (
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
                  {todo.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}
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

  return (
    <aside className={styles.sidebar} aria-label={t('todo.title')}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <ListTodo size={15} />
          <span>{t('todo.title')}</span>
          <span className={styles.pendingCount}>
            {t('todo.pendingCount', { count: active.length })}
          </span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.headerAction}
            onClick={() => openModal('todoSettings')}
            title={t('todo.openSettings')}
            aria-label={t('todo.openSettings')}
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            className={styles.headerAction}
            onClick={() => setPreferences({ rightSidebarVisible: false })}
            title={t('todo.closeSidebar')}
            aria-label={t('todo.closeSidebar')}
          >
            <PanelRightClose size={15} />
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
        <input
          className={styles.addInput}
          value={title}
          maxLength={TODO_TITLE_MAX_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('todo.addPlaceholder')}
          aria-label={t('todo.addPlaceholder')}
        />
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
        <button
          type="submit"
          className={styles.addButton}
          disabled={!title.trim()}
          title={t('todo.add')}
          aria-label={t('todo.add')}
        >
          <Plus size={15} />
        </button>
      </form>

      <div className={styles.content}>
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
            {renderSection(active, false)}
            {renderSection(completed, true)}
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
