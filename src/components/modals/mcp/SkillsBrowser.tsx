import { ChevronDown, ChevronRight, FileText, Folder, Link2, Lock, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { groupSkillsByName, type SkillGroup } from '../../../lib/skills'
import {
  skillsDetail,
  skillsScan,
  skillsUninstall,
  type SkillAgentSnapshot,
  type SkillDetail,
  type SkillNode,
  type SkillSummary,
} from '../../../lib/tauri'
import { AGENT_TYPE_LABELS, type AgentType } from '../../../lib/types'
import { useUiStore } from '../../../stores/uiStore'
import { EmptyState } from '../../EmptyState'
import { MarkdownRenderer } from '../../MarkdownPane/MarkdownRenderer'
import controls from '../controls.module.css'
import { Modal } from '../Modal'
import styles from './SkillsBrowser.module.css'

type RemoveTarget = { group: SkillGroup; entries: SkillSummary[] }

export function SkillsBrowser({ dark }: { dark: boolean }) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const agentLabel = (agent: string) =>
    agent === 'shared' ? t('skills.sharedStore') : (AGENT_TYPE_LABELS[agent as AgentType] ?? agent)

  const [snapshots, setSnapshots] = useState<SkillAgentSnapshot[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      setSnapshots(await skillsScan())
    } catch {
      setSnapshots([])
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const groups = useMemo(() => groupSkillsByName(snapshots ?? []), [snapshots])
  const active = groups.find((group) => group.name === selected) ?? groups[0] ?? null

  useEffect(() => {
    if (!active) {
      setDetail(null)
      return
    }
    // Read the definition from wherever it actually lives; every copy is the same folder.
    const source = active.entries[0]
    let cancelled = false
    void skillsDetail(source.agent, source.name)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
    return () => {
      cancelled = true
    }
  }, [active?.name])

  const confirmRemove = async () => {
    const target = removeTarget
    if (!target) return
    setRemoveTarget(null)
    setBusy(true)

    const removed: string[] = []
    const failed: string[] = []
    let sharedKept: string | null = null
    for (const entry of target.entries) {
      try {
        const report = await skillsUninstall(entry.agent, entry.name)
        removed.push(agentLabel(entry.agent))
        if (report.sharedCopyPath) sharedKept = report.sharedCopyPath
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error)
        failed.push(
          `${agentLabel(entry.agent)}: ${
            raw.startsWith('bundled_skill') ? t('skills.errBundled') : t('mcp.errGeneric')
          }`,
        )
      }
    }

    if (removed.length > 0) {
      pushToast({
        title: t('skills.removed', { name: target.group.name }),
        body: sharedKept
          ? t('skills.removedLinkOnly', { path: sharedKept })
          : removed.join(', '),
      })
    }
    if (failed.length > 0) {
      pushToast({ title: t('skills.removeFailed'), body: failed.join(' · ') })
    }
    setSelected(null)
    await load()
    setBusy(false)
  }

  if (snapshots === null) return <p className={styles.muted}>{t('skills.loading')}</p>

  if (groups.length === 0) {
    return (
      <div className={styles.emptyWrap}>
        <EmptyState
          compact
          icon={<FileText size={20} />}
          title={t('skills.emptyTitle')}
          description={t('skills.emptyDescription')}
        />
      </div>
    )
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.list}>
        {groups.map((group) => (
          <button
            key={group.name}
            type="button"
            className={`${styles.skillButton} ${
              active?.name === group.name ? styles.skillButtonActive : ''
            }`}
            onClick={() => setSelected(group.name)}
          >
            <span className={styles.skillName}>{group.name}</span>
            {group.bundled ? <Lock size={11} /> : null}
            {group.sharedEntry ? <Link2 size={11} /> : null}
            <span className={styles.skillCount}>{group.agents.length}</span>
          </button>
        ))}
      </aside>

      <section className={styles.detail}>
        {active ? (
          <SkillDetailView
            group={active}
            detail={detail}
            dark={dark}
            busy={busy}
            agentLabel={agentLabel}
            onRemove={(entries) => setRemoveTarget({ group: active, entries })}
          />
        ) : (
          <div className={styles.placeholder}>
            <EmptyState compact icon={<FileText size={20} />} title={t('skills.selectOne')} />
          </div>
        )}
      </section>

      {removeTarget ? (
        <Modal
          nested
          open
          onClose={() => setRemoveTarget(null)}
          title={t('skills.removeTitle')}
          width={440}
          footer={
            <>
              <button type="button" className={controls.btn} onClick={() => setRemoveTarget(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnDanger}`}
                onClick={() => void confirmRemove()}
              >
                {t('skills.removeAction')}
              </button>
            </>
          }
        >
          <p className={styles.muted}>
            {t('skills.removeBody', {
              name: removeTarget.group.name,
              agent: removeTarget.entries.map((entry) => agentLabel(entry.agent)).join(', '),
            })}
          </p>
          {removeTarget.entries.some((entry) => entry.linked) ? (
            <p className={styles.note}>
              {t('skills.removeLinkNote', {
                path: removeTarget.group.sharedEntry?.path ?? '',
              })}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  )
}

function SkillDetailView({
  group,
  detail,
  dark,
  busy,
  agentLabel,
  onRemove,
}: {
  group: SkillGroup
  detail: SkillDetail | null
  dark: boolean
  busy: boolean
  agentLabel: (agent: string) => string
  onRemove: (entries: SkillSummary[]) => void
}) {
  const t = useT()
  const frontmatter = detail?.frontmatter ?? {}
  const lock = detail?.lock ?? null

  return (
    <>
      <header className={styles.detailHead}>
        <div className={styles.detailTitleRow}>
          <span className={styles.detailName}>{group.name}</span>
          {group.bundled ? (
            <span className={styles.badge}>
              <Lock size={10} /> {t('skills.badgeBundled')}
            </span>
          ) : group.removable.length > 0 ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
              disabled={busy}
              onClick={() => onRemove(group.removable)}
            >
              <Trash2 size={11} />
              {group.removable.length > 1
                ? t('skills.removeAllAction', { count: group.removable.length })
                : t('skills.removeAction')}
            </button>
          ) : null}
        </div>
        {group.description ? <p className={styles.description}>{group.description}</p> : null}
      </header>

      <section>
        <div className={styles.sectionTitle}>{t('skills.installedOn')}</div>
        <div className={styles.agentRows}>
          {group.entries.map((entry) => (
            <div key={`${entry.agent}:${entry.path}`} className={styles.agentRow}>
              <span className={styles.agentName}>{agentLabel(entry.agent)}</span>
              {entry.bundled ? (
                <span className={styles.badge}>
                  <Lock size={10} /> {t('skills.badgeBundled')}
                </span>
              ) : null}
              {entry.linked ? (
                <span className={styles.badge}>
                  <Link2 size={10} /> {t('skills.badgeLinked')}
                </span>
              ) : null}
              <span className={styles.path} title={entry.path}>
                {entry.path}
              </span>
              {entry.bundled ? null : (
                <button
                  type="button"
                  className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
                  disabled={busy}
                  onClick={() => onRemove([entry])}
                  title={t('skills.removeAction')}
                  aria-label={t('skills.removeAction')}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {Object.keys(frontmatter).length > 0 ? (
        <section>
          <div className={styles.sectionTitle}>{t('skills.frontmatter')}</div>
          <div className={styles.fields}>
            {Object.entries(frontmatter).map(([key, value]) => (
              <div key={key} className={styles.field}>
                <span className={styles.fieldKey}>{key}</span>
                <span className={styles.fieldValue}>{value}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {lock ? (
        <section>
          <div className={styles.sectionTitle}>{t('skills.installInfo')}</div>
          <div className={styles.fields}>
            {lock.source ? (
              <div className={styles.field}>
                <span className={styles.fieldKey}>{t('skills.lockSource')}</span>
                <span className={styles.fieldValue}>{lock.source}</span>
              </div>
            ) : null}
            {lock.updatedAt ? (
              <div className={styles.field}>
                <span className={styles.fieldKey}>{t('skills.lockUpdated')}</span>
                <span className={styles.fieldValue}>{lock.updatedAt}</span>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {detail ? (
        <>
          <section>
            <div className={styles.sectionTitle}>{t('skills.structure')}</div>
            <div className={styles.tree}>
              {detail.tree.map((node) => (
                <TreeNode key={node.path} node={node} depth={0} />
              ))}
            </div>
          </section>

          <section>
            <div className={styles.sectionTitle}>SKILL.md</div>
            <div className={styles.body}>
              <MarkdownRenderer content={detail.body} dark={dark} />
            </div>
          </section>
        </>
      ) : (
        <p className={styles.muted}>{t('skills.loading')}</p>
      )}
    </>
  )
}

function TreeNode({ node, depth }: { node: SkillNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0)
  const style = { paddingLeft: 8 + depth * 14 }

  if (!node.isDir) {
    return (
      <span className={styles.treeRow} style={style}>
        <FileText size={11} />
        {node.name}
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        className={styles.treeRow}
        style={style}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Folder size={11} />
        {node.name}
      </button>
      {open
        ? node.children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))
        : null}
    </>
  )
}
