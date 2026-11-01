import { Download, ExternalLink, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { agentLabel } from '../../lib/agentProviders'
import { useT } from '../../lib/i18n'
import {
  hasBundledUpdate,
  installedBundledAgents,
  pendingBundledAgents,
  splitBundledReport,
} from '../../lib/skills'
import {
  type BundledSkill,
  type BundledSkillAgent,
  type BundledSkillState,
  openInBrowser,
  skillsCatalog,
  skillsInstallBundled,
  skillsRemoveBundled,
} from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import controls from '../modals/controls.module.css'
import styles from './OfficialSkills.module.css'

const STATE_LABEL = {
  available: 'skills.stateAvailable',
  installed: 'skills.stateInstalled',
  update: 'skills.stateUpdate',
  conflict: 'skills.stateConflict',
} as const satisfies Record<BundledSkillState, string>

/** The official skills, installed into one project so they travel with the repository. */
export function OfficialSkillsForProject({ projectPath }: { projectPath: string }) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const mountedRef = useRef(true)
  const [catalog, setCatalog] = useState<BundledSkill[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const next = await skillsCatalog(projectPath).catch(() => [])
    if (mountedRef.current) setCatalog(next)
  }

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
    }
  }, [projectPath])

  const failedBody = (failed: BundledSkillAgent[]) =>
    failed.map((entry) => `${agentLabel(entry.agent)}: ${entry.error}`).join(' · ')

  const run = async (skill: BundledSkill, remove: boolean) => {
    setBusy(true)
    try {
      const report = remove
        ? await skillsRemoveBundled(skill.name, installedBundledAgents(skill), projectPath)
        : await skillsInstallBundled(skill.name, pendingBundledAgents(skill), projectPath)
      const { done, failed } = splitBundledReport(report, (entry) =>
        remove ? entry.state !== 'installed' && entry.state !== 'update' : entry.state === 'installed',
      )
      if (done.length > 0) {
        pushToast({
          title: t(remove ? 'skills.projectRemoved' : 'skills.projectInstalled', { name: skill.name }),
          body: done.map((entry) => entry.path ?? agentLabel(entry.agent)).join('\n'),
        })
      }
      if (failed.length > 0) {
        pushToast({
          title: t(remove ? 'skills.removeFailed' : 'skills.installFailed'),
          body: failedBody(failed),
        })
      } else if (done.length === 0 && !remove) {
        pushToast({ title: t('skills.installFailed'), body: t('skills.conflictNote') })
      }
    } catch {
      pushToast({
        title: t(remove ? 'skills.removeFailed' : 'skills.installFailed'),
        body: t('mcp.errGeneric'),
      })
    }
    if (!mountedRef.current) return
    await load()
    if (mountedRef.current) setBusy(false)
  }

  return (
    <section className={styles.root}>
      <div>
        <h4 className={styles.title}>{t('skills.projectTitle')}</h4>
        <p className={styles.hint}>{t('skills.projectDescription')}</p>
      </div>
      {catalog === null ? (
        <p className={styles.hint}>{t('skills.loading')}</p>
      ) : (
        catalog.map((skill) => {
          const pending = pendingBundledAgents(skill)
          const installed = installedBundledAgents(skill)
          return (
            <div key={skill.name} className={styles.card}>
              <div className={styles.head}>
                <span className={styles.name}>{skill.name}</span>
                <span className={styles.badge}>
                  {t('skills.versionLabel', { version: skill.version })}
                </span>
                <span className={styles.spacer} />
                {skill.repository ? (
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnSm}`}
                    onClick={() => void openInBrowser(skill.repository)}
                    title={skill.repository}
                  >
                    <ExternalLink size={11} />
                    {t('skills.sourceAction')}
                  </button>
                ) : null}
                {pending.length > 0 ? (
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnSm}`}
                    disabled={busy}
                    onClick={() => void run(skill, false)}
                  >
                    <Download size={11} />
                    {hasBundledUpdate(skill) ? t('skills.updateAction') : t('skills.installAction')}
                  </button>
                ) : null}
                {installed.length > 0 ? (
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
                    disabled={busy}
                    onClick={() => void run(skill, true)}
                  >
                    <Trash2 size={11} />
                    {t('skills.removeAction')}
                  </button>
                ) : null}
              </div>
              {skill.description ? <p className={styles.description}>{skill.description}</p> : null}
              <div className={styles.agents}>
                {skill.agents.map((entry) => (
                  <div key={entry.agent} className={styles.agentRow}>
                    <span className={styles.agentName}>{agentLabel(entry.agent)}</span>
                    <span className={styles.badge}>{t(STATE_LABEL[entry.state])}</span>
                    <span className={styles.path} title={entry.path ?? ''}>
                      {entry.path}
                    </span>
                  </div>
                ))}
              </div>
              {skill.agents.some((entry) => entry.state === 'conflict') ? (
                <p className={styles.hint}>{t('skills.conflictNote')}</p>
              ) : null}
            </div>
          )
        })
      )}
    </section>
  )
}
