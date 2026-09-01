import * as Dialog from '@radix-ui/react-dialog'
import {
  Bot,
  BrainCircuit,
  Check,
  GitBranch,
  Globe,
  ListTodo,
  Network,
  Plug,
  Workflow,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { latestVersionFor } from '../../lib/agentVersions'
import { FEATURES } from '../../lib/features'
import { LOCALES, useT } from '../../lib/i18n'
import { DEFAULT_PROFILE_IMAGE_URL, getProfileInitial } from '../../lib/profile'
import { agentCliVersion, findCliLauncher } from '../../lib/tauri'
import { APP_ICON_OPTIONS, getThemeIcon } from '../../lib/themeIcons'
import { THEME_OPTIONS, themeDescription, themeLabel } from '../../lib/themes'
import { agentCliCommand, type AgentType, type VisualStyle } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ImageInput } from './ImageInput'
import { AgentsStep } from './onboarding/AgentsStep'
import styles from './OnboardingModal.module.css'

const STEP_COUNT = 5

const VISUAL_STYLES: VisualStyle[] = ['normal', 'clean']

const CLI_DETECTION_TIMEOUT_MS = 4000

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    const done = (value: T) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve(value)
    }
    promise.then(done).catch(() => done(fallback))
  })
}

type CodingAgent = Exclude<AgentType, 'shell'>

const AGENTS: { id: CodingAgent; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'freebuff', label: 'Freebuff' },
  { id: 'mimo', label: 'Mimo' },
]

const FEATURE_ICONS = {
  todos: ListTodo,
  git: GitBranch,
  browser: Globe,
  aiMemory: BrainCircuit,
  graphify: Network,
  mcp: Plug,
  playwright: Bot,
  orchestrator: Workflow,
} as const

export function OnboardingModal() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const setLanguage = useProjectsStore((s) => s.setLanguage)
  const setAgentEnabled = useProjectsStore((s) => s.setAgentEnabled)
  const setUiTheme = useProjectsStore((s) => s.setUiTheme)
  const openModal = useUiStore((s) => s.openModal_)

  const [step, setStep] = useState(0)
  const [name, setName] = useState(preferences.displayName)
  const [photoUrl, setPhotoUrl] = useState(preferences.profileImageUrl)
  const [showPhoto, setShowPhoto] = useState(Boolean(preferences.profileImageUrl.trim()))
  const [imgFailed, setImgFailed] = useState(false)
  const [agentAvailability, setAgentAvailability] = useState<Partial<Record<CodingAgent, boolean>>>(
    {},
  )
  const [detectingAgents, setDetectingAgents] = useState(true)
  const [agentVersions, setAgentVersions] = useState<Partial<Record<CodingAgent, string>>>({})
  const [agentLatest, setAgentLatest] = useState<Partial<Record<CodingAgent, string>>>({})
  const [agentPaths, setAgentPaths] = useState<Partial<Record<CodingAgent, string>>>({})
  const contentRef = useRef<HTMLDivElement | null>(null)
  const agentDetectionStartedRef = useRef(false)

  const trimmedName = name.trim()
  const trimmedPhotoUrl = photoUrl.trim()
  const initial = getProfileInitial(trimmedName)
  const previewAvatarUrl = trimmedPhotoUrl || DEFAULT_PROFILE_IMAGE_URL
  const isLast = step === STEP_COUNT - 1

  useEffect(() => {
    if (preferences.onboardingDone) return
    setStep(0)
    setName(preferences.displayName)
    setPhotoUrl(preferences.profileImageUrl)
    setShowPhoto(Boolean(preferences.profileImageUrl.trim()))
    setImgFailed(false)
  }, [preferences.displayName, preferences.onboardingDone, preferences.profileImageUrl])

  const detectAgents = useCallback(async () => {
    setDetectingAgents(true)
    const detected = await Promise.all(
      AGENTS.map(async (agent) => {
        const command = agentCliCommand(agent.id)
        if (!command) return [agent.id, null] as const
        try {
          const found = await withTimeout(findCliLauncher(command), CLI_DETECTION_TIMEOUT_MS, null)
          return [agent.id, found] as const
        } catch {
          return [agent.id, null] as const
        }
      }),
    )

    const availability = Object.fromEntries(
      detected.map(([id, path]) => [id, Boolean(path)]),
    ) as Record<CodingAgent, boolean>
    const resolvedPaths = Object.fromEntries(
      detected.filter(([, path]) => path).map(([id, path]) => [id, path as string]),
    ) as Partial<Record<CodingAgent, string>>

    setAgentAvailability(availability)
    setAgentPaths(resolvedPaths)
    setPreferences({
      enabledAgents: {
        ...useProjectsStore.getState().preferences.enabledAgents,
        shell: true,
      },
    })
    setDetectingAgents(false)

    // Versions and the registry lookup run after detection so the table is interactive first.
    const installed = AGENTS.filter((agent) => availability[agent.id])
    await Promise.all(
      installed.map(async (agent) => {
        const command = agentCliCommand(agent.id)
        if (!command) return
        const version = await withTimeout(
          agentCliVersion(command),
          CLI_DETECTION_TIMEOUT_MS,
          null,
        ).catch(() => null)
        if (version) setAgentVersions((current) => ({ ...current, [agent.id]: version }))
      }),
    )

    await Promise.all(
      installed.map(async (agent) => {
        const latest = await latestVersionFor(agent.id)
        if (latest) setAgentLatest((current) => ({ ...current, [agent.id]: latest }))
      }),
    )
  }, [setPreferences])

  useEffect(() => {
    if (preferences.onboardingDone || agentDetectionStartedRef.current) return
    agentDetectionStartedRef.current = true
    void detectAgents()
  }, [detectAgents, preferences.onboardingDone])

  useEffect(() => {
    const node = contentRef.current?.querySelector<HTMLElement>('[data-autofocus]')
    node?.focus()
  }, [step])

  if (preferences.onboardingDone) return null

  const canProceed = step === 0 ? trimmedName.length > 0 : true

  const finish = () => {
    if (!canProceed || trimmedName.length === 0) return
    setPreferences({
      accountCreated: true,
      onboardingDone: true,
      displayName: trimmedName,
      profileImageUrl: trimmedPhotoUrl,
    })

    useUiStore.getState().setActiveView('home')
    window.setTimeout(() => {
      openModal('newProject')
    }, 0)
  }

  const next = () => {
    if (!canProceed) return
    if (isLast) finish()
    else setStep((value) => value + 1)
  }

  const back = () => {
    setStep((value) => Math.max(0, value - 1))
  }

  return (
    <Dialog.Root open onOpenChange={() => undefined}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={contentRef}
          className={styles.content}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const node = contentRef.current?.querySelector<HTMLElement>('[data-autofocus]')
            node?.focus()
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className={styles.shell}>
            <section className={styles.main}>
              <header className={styles.mainHeader}>
                <div className={styles.compactBrand}>
                  <img
                    className={styles.brandLogo}
                    src={getThemeIcon(preferences.appIconTheme)}
                    alt="Alethe"
                    draggable={false}
                  />
                  <div>
                    <div className={styles.eyebrow}>{t('onboarding.kicker')}</div>
                    <h1 className={styles.headline}>{t('onboarding.title')}</h1>
                  </div>
                </div>
                <div className={styles.progressMeta}>
                  <div className={styles.progressStep}>
                    {t('onboarding.step', { current: step + 1, total: STEP_COUNT })}
                  </div>
                  <div className={styles.progressDots} aria-hidden>
                    {Array.from({ length: STEP_COUNT }, (_, index) => (
                      <span key={index} data-active={index <= step} />
                    ))}
                  </div>
                </div>
              </header>

              <div className={styles.stage}>
                <div key={step} className={styles.panel}>
                  {step === 0 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.profileTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.profileSubtitle')}</p>
                      </div>

                      <div className={styles.profileGrid}>
                        <div className={styles.previewCard}>
                          <div className={styles.avatarShell}>
                            <div className={styles.avatarFrame}>
                              {!imgFailed ? (
                                <img
                                  className={styles.avatarImg}
                                  src={previewAvatarUrl}
                                  alt=""
                                  draggable={false}
                                  onError={() => setImgFailed(true)}
                                  onLoad={() => setImgFailed(false)}
                                />
                              ) : (
                                <div className={styles.avatarInitial}>{initial}</div>
                              )}
                            </div>
                          </div>

                          <div className={styles.previewText}>
                            <div className={styles.previewName}>
                              {trimmedName || t('onboarding.namePlaceholder')}
                            </div>
                            <div className={styles.previewHint}>
                              {t('onboarding.profilePreviewHint')}
                            </div>
                          </div>
                        </div>

                        <div className={styles.formCard}>
                          <div className={styles.field}>
                            <div className={styles.fieldLabel}>
                              <Globe size={12} style={{ verticalAlign: '-2px' }} />{' '}
                              {t('language.title')}
                            </div>
                            <div className={styles.languageGrid}>
                              {LOCALES.map((locale) => {
                                const active = preferences.language === locale.id
                                return (
                                  <button
                                    key={locale.id}
                                    type="button"
                                    className={[
                                      styles.languageCard,
                                      active ? styles.languageCardActive : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' ')}
                                    onClick={() => setLanguage(locale.id)}
                                  >
                                    <span className={styles.languageCardBody}>
                                      <span className={styles.languageCardTitle}>
                                        {locale.nativeName}
                                      </span>
                                      <span className={styles.languageCardMeta}>
                                        {locale.id === 'en'
                                          ? t('onboarding.languageEnglishHint')
                                          : t('onboarding.languagePortugueseHint')}
                                      </span>
                                    </span>
                                    {active ? (
                                      <Check size={16} className={styles.checkMark} />
                                    ) : null}
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          <div className={styles.field}>
                            <label className={styles.fieldLabel} htmlFor="onboarding-name">
                              {t('onboarding.name')}
                            </label>
                            <input
                              id="onboarding-name"
                              data-autofocus
                              className={styles.input}
                              value={name}
                              onChange={(event) => setName(event.target.value)}
                              placeholder={t('onboarding.namePlaceholder')}
                              maxLength={60}
                            />
                            <div className={styles.inputHint}>{t('onboarding.nameHint')}</div>
                          </div>

                          <div className={styles.field}>
                            <div className={styles.toggleRow}>
                              <div className={styles.fieldLabel}>{t('onboarding.photoTitle')}</div>
                              <button
                                type="button"
                                className={styles.toggleButton}
                                onClick={() => setShowPhoto((value) => !value)}
                              >
                                {showPhoto ? t('onboarding.photoHide') : t('onboarding.photoShow')}
                              </button>
                            </div>
                            <div className={styles.inputHint}>{t('onboarding.photoHint')}</div>
                            {showPhoto ? (
                              <ImageInput
                                label={t('prefs.photoPlaceholder')}
                                value={photoUrl}
                                onChange={(value) => {
                                  setPhotoUrl(value)
                                  setImgFailed(false)
                                }}
                                placeholder="https://..."
                                hint={t('image.urlOrUpload')}
                              />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {step === 1 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.themeTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.themeSubtitle')}</p>
                      </div>

                      <div className={styles.themeGrid}>
                        {THEME_OPTIONS.map((theme) => {
                          const active = preferences.uiTheme === theme.id
                          const [bg, accent, highlight] = theme.colors
                          return (
                            <button
                              key={theme.id}
                              type="button"
                              className={[
                                styles.themeOption,
                                active ? styles.themeOptionActive : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() => setUiTheme(theme.id)}
                              data-autofocus={active ? 'true' : undefined}
                            >
                              <div className={styles.themeSwatches}>
                                <span style={{ background: bg }} />
                                <span style={{ background: accent }} />
                                <span style={{ background: highlight }} />
                              </div>
                              <div className={styles.themeOptionBody}>
                                <div className={styles.themeOptionTitle}>
                                  <span>{themeLabel(t, theme.id)}</span>
                                  {active ? <Check size={15} className={styles.checkMark} /> : null}
                                </div>
                                <div className={styles.themeOptionDesc}>
                                  {themeDescription(t, theme.id)}
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>

                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.appIconTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.appIconSubtitle')}</p>
                      </div>

                      <div className={styles.iconGrid}>
                        {APP_ICON_OPTIONS.map((icon) => {
                          const active = preferences.appIconTheme === icon.id
                          return (
                            <button
                              key={icon.id}
                              type="button"
                              className={[styles.iconOption, active ? styles.iconOptionActive : '']
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() => setPreferences({ appIconTheme: icon.id })}
                            >
                              <img
                                className={styles.iconThumb}
                                src={getThemeIcon(icon.id, 64)}
                                alt=""
                                draggable={false}
                              />
                              <span className={styles.iconOptionLabel}>{icon.label}</span>
                              {active ? <Check size={14} className={styles.checkMark} /> : null}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : null}

                  {step === 2 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.visualStyleTitle')}</h2>
                        <p className={styles.sectionSubtitle}>
                          {t('onboarding.visualStyleSubtitle')}
                        </p>
                      </div>

                      <div className={styles.visualStyleGrid}>
                        {VISUAL_STYLES.map((visualStyle) => {
                          const active = (preferences.visualStyle ?? 'normal') === visualStyle
                          const clean = visualStyle === 'clean'
                          return (
                            <button
                              key={visualStyle}
                              type="button"
                              className={[
                                styles.visualStyleOption,
                                active ? styles.visualStyleActive : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() => setPreferences({ visualStyle })}
                              aria-pressed={active}
                              data-autofocus={active ? 'true' : undefined}
                            >
                              <span
                                className={[
                                  styles.visualStylePreview,
                                  clean
                                    ? styles.visualStylePreviewClean
                                    : styles.visualStylePreviewNormal,
                                ].join(' ')}
                                aria-hidden
                              >
                                <span className={styles.previewToolbar} />
                                <span className={styles.previewSidebar}>
                                  <span />
                                  <span />
                                  <span />
                                </span>
                                <span className={styles.previewWorkspace}>
                                  <span />
                                  <span />
                                </span>
                              </span>
                              <span className={styles.visualStyleCopy}>
                                <strong>
                                  {t(clean ? 'prefs.visualStyleClean' : 'prefs.visualStyleNormal')}
                                </strong>
                                <small>
                                  {t(
                                    clean
                                      ? 'prefs.visualStyleCleanDesc'
                                      : 'prefs.visualStyleNormalDesc',
                                  )}
                                </small>
                              </span>
                              {active ? <Check size={15} className={styles.checkMark} /> : null}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : null}

                  {step === 3 ? (
                    <AgentsStep
                      agents={AGENTS}
                      availability={agentAvailability}
                      versions={agentVersions}
                      latest={agentLatest}
                      paths={agentPaths}
                      enabled={preferences.enabledAgents}
                      detecting={detectingAgents}
                      terminalTheme={preferences.terminalTheme ?? preferences.uiTheme}
                      onToggle={(id, value) => setAgentEnabled(id, value)}
                      onRescan={() => void detectAgents()}
                      onInstalled={(id) => {
                        setAgentAvailability((current) => ({ ...current, [id]: true }))
                        setAgentEnabled(id, true)
                        void detectAgents()
                      }}
                      onUninstalled={(id) => {
                        setAgentAvailability((current) => ({ ...current, [id]: false }))
                        setAgentVersions((current) => ({ ...current, [id]: undefined }))
                        setAgentEnabled(id, false)
                      }}
                    />
                  ) : null}

                  {step === 4 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.featuresTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.featuresSubtitle')}</p>
                      </div>
                      <div className={styles.agentGrid}>
                        {FEATURES.map((feature) => {
                          const active = preferences.enabledFeatures[feature.id]
                          const FeatureIcon = FEATURE_ICONS[feature.id]
                          return (
                            <button
                              key={feature.id}
                              type="button"
                              className={[
                                styles.agentOption,
                                active ? styles.agentOptionActive : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() =>
                                setPreferences({
                                  enabledFeatures: {
                                    ...preferences.enabledFeatures,
                                    [feature.id]: !active,
                                  },
                                  ...(feature.id === 'todos' && !active
                                    ? { rightSidebarVisible: true }
                                    : {}),
                                })
                              }
                              data-autofocus={active ? 'true' : undefined}
                            >
                              <div className={styles.agentIconWrap}>
                                <FeatureIcon size={20} />
                              </div>
                              <div className={styles.agentOptionBody}>
                                <div className={styles.agentNameRow}>
                                  <span className={styles.agentName}>{t(feature.titleKey)}</span>
                                  {active ? <Check size={15} className={styles.checkMark} /> : null}
                                </div>
                                <div className={styles.agentDesc}>{t(feature.descriptionKey)}</div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              <footer className={styles.footer}>
                <div className={styles.footerLeft}>{t('onboarding.footerNote')}</div>
                <div className={styles.footerActions}>
                  {step > 0 ? (
                    <button
                      type="button"
                      className={`${styles.button} ${styles.buttonSecondary}`}
                      onClick={back}
                    >
                      {t('common.back')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    onClick={next}
                    disabled={!canProceed}
                  >
                    {isLast ? t('onboarding.finish') : t('common.next')}
                  </button>
                </div>
              </footer>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
