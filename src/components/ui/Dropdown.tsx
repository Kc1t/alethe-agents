import { ChevronDown, Search } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import styles from './Dropdown.module.css'

export type DropdownOption = {
  value: string
  label: ReactNode
  disabled?: boolean
  searchText?: string
}

type DropdownProps = {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  ariaLabel: string
  id?: string
  placeholder?: ReactNode
  displayValue?: ReactNode
  disabled?: boolean
  className?: string
  title?: string
  searchable?: boolean
  searchPlaceholder?: string
  emptyLabel?: ReactNode | ((query: string) => ReactNode)
  allowCustomValue?: boolean
  customOptionLabel?: (value: string) => ReactNode
}

export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  placeholder,
  displayValue,
  disabled = false,
  className,
  title,
  searchable = false,
  searchPlaceholder,
  emptyLabel,
  allowCustomValue = false,
  customOptionLabel,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220, maxHeight: 240 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const selected = options.find((option) => option.value === value)
  const selectedLabel = displayValue ?? selected?.label ?? placeholder ?? ''
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleOptions = normalizedSearch
    ? options.filter((option) => {
        const candidate =
          option.searchText ??
          (typeof option.label === 'string' ? `${option.label} ${option.value}` : option.value)
        return candidate.toLocaleLowerCase().includes(normalizedSearch)
      })
    : options
  const hasExactMatch = options.some((option) => {
    const label = typeof option.label === 'string' ? option.label : ''
    return (
      option.value.toLocaleLowerCase() === normalizedSearch ||
      label.toLocaleLowerCase() === normalizedSearch
    )
  })
  const showCustomOption =
    allowCustomValue && normalizedSearch.length >= 2 && !hasExactMatch

  const closeMenu = (restoreFocus = false) => {
    setOpen(false)
    setSearch('')
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(320, Math.max(220, rect.width), window.innerWidth - 16)
      const searchHeight = searchable ? 42 : 0
      const estimatedHeight = Math.min(
        280,
        Math.max(40, visibleOptions.length * 32 + searchHeight + 8),
      )
      const spaceBelow = window.innerHeight - rect.bottom - 8
      const spaceAbove = rect.top - 8
      const opensBelow = spaceBelow >= Math.min(estimatedHeight, 180) || spaceBelow >= spaceAbove
      const maxHeight = Math.max(96, Math.min(280, opensBelow ? spaceBelow : spaceAbove))
      const top = opensBelow ? rect.bottom + 5 : rect.top - maxHeight - 5
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      setPosition({ left, top: Math.max(8, top), width, maxHeight })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, searchable, visibleOptions.length])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeMenu()
      }
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu(true)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    const focusFrame = searchable
      ? window.requestAnimationFrame(() => searchRef.current?.focus())
      : null
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame)
    }
  }, [open, searchable])

  const choose = (nextValue: string) => {
    onChange(nextValue)
    closeMenu(true)
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen((current) => !current)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
    }
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const firstEnabled = visibleOptions.find((option) => !option.disabled)
    if (firstEnabled) choose(firstEnabled.value)
    else if (showCustomOption) choose(search.trim())
  }

  return (
    <div className={styles.root}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`${styles.trigger} ${className ?? ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
        onKeyDown={handleTriggerKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className={styles.triggerLabel}>{selectedLabel}</span>
        <ChevronDown className={styles.chevron} size={14} aria-hidden="true" />
      </button>
      {open && !disabled
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.menu}
              data-alethe-dropdown-menu=""
              style={{
                left: position.left,
                top: position.top,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {searchable ? (
                <div className={styles.searchBox}>
                  <Search size={13} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    className={styles.searchInput}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder ?? ariaLabel}
                  />
                </div>
              ) : null}
              <div className={styles.options} id={listboxId} role="listbox" aria-label={ariaLabel}>
                {visibleOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    className={`${styles.option} ${option.value === value ? styles.optionSelected : ''}`}
                    title={typeof option.label === 'string' ? option.label : undefined}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!option.disabled) choose(option.value)
                    }}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
                {showCustomOption ? (
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === search.trim()}
                    className={`${styles.option} ${styles.customOption}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      choose(search.trim())
                    }}
                  >
                    <span>{customOptionLabel?.(search.trim()) ?? search.trim()}</span>
                  </button>
                ) : null}
                {visibleOptions.length === 0 && !showCustomOption ? (
                  <div className={styles.empty} role="status">
                    {typeof emptyLabel === 'function' ? emptyLabel(search.trim()) : emptyLabel}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
