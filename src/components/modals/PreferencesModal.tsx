import * as Dialog from '@radix-ui/react-dialog'
import {
  Activity,
  Archive,
  Blocks,
  ChevronRight,
  Info,
  Palette,
  ShieldCheck,
  Plug,
  Search,
  TerminalSquare,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ErrorBoundary } from '../ErrorBoundary'
import { AboutPage } from './preferences/AboutPage'
import { AccountPage } from './preferences/AccountPage'
import { AppearancePage } from './preferences/AppearancePage'
import { FeaturesPage } from './preferences/FeaturesPage'
import { IntegrationsPage } from './preferences/IntegrationsPage'
import { MultiagentPage } from './preferences/MultiagentPage'
import { OrganizationPage } from './preferences/OrganizationPage'
import { TerminalPage } from './preferences/TerminalPage'
import { RemoteControlPage } from './preferences/RemoteControlPage'
import { Avatar } from './preferences/primitives'
import styles from './PreferencesModal.module.css'

type CategoryId =
  | 'account'
  | 'appearance'
  | 'features'
  | 'terminal'
  | 'integrations'
  | 'multiagent'
  | 'organization'
  | 'about'
  | 'remoteControl'

type Category = {
  id: CategoryId
  label: string
  description: string
  Icon: LucideIcon
}

type SearchItem = {
  category: CategoryId
  target: string
  label: string
  description: string
  keywords: string
}

export function PreferencesModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'preferences')
  const closeModal = useUiStore((state) => state.closeModal)
  const openModal = useUiStore((state) => state.openModal_)
  const modalContext = useUiStore((state) => state.modalContext)
  const preferences = useProjectsStore((state) => state.preferences)
  const [category, setCategory] = useState<CategoryId>('account')
  const [query, setQuery] = useState('')
  const [resultCursor, setResultCursor] = useState(0)
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const categories = useMemo<Category[]>(
    () => [
      {
        id: 'account',
        label: t('prefs.categoryAccount'),
        description: t('prefs.categoryAccountDesc'),
        Icon: UserRound,
      },
      {
        id: 'organization',
        label: t('prefs.categoryOrganization'),
        description: t('prefs.categoryOrganizationDesc'),
        Icon: Archive,
      },
      {
        id: 'appearance',
        label: t('prefs.categoryAppearance'),
        description: t('prefs.categoryAppearanceDesc'),
        Icon: Palette,
      },
      {
        id: 'remoteControl',
        label: t('prefs.categoryRemoteControl'),
        description: t('prefs.categoryRemoteControlDesc'),
        Icon: ShieldCheck,
      },
      {
        id: 'features',
        label: t('prefs.features'),
        description: t('prefs.featuresDesc'),
        Icon: Blocks,
      },
      {
        id: 'terminal',
        label: t('prefs.categoryTerminal'),
        description: t('prefs.categoryTerminalDesc'),
        Icon: TerminalSquare,
      },
      {
        id: 'integrations',
        label: t('prefs.categoryIntegrations'),
        description: t('prefs.categoryIntegrationsDesc'),
        Icon: Plug,
      },
      {
        id: 'multiagent',
        label: 'Multi-Agent & Telemetry',
        description: 'Real-time metrics, event traces, and structured logs.',
        Icon: Activity,
      },
      {
        id: 'about',
        label: t('prefs.categoryAbout'),
        description: t('prefs.categoryAboutDesc'),
        Icon: Info,
      },
    ],
    [t],
  )

  const searchItems = useMemo<SearchItem[]>(
    () => [
      {
        category: 'account',
        target: 'profile',
        label: t('prefs.profile'),
        description: t('prefs.profileDesc'),
        keywords: 'avatar photo name nome perfil account conta',
      },
      {
        category: 'account',
        target: 'language',
        label: t('prefs.language'),
        description: t('prefs.languageDesc'),
        keywords: 'language idioma português english',
      },
      {
        category: 'account',
        target: 'local-accounts',
        label: t('prefs.localAccounts'),
        description: t('prefs.localAccountsDesc'),
        keywords: 'account profile conta perfil local switch trocar',
      },
      {
        category: 'appearance',
        target: 'ui-theme',
        label: t('prefs.uiTheme'),
        description: t('prefs.uiThemeDesc'),
        keywords: 'theme tema colors cores light dark claro escuro',
      },
      {
        category: 'remoteControl',
        target: 'remote-status',
        label: t('remote.settingsStatusTitle'),
        description: t('remote.settingsStatusDesc'),
        keywords: 'remote control lan security qr device mobile celular segurança pareamento',
      },
      {
        category: 'organization',
        target: 'archived-groups',
        label: t('prefs.categoryOrganization'),
        description: t('prefs.categoryOrganizationDesc'),
        keywords: 'archive archived groups grupo arquivado restaurar restore',
      },
      {
        category: 'appearance',
        target: 'ui-zoom',
        label: t('prefs.uiZoom'),
        description: t('prefs.uiZoomDesc'),
        keywords: 'zoom scale escala tamanho interface',
      },
      {
        category: 'appearance',
        target: 'window-opacity',
        label: t('prefs.windowOpacity'),
        description: t('prefs.windowOpacityDesc'),
        keywords: 'opacity opacidade transparency transparência desktop window janela',
      },
      {
        category: 'appearance',
        target: 'topbar-style',
        label: t('prefs.topbarStyle'),
        description: t('prefs.topbarStyleDesc'),
        keywords: 'topbar barra superior layout areas tabs sidebar',
      },
      {
        category: 'appearance',
        target: 'git-control-placement',
        label: t('prefs.gitControlPlacement'),
        description: t('prefs.gitControlPlacementDesc'),
        keywords: 'git source control sidebar esquerda direita left right',
      },
      {
        category: 'features',
        target: 'optional-features',
        label: t('prefs.features'),
        description: t('prefs.featuresDesc'),
        keywords: 'features recursos modules módulos todo task tarefa git source control sidebar',
      },
      {
        category: 'appearance',
        target: 'terminal-theme',
        label: t('prefs.terminalTheme'),
        description: t('prefs.terminalThemeDesc'),
        keywords: 'terminal theme tema colors cores',
      },
      {
        category: 'terminal',
        target: 'resource-policy',
        label: t('prefs.resourcePolicy'),
        description: t('prefs.resourcePolicyDesc'),
        keywords: 'memory ram performance budget limit lru suspend memória desempenho limite',
      },
      {
        category: 'terminal',
        target: 'spawn-concurrency',
        label: t('prefs.spawnConcurrency'),
        description: t('prefs.spawnConcurrencyDesc'),
        keywords: 'spawn concurrency parallel paralelo fila queue performance pty',
      },
      {
        category: 'terminal',
        target: 'agents',
        label: t('prefs.agentsTitle'),
        description: t('prefs.agentsDesc'),
        keywords: 'agents agentes claude codex opencode shell',
      },
      {
        category: 'terminal',
        target: 'reset-session',
        label: t('prefs.resetSession'),
        description: t('prefs.resetSessionDesc'),
        keywords:
          'reset session resume retomar resetar sessão última last recover recuperar resume crash boot',
      },
      {
        category: 'integrations',
        target: 'terminal-command',
        label: t('prefs.cliCommand'),
        description: t('prefs.cliCommandDesc'),
        keywords: 'cli command terminal path shell comando linha de comando abrir pasta',
      },
      {
        category: 'integrations',
        target: 'spotify',
        label: t('prefs.spotify'),
        description: t('prefs.spotifyDesc'),
        keywords: 'spotify music música client id secret',
      },
      {
        category: 'integrations',
        target: 'discord',
        label: t('prefs.discordPresence'),
        description: t('prefs.discordPresenceHint'),
        keywords: 'discord rich presence status integração',
      },
      {
        category: 'integrations',
        target: 'dictation',
        label: t('prefs.dictation'),
        description: t('prefs.dictationDesc'),
        keywords: 'dictation voice mic microphone ditado voz microfone handy speech',
      },
      {
        category: 'about',
        target: 'app-version',
        label: t('prefs.aboutVersionTitle'),
        description: t('prefs.aboutVersionDesc'),
        keywords: 'version versão about sobre build info app',
      },
      {
        category: 'about',
        target: 'app-updates',
        label: t('prefs.aboutUpdatesTitle'),
        description: t('prefs.aboutUpdatesDesc'),
        keywords: 'update atualização atualizar upgrade nova versão release check',
      },
    ],
    [t],
  )

  useEffect(() => {
    if (!open || modalContext?.category !== 'remoteControl') return
    setCategory('remoteControl')
  }, [open, modalContext])

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(preferences.language)
    if (!normalized) return []
    return searchItems.filter((item) =>
      `${item.label} ${item.description} ${item.keywords}`
        .toLocaleLowerCase(preferences.language)
        .includes(normalized),
    )
  }, [preferences.language, query, searchItems])

  const activeCategory = categories.find((item) => item.id === category) ?? categories[0]
  const avatarUrl = getProfileImageUrl(preferences)
  const displayName = preferences.displayName || t('profile.fallbackName')
  const initial = getProfileInitial(displayName)
  const enabledCount = Object.values(preferences.enabledAgents).filter(Boolean).length

  useEffect(() => {
    if (!open) return
    const initial = (modalContext?.category as CategoryId) ?? 'account'
    setCategory(initial)
    setQuery('')
    setResultCursor(0)
    setPendingTarget(null)
  }, [open, modalContext])

  useEffect(() => {
    setResultCursor(0)
  }, [query])

  useEffect(() => {
    if (!pendingTarget) return
    const frame = window.requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(
        `[data-setting-id="${pendingTarget}"]`,
      )
      target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      target?.focus({ preventScroll: true })
      setPendingTarget(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [category, pendingTarget])

  const openSearchResult = (item: SearchItem) => {
    setCategory(item.category)
    setPendingTarget(item.target)
    setQuery('')
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setResultCursor((cursor) => (cursor + 1) % results.length)
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setResultCursor((cursor) => (cursor - 1 + results.length) % results.length)
    } else if (event.key === 'Enter' && results[resultCursor]) {
      event.preventDefault()
      openSearchResult(results[resultCursor])
    } else if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && open && closeModal()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={dialogRef}
          className={styles.dialog}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const input =
              dialogRef.current?.querySelector<HTMLInputElement>('[data-settings-search]')
            input?.focus()
          }}
        >
          <Dialog.Title className={styles.srOnly}>{t('prefs.title')}</Dialog.Title>

          <aside className={styles.sidebar}>
            <button
              type="button"
              className={styles.profileButton}
              onClick={() => setCategory('account')}
            >
              <Avatar url={avatarUrl} initial={initial} />
              <span className={styles.profileCopy}>
                <strong>{displayName}</strong>
                <span>{t('prefs.editProfile')}</span>
              </span>
              <ChevronRight size={14} />
            </button>

            <div className={styles.searchWrap}>
              <Search size={15} aria-hidden />
              <input
                data-settings-search
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={t('prefs.searchPlaceholder')}
                aria-label={t('prefs.searchPlaceholder')}
                aria-expanded={Boolean(query)}
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={t('prefs.clearSearch')}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>

            {query ? (
              <div className={styles.searchResults} role="listbox">
                {results.length > 0 ? (
                  results.map((item, index) => (
                    <button
                      key={`${item.category}:${item.target}`}
                      type="button"
                      role="option"
                      aria-selected={index === resultCursor}
                      className={index === resultCursor ? styles.searchResultActive : undefined}
                      onMouseEnter={() => setResultCursor(index)}
                      onClick={() => openSearchResult(item)}
                    >
                      <strong>{item.label}</strong>
                      <span>{categories.find((entry) => entry.id === item.category)?.label}</span>
                    </button>
                  ))
                ) : (
                  <div className={styles.searchEmpty}>{t('prefs.noSearchResults')}</div>
                )}
              </div>
            ) : (
              <nav className={styles.nav} aria-label={t('prefs.title')}>
                <span className={styles.navLabel}>{t('prefs.settingsLabel')}</span>
                {categories.map(({ id, label, description, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    className={category === id ? styles.navActive : undefined}
                    aria-current={category === id ? 'page' : undefined}
                    onClick={() => {
                      setCategory(id)
                      contentRef.current?.scrollTo({ top: 0 })
                    }}
                  >
                    <Icon size={16} />
                    <span className={styles.navCopy}>
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                  </button>
                ))}
              </nav>
            )}
          </aside>

          <main className={styles.main}>
            <header className={styles.header}>
              <div>
                <h1>{activeCategory.label}</h1>
                <p>{activeCategory.description}</p>
              </div>
              <Dialog.Close asChild>
                <button type="button" className={styles.close} aria-label={t('common.close')}>
                  <X size={18} />
                </button>
              </Dialog.Close>
            </header>

            <div ref={contentRef} className={styles.content}>
              <div className={styles.contentInner}>
                <ErrorBoundary label="preferences-page">
                {category === 'account' ? (
                  <AccountPage
                    avatarUrl={avatarUrl}
                    initial={initial}
                    onManageAccounts={() => openModal('profiles')}
                  />
                ) : null}
                {category === 'appearance' ? <AppearancePage /> : null}
                {category === 'features' ? <FeaturesPage /> : null}
                {category === 'terminal' ? <TerminalPage enabledCount={enabledCount} /> : null}
                {category === 'integrations' ? <IntegrationsPage /> : null}
                {category === 'multiagent' ? <MultiagentPage /> : null}
                {category === 'organization' ? <OrganizationPage /> : null}
                {category === 'about' ? <AboutPage /> : null}
                {category === 'remoteControl' ? <RemoteControlPage /> : null}
                </ErrorBoundary>
              </div>
            </div>
          </main>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
