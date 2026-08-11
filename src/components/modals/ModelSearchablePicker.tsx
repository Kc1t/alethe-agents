import { ChevronDown, Search, Check, Sparkles } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

import styles from './ModelSearchablePicker.module.css'

export type ModelOption = {
  id: string
  label: string
}

export type ModelSearchablePickerProps = {
  value: string
  onChange: (modelId: string) => void
  options: ModelOption[]
  loading?: boolean
  providerName: string
}

export function ModelSearchablePicker({
  value,
  onChange,
  options,
  loading,
  providerName,
}: ModelSearchablePickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Limpa e valida modelos invalidos provenientes de mensagens de erro/ajuda
  const cleanOptions = options.filter(
    (opt) =>
      opt.id &&
      !opt.id.startsWith('-') &&
      !opt.id.startsWith('#') &&
      !opt.id.toLowerCase().startsWith('could') &&
      !opt.id.toLowerCase().startsWith('usage') &&
      !opt.id.toLowerCase().startsWith('error') &&
      !opt.id.toLowerCase().startsWith('let') &&
      opt.id.length >= 3,
  )

  // Seleção atual (preserva o valor ativo mesmo que ele não esteja em cleanOptions ainda)
  const selected = value
    ? (cleanOptions.find((opt) => opt.id === value) ?? { id: value, label: value })
    : cleanOptions[0]

  // Filtro de modelos por busca
  const trimmedSearch = search.trim()
  const filteredOptions = cleanOptions.filter(
    (opt) =>
      opt.label.toLowerCase().includes(trimmedSearch.toLowerCase()) ||
      opt.id.toLowerCase().includes(trimmedSearch.toLowerCase()),
  )

  // Verifica se a busca traz um modelo customizado não presente na lista
  const hasExactMatch = cleanOptions.some(
    (opt) =>
      opt.id.toLowerCase() === trimmedSearch.toLowerCase() ||
      opt.label.toLowerCase() === trimmedSearch.toLowerCase(),
  )
  const showCustomOption = trimmedSearch.length >= 2 && !hasExactMatch

  const selectOption = (modelId: string) => {
    onChange(modelId)
    setOpen(false)
    setSearch('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredOptions.length > 0) {
        selectOption(filteredOptions[0].id)
      } else if (showCustomOption) {
        selectOption(trimmedSearch)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  // Fecha o dropdown se clicar fora
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className={styles.wrapper} ref={containerRef}>
      {/* Botão Seletor Principal */}
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerActive : ''}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Sparkles size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
          <span className={styles.triggerText}>
            {loading && cleanOptions.length === 0
              ? 'Carregando modelos do CLI...'
              : selected
                ? `${selected.label}`
                : `Selecione um modelo (${providerName})`}
          </span>
        </span>
        <ChevronDown size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>

      {/* Popover Rolável com Barra de Pesquisa */}
      {open && (
        <div className={styles.dropdown}>
          {/* Caixa de Busca */}
          <div className={styles.searchBox}>
            <Search size={13} color="var(--fg-muted)" />
            <input
              type="text"
              placeholder={`Pesquisar entre ${options.length} modelos de ${providerName}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </div>

          {/* Lista de Opções Rolável (Max Height 180px) */}
          <div className={styles.optionsList}>
            {filteredOptions.length === 0 && !showCustomOption ? (
              <div className={styles.emptyState}>Nenhum modelo encontrado para "{search}"</div>
            ) : (
              <>
                {filteredOptions.map((opt) => {
                  const isSelected = opt.id === (selected?.id ?? value)
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`${styles.optionItem} ${isSelected ? styles.optionItemActive : ''}`}
                      onClick={() => selectOption(opt.id)}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ fontWeight: isSelected ? 600 : 400 }}>{opt.label}</span>
                        <span className={styles.modelId}>{opt.id}</span>
                      </div>
                      {isSelected ? <Check size={14} color="var(--accent)" /> : null}
                    </button>
                  )
                })}

                {showCustomOption && (
                  <button
                    type="button"
                    className={styles.optionItem}
                    onClick={() => selectOption(trimmedSearch)}
                    style={{ borderTop: '1px dashed var(--border)', marginTop: 4, paddingTop: 6 }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: 'var(--accent)' }}>
                        Usar modelo customizado: "{trimmedSearch}"
                      </span>
                      <span className={styles.modelId}>{trimmedSearch}</span>
                    </div>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
