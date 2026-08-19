import { ChevronDown } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import styles from './Dropdown.module.css'

export type DropdownOption = {
  value: string
  label: ReactNode
  disabled?: boolean
}

type DropdownProps = {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: ReactNode
  disabled?: boolean
  className?: string
  title?: string
}

export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  className,
  title,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220, maxHeight: 240 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)
  const selectedLabel = selected?.label ?? placeholder ?? ''

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      // `window.innerWidth`/`innerHeight` divergem de onde o clique real
      // aterrissa quando o zoom nativo do WebView2 (`getCurrentWebview()
      // .setZoom()`, `App.tsx`) ou o escalonamento de DPI do Windows não é
      // exatamente 1:1 — bug real confirmado ao vivo (dono não conseguia
      // clicar na opção do menu de jeito nenhum, sempre interceptado por
      // outro elemento no mesmo ponto). `visualViewport` é a API feita
      // exatamente pra refletir o viewport que o navegador realmente usa
      // pra entrega de eventos de ponteiro nesses casos — cai pro `window`
      // só se `visualViewport` não existir (ambientes muito antigos).
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      const width = Math.min(320, Math.max(220, rect.width), viewportWidth - 16)
      const estimatedHeight = Math.min(240, Math.max(40, options.length * 32 + 8))
      const spaceBelow = viewportHeight - rect.bottom - 8
      const spaceAbove = rect.top - 8
      const opensBelow = spaceBelow >= Math.min(estimatedHeight, 180) || spaceBelow >= spaceAbove
      const maxHeight = Math.max(96, Math.min(240, opensBelow ? spaceBelow : spaceAbove))
      const top = opensBelow ? rect.bottom + 5 : rect.top - maxHeight - 5
      const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8))
      setPosition({ left, top: Math.max(8, top), width, maxHeight })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    window.visualViewport?.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      window.visualViewport?.removeEventListener('resize', updatePosition)
    }
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target))
        setOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('click', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('click', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const choose = (nextValue: string) => {
    onChange(nextValue)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen((current) => !current)
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
    }
  }

  return (
    <div className={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${className ?? ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
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
              role="listbox"
              aria-label={ariaLabel}
              style={{
                left: position.left,
                top: position.top,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {options.map((option) => (
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
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
