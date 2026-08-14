import * as Dialog from '@radix-ui/react-dialog'
import { BrainCircuit, Check, GitBranch, Globe, ListTodo, Network } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import aletheLogo from '../../assets/alethe-logo.png'
import { FEATURES } from '../../lib/features'
import { LOCALES, useT } from '../../lib/i18n'
import { DEFAULT_PROFILE_IMAGE_URL, getProfileInitial } from '../../lib/profile'
import { findCliLauncher, renameProfile } from '../../lib/tauri'
import { THEME_OPTIONS, themeDescription, themeLabel } from '../../lib/themes'
import { agentCliCommand, type AgentType } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import { ImageInput } from './ImageInput'
import styles from './OnboardingModal.module.css'

const STEP_COUNT = 4

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
} as const

export function OnboardingModal() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const setLanguage = useProjectsStore((s) => s.setLanguage)
  const setAgentEnabled = useProjectsStore((s) => s.setAgentEnabled)
  const setUiTheme = useProjectsStore((s) => s.setUiTheme)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)
  const profiles = useProjectsStore((s) => s.profiles)
  const flushPersistence = useProjectsStore((s) => s.flushPersistence)
  const openModal = useUiStore((s) => s.openModal_)
  const pushToast = useUiStore((s) => s.pushToast)

  const [step, setStep] = useState(0)
  const [name, setName] = useState(preferences.displayName)
  const [photoUrl, setPhotoUrl] = useState(preferences.profileImageUrl)
  const [showPhoto, setShowPhoto] = useState(Boolean(preferences.profileImageUrl.trim()))
  const [imgFailed, setImgFailed] = useState(false)
  const [agentAvailability, setAgentAvailability] = useState<Partial<Record<CodingAgent, boolean>>>(
    {},
  )
  const [detectingAgents, setDetectingAgents] = useState(true)
  const [finishing, setFinishing] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const agentDetectionStartedRef = useRef(false)

  const enabledCount = AGENTS.filter((agent) => preferences.enabledAgents[agent.id]).length
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

  useEffect(() => {
    if (preferences.onboardingDone || agentDetectionStartedRef.current) return
    agentDetectionStartedRef.current = true

    const detectAgents = async () => {
      const detected = await Promise.all(
        AGENTS.map(async (agent) => {
          const command = agentCliCommand(agent.id)
          if (!command) return [agent.id, false] as const
          try {
            const found = await withTimeout(
              findCliLauncher(command),
              CLI_DETECTION_TIMEOUT_MS,
              null,
            )
            return [agent.id, Boolean(found)] as const
          } catch {
            return [agent.id, false] as const
          }
        }),
      )

      const availability = Object.fromEntries(detected) as Record<CodingAgent, boolean>
      setAgentAvailability(availability)
      setPreferences({
        enabledAgents: {
          ...preferences.enabledAgents,
          shell: true,
        },
      })
      setDetectingAgents(false)
    }

    void detectAgents()
  }, [preferences.enabledAgents, preferences.onboardingDone, setPreferences])

  useEffect(() => {
    const node = contentRef.current?.querySelector<HTMLElement>('[data-autofocus]')
    node?.focus()
  }, [step])

  if (preferences.onboardingDone) return null

  const canProceed = step === 0 ? trimmedName.length > 0 : true

  const finish = async () => {
    if (!canProceed || trimmedName.length === 0) return
    setFinishing(true)
    try {
      const activeProfile = profiles.find((profile) => profile.id === activeProfileId)
      if (activeProfileId === 'default' && activeProfile?.name === 'Default') {
        await renameProfile(activeProfileId, trimmedName)
      }
    } catch (error) {
      setFinishing(false)
      pushToast({
        title: t('onboarding.profileSaveErrorTitle'),
        body: t('onboarding.profileSaveErrorBody', { error: String(error) }),
      })
      return
    }
    setPreferences({
      accountCreated: true,
      onboardingDone: true,
      displayName: trimmedName,
      profileImageUrl: trimmedPhotoUrl,
    })
    await flushPersistence().catch(() => {
      // The global persistence status retains and retries this local state.
    })
    // The first useful screen after onboarding is Home. Project creation
    // opens over it without exposing an empty workspace in between.
    useUiStore.getState().setActiveView('home')
    window.setTimeout(() => {
      openModal('newProject')
    }, 0)
  }

  const next = () => {
    if (!canProceed) return
    if (isLast) void finish()
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
                    src={aletheLogo}
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
                    </>
                  ) : null}

                  {step === 2 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.agentsTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.agentsSubtitle')}</p>
                      </div>

                      <div className={styles.agentSummary}>
                        <span>{t('onboarding.agentsCount', { count: enabledCount })}</span>
                        <span>
                          {detectingAgents
                            ? t('onboarding.agentsDetecting')
                            : t('onboarding.agentsDetected')}
                        </span>
                      </div>

                      <div className={styles.agentGrid}>
                        {AGENTS.map((agent) => {
                          const active = preferences.enabledAgents[agent.id]
                          const installed = agentAvailability[agent.id] ?? false
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              disabled={detectingAgents}
                              className={[
                                styles.agentOption,
                                active ? styles.agentOptionActive : '',
                                !detectingAgents && !installed ? styles.agentOptionUnavailable : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() => setAgentEnabled(agent.id, !active)}
                              data-autofocus={active ? 'true' : undefined}
                            >
                              <div className={styles.agentIconWrap}>
                                <AgentIcon
                                  type={agent.id}
                                  size={20}
                                  theme={preferences.terminalTheme ?? preferences.uiTheme}
                                />
                              </div>
                              <div className={styles.agentOptionBody}>
                                <div className={styles.agentNameRow}>
                                  <span className={styles.agentName}>{agent.label}</span>
                                  {detectingAgents ? (
                                    <span className={styles.agentStatus}>
                                      {t('onboarding.agentChecking')}
                                    </span>
                                  ) : installed ? (
                                    active ? (
                                      <Check size={15} className={styles.checkMark} />
                                    ) : null
                                  ) : (
                                    <span className={styles.agentStatus}>
                                      {t('onboarding.agentNotInstalled')}
                                    </span>
                                  )}
                                </div>
                                <div className={styles.agentDesc}>
                                  {t(`agent.${agent.id}.desc`)}
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : null}

                  {step === 3 ? (
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
                    disabled={!canProceed || finishing}
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
