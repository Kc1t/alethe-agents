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
  // The option the keyboard would choose; -1 leaves it on the first one that can be chosen.
  const [activeIndex, setActiveIndex] = useState(-1)
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
  const showCustomOption = allowCustomValue && normalizedSearch.length >= 2 && !hasExactMatch
  // Everything the list shows, in order, so the keyboard walks the custom entry like any other.
  const items = [
    ...visibleOptions.map((option) => ({
      value: option.value,
      disabled: Boolean(option.disabled),
    })),
    ...(showCustomOption ? [{ value: search.trim(), disabled: false }] : []),
  ]
  const firstEnabled = items.findIndex((item) => !item.disabled)
  const active = items[activeIndex] && !items[activeIndex].disabled ? activeIndex : firstEnabled
  const optionId = (index: number) => `${listboxId}-option-${index}`

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
      // As wide as its trigger, like a native select, and never narrower than a readable list.
      const width = Math.min(Math.max(220, rect.width), window.innerWidth - 16)
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
    // A modal dialog traps focus: it listens on the document and pulls focus back when it lands
    // outside the dialog's own DOM. The menu is portaled out of that DOM, so its focus events
    // stop here, before the trap sees them; otherwise the search field could never be typed in.
    const menu = menuRef.current
    const trigger = triggerRef.current
    const stopFocusEvent = (event: FocusEvent) => event.stopPropagation()
    const stopFocusIntoMenu = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && menu?.contains(event.relatedTarget)) {
        event.stopPropagation()
      }
    }
    menu?.addEventListener('focusin', stopFocusEvent)
    menu?.addEventListener('focusout', stopFocusEvent)
    trigger?.addEventListener('focusout', stopFocusIntoMenu)
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    const focusFrame = searchable
      ? window.requestAnimationFrame(() => searchRef.current?.focus())
      : null
    return () => {
      menu?.removeEventListener('focusin', stopFocusEvent)
      menu?.removeEventListener('focusout', stopFocusEvent)
      trigger?.removeEventListener('focusout', stopFocusIntoMenu)
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame)
    }
  }, [open, searchable])

  // The list opens on the current value, the way a native select does.
  useEffect(() => {
    if (open) setActiveIndex(options.findIndex((option) => option.value === value))
    // Only the moment it opens matters: the active option then follows the keys and the pointer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || active < 0) return
    // Optional call: the test environment's DOM has no scrollIntoView.
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active])

  // Choosing what is already chosen changes nothing, as with a native select.
  const choose = (nextValue: string) => {
    if (nextValue !== value) onChange(nextValue)
    closeMenu(true)
  }

  const moveActive = (step: 1 | -1) => {
    if (firstEnabled < 0) return
    let next = active
    for (let tries = 0; tries < items.length; tries++) {
      next = (next + step + items.length) % items.length
      if (!items[next].disabled) break
    }
    setActiveIndex(next)
  }

  /** The keys the open list answers to, wherever the focus is. Returns whether it took the key. */
  const handleListKey = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return true
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (active >= 0) choose(items[active].value)
      return true
    }
    if (event.key === 'Tab') {
      // The list is going away. From the trigger, focus simply moves on; from the search field
      // it goes back to the trigger first, since the field goes away with the list.
      if (event.currentTarget === triggerRef.current) {
        closeMenu()
      } else {
        event.preventDefault()
        closeMenu(true)
      }
      return true
    }
    return false
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault()
        setOpen(true)
      }
      return
    }
    if (handleListKey(event)) return
    if (event.key === ' ') {
      event.preventDefault()
      if (active >= 0) choose(items[active].value)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const enabled = items.flatMap((item, index) => (item.disabled ? [] : [index]))
      if (enabled.length > 0) {
        setActiveIndex(event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1])
      }
    }
  }

  return (
    <div className={styles.root}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`${styles.trigger} ${className ?? styles.triggerSized}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-activedescendant={open && !searchable && active >= 0 ? optionId(active) : undefined}
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
              // A modal dialog locks scrolling outside its own DOM, which is where this list is:
              // kept from the document, the wheel and a touch drag scroll a long list again.
              onWheel={(event) => event.stopPropagation()}
              onTouchMove={(event) => event.stopPropagation()}
            >
              {searchable ? (
                <div className={styles.searchBox}>
                  <Search size={13} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    className={styles.searchInput}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value)
                      setActiveIndex(-1)
                    }}
                    onKeyDown={handleListKey}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder ?? ariaLabel}
                    aria-controls={listboxId}
                    aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                  />
                </div>
              ) : null}
              <div className={styles.options} id={listboxId} role="listbox" aria-label={ariaLabel}>
                {visibleOptions.map((option, index) => (
                  <button
                    key={option.value}
                    id={optionId(index)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    className={`${styles.option} ${option.value === value ? styles.optionSelected : ''} ${index === active ? styles.optionActive : ''}`}
                    title={typeof option.label === 'string' ? option.label : undefined}
                    // Movement, not entry: a list scrolled by the keys must not hand the active
                    // option to whatever ends up under a pointer that never moved.
                    onMouseMove={() => {
                      if (!option.disabled && index !== active) setActiveIndex(index)
                    }}
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
                    id={optionId(visibleOptions.length)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={value === search.trim()}
                    className={`${styles.option} ${styles.customOption} ${visibleOptions.length === active ? styles.optionActive : ''}`}
                    onMouseMove={() => {
                      if (visibleOptions.length !== active) setActiveIndex(visibleOptions.length)
                    }}
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
