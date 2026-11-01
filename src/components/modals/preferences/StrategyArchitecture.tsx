import { useT } from '../../../lib/i18n'
import type { OrchestrationSkillProvider, OrchestrationStrategy } from '../../../lib/types'
// Official 9router favicon: https://github.com/decolua/9router/blob/master/public/favicon.svg
import router9Logo from '../../../assets/router9-official.svg'
// Official Kimi icon: https://github.com/MoonshotAI/Branding-Guide/blob/main/scenarios/03-icon-without-kimi/kimi-icon-rounded-corner.png
import kimiLogo from '../../../assets/kimi-official.png'
// Official Google Antigravity press asset: https://www.antigravity.google/press
import antigravityLogo from '../../../assets/antigravity-official.svg'
// Official Anthropic press kit: https://www.anthropic.com/news (Claude icon, rounded PNG)
import claudeLogo from '../../../assets/claude-official.png'
// Official OpenAI mark used for Codex: https://openai.com/brand/
import openaiLogo from '../../../assets/openai-official.svg'
import openaiLogoWhite from '../../../assets/openai-official-white.svg'
import styles from './StrategyArchitecture.module.css'

type Props = {
  strategy: OrchestrationStrategy
  provider: OrchestrationSkillProvider | null
  routedThrough9router: boolean
  lightTheme: boolean
}

const WORKERS: Record<OrchestrationStrategy, number> = {
  auto: 1,
  economy: 1,
  balanced: 2,
  quality: 2,
  research: 3,
  parallel: 3,
  rescue: 1,
}

function ProviderMark({
  provider,
  lightTheme,
}: {
  provider: OrchestrationSkillProvider | null
  lightTheme: boolean
}) {
  if (provider === 'codex')
    return (
      <img
        src={lightTheme ? openaiLogo : openaiLogoWhite}
        alt=""
        width={22}
        height={22}
        draggable={false}
      />
    )
  if (provider === 'claude')
    return <img src={claudeLogo} alt="" width={22} height={22} draggable={false} />
  if (provider === 'agy')
    return <img src={antigravityLogo} alt="" width={22} height={22} draggable={false} />
  if (provider === 'kimi')
    return <img src={kimiLogo} alt="" width={22} height={22} draggable={false} />
  return null
}

function Arrow({ label }: { label: string }) {
  return (
    <span className={styles.arrow} aria-label={label} role="img">
      <svg viewBox="0 0 72 28" fill="none" aria-hidden="true">
        <path d="M2 15 C15 13 24 17 36 14 S58 14 67 13" />
        <path d="M58 7 Q63 10 68 13 Q63 17 58 21" />
      </svg>
      <span>{label}</span>
    </span>
  )
}

export function StrategyArchitecture({
  strategy,
  provider,
  routedThrough9router,
  lightTheme,
}: Props) {
  const t = useT()
  const names: Record<OrchestrationSkillProvider, string> = {
    codex: 'Codex',
    claude: 'Claude Code',
    agy: 'Agy / Antigravity',
    kimi: 'Kimi Code',
  }
  const workerCount = WORKERS[strategy]

  return (
    <section className={styles.preview} aria-label={t('prefs.strategyDiagramTitle')}>
      <div className={styles.heading}>
        <strong>{t('prefs.strategyDiagramTitle')}</strong>
        <span>{t(`prefs.orchestrationSkillStrategy.${strategy}`)}</span>
      </div>
      <div className={styles.diagram}>
        <div className={styles.node}>
          <strong>{t('prefs.strategyDiagramPlanner')}</strong>
          <small>{t('prefs.strategyDiagramTask')}</small>
        </div>
        <Arrow label={t('prefs.strategyDiagramDelegates')} />
        <div className={strategy === 'quality' ? styles.sequentialWorkers : styles.workers}>
          {Array.from({ length: workerCount }, (_, index) => (
            <div className={styles.workerStep} key={index}>
              {strategy === 'quality' && index > 0 && (
                <Arrow label={t('prefs.strategyDiagramThen')} />
              )}
              <div className={styles.node}>
                <span className={styles.workerName}>
                  <ProviderMark provider={provider} lightTheme={lightTheme} />
                  <strong>
                    {provider ? names[provider] : t('prefs.strategyDiagramAutomaticCli')}
                  </strong>
                </span>
                <small>
                  {t('prefs.strategyDiagramWorker', { number: String(index + 1) })}
                  {strategy === 'quality' && index === 1
                    ? ` · ${t('prefs.strategyDiagramReview')}`
                    : ''}
                </small>
              </div>
            </div>
          ))}
        </div>
        <Arrow label={t('prefs.strategyDiagramResults')} />
        <div className={styles.node}>
          <strong>{t('prefs.strategyDiagramIntegration')}</strong>
          <small>{t('prefs.strategyDiagramChecks')}</small>
        </div>
      </div>
      {routedThrough9router && (
        <div className={styles.route}>
          <span>{t('prefs.strategyDiagramApiRoute')}</span>
          <Arrow label={t('prefs.strategyDiagramTraffic')} />
          <span className={styles.router}>
            <img src={router9Logo} alt="" width={20} height={20} draggable={false} />
            9router
          </span>
          <Arrow label={t('prefs.strategyDiagramUpstream')} />
          <span>{t('prefs.strategyDiagramConfiguredModel')}</span>
        </div>
      )}
      <p className={styles.note}>
        {strategy === 'auto' ? t('prefs.strategyDiagramAutoNote') : t('prefs.strategyDiagramNote')}
      </p>
    </section>
  )
}
