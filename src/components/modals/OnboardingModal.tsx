import * as Dialog from '@radix-ui/react-dialog'
import { Github } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { latestVersionFor } from '../../lib/agentVersions'
import { FEATURES } from '../../lib/features'
import { LOCALES, useT } from '../../lib/i18n'
import { DEFAULT_PROFILE_IMAGE_URL, getProfileInitial } from '../../lib/profile'
import { agentCliVersion, findCliLauncher } from '../../lib/tauri'
import { getThemeIcon } from '../../lib/themeIcons'
import { agentCliCommand, type AgentType } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ImageInput } from './ImageInput'
import { AgentsStep } from './onboarding/AgentsStep'
import { FeaturesStep } from './onboarding/FeaturesStep'
import styles from './OnboardingModal.module.css'

const STEP_COUNT = 3
const LAST_STEP = STEP_COUNT - 1

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
  { id: 'kiro', label: 'Kiro CLI' },
]

export function OnboardingModal() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const setLanguage = useProjectsStore((s) => s.setLanguage)
  const setAgentEnabled = useProjectsStore((s) => s.setAgentEnabled)

  const [step, setStep] = useState(0)
  const [name, setName] = useState(preferences.displayName)
  const [photoUrl, setPhotoUrl] = useState(preferences.profileImageUrl)
  const [showPhoto, setShowPhoto] = useState(false)
  const [showGithub, setShowGithub] = useState(false)
  const [githubHandle, setGithubHandle] = useState('')
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

  const enabledFeatureCount = FEATURES.filter(
    (feature) => preferences.enabledFeatures[feature.id],
  ).length
  const trimmedName = name.trim()
  const trimmedPhotoUrl = photoUrl.trim()
  const initial = getProfileInitial(trimmedName)
  const previewAvatarUrl = trimmedPhotoUrl || DEFAULT_PROFILE_IMAGE_URL

  useEffect(() => {
    if (preferences.onboardingDone) return
    setStep(0)
    setName(preferences.displayName)
    setPhotoUrl(preferences.profileImageUrl)
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

    // Versions and the registry lookup run after detection so the grid is interactive first.
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
    if (trimmedName.length === 0) return
    setPreferences({
      accountCreated: true,
      onboardingDone: true,
      displayName: trimmedName,
      profileImageUrl: trimmedPhotoUrl,
    })
    useUiStore.getState().setActiveView('home')
  }

  const next = () => {
    if (!canProceed) return
    if (step === LAST_STEP) finish()
    else setStep((value) => value + 1)
  }

  const back = () => setStep((value) => Math.max(0, value - 1))

  const applyGithubHandle = () => {
    const handle = githubHandle.trim().replace(/^@/, '')
    if (!handle) return
    setPhotoUrl(`https://github.com/${handle}.png`)
    setImgFailed(false)
    if (!trimmedName) setName(handle)
    setShowGithub(false)
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
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.defaultPrevented) return
            event.preventDefault()
            next()
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <header className={styles.top}>
            <span className={styles.brandMark}>
              <img src={getThemeIcon(preferences.appIconTheme)} alt="" draggable={false} />
            </span>
            <Dialog.Title className={styles.eyebrow}>{t('onboarding.kicker')}</Dialog.Title>
            <span className={styles.grow} />
            <span className={styles.dots} aria-hidden>
              {Array.from({ length: STEP_COUNT }, (_, index) => (
                <i key={index} data-active={index <= step} />
              ))}
            </span>
            <span className={styles.langSelect}>
              {LOCALES.map((locale) => (
                <button
                  key={locale.id}
                  type="button"
                  data-active={preferences.language === locale.id}
                  onClick={() => setLanguage(locale.id)}
                >
                  {locale.id === 'en' ? 'EN' : 'PT'}
                </button>
              ))}
            </span>
          </header>

          <div key={step} className={styles.body}>
            {step === 0 ? (
              <div className={styles.center}>
                <button
                  type="button"
                  className={styles.avatar}
                  onClick={() => setShowPhoto((value) => !value)}
                  aria-label={t('onboarding.photoTitle')}
                >
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
                    <span className={styles.avatarInitial}>{initial}</span>
                  )}
                  <span className={styles.avatarOverlay}>{t('onboarding.photoChange')}</span>
                </button>
                <div className={styles.avatarHint}>{t('onboarding.photoHint')}</div>

                <h2 className={styles.question}>{t('onboarding.profileTitle')}</h2>
                <p className={styles.questionDesc}>{t('onboarding.profileSubtitle')}</p>

                <input
                  data-autofocus
                  className={styles.nameInput}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('onboarding.namePlaceholder')}
                  aria-label={t('onboarding.name')}
                  maxLength={60}
                />

                {showPhoto ? (
                  <div className={styles.inlineField}>
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
                  </div>
                ) : null}

                <div className={styles.divider}>
                  <i />
                  {t('onboarding.orImportFrom')}
                  <i />
                </div>

                {showGithub ? (
                  <div className={styles.githubRow}>
                    <input
                      className={styles.githubInput}
                      value={githubHandle}
                      onChange={(event) => setGithubHandle(event.target.value)}
                      placeholder={t('onboarding.githubHandlePlaceholder')}
                      aria-label={t('onboarding.githubHandlePlaceholder')}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        applyGithubHandle()
                      }}
                    />
                    <button
                      type="button"
                      className={styles.githubApply}
                      onClick={applyGithubHandle}
                    >
                      {t('onboarding.githubUse')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.oauth}
                    onClick={() => setShowGithub(true)}
                  >
                    <Github size={16} />
                    {t('onboarding.githubImport')}
                  </button>
                )}

                <p className={styles.note}>{t('onboarding.localNote')}</p>
              </div>
            ) : null}

            {step === 1 ? (
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
              />
            ) : null}

            {step === LAST_STEP ? (
              <>
                <div className={styles.stepIntro}>
                  <h2 className={styles.stepTitle}>{t('onboarding.featuresTitle')}</h2>
                  <p className={styles.stepSubtitle}>{t('onboarding.featuresSubtitle')}</p>
                </div>
                <FeaturesStep />
              </>
            ) : null}
          </div>

          <footer className={styles.footer}>
            <div className={styles.footerNote}>
              {step === LAST_STEP
                ? t('onboarding.featuresEnabledOf', {
                    enabled: enabledFeatureCount,
                    total: FEATURES.length,
                  })
                : t('onboarding.footerNote')}
            </div>
            {step > 0 ? (
              <button
                type="button"
                className={`${styles.button} ${styles.buttonGhost}`}
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
              {step === LAST_STEP ? t('onboarding.goToApp') : t('common.next')}
              <span className={styles.kbd}>⏎</span>
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
