import {
  Archive,
  CheckCircle2,
  Copy,
  FolderSync,
  Globe,
  Laptop,
  Share2,
  ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../lib/i18n'
import { writeClipboardText } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { GoogleIcon } from '../icons/AgentIcons'
import styles from './MeshSidebarView.module.css'

export function MeshSidebarView() {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]
  const openModal = useUiStore((s) => s.openModal_)
  const [copied, setCopied] = useState(false)

  const copyDeviceId = () => {
    void writeClipboardText('ALETHE-7X9K-2M4P-8Q1V-99ZZ')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <Globe size={15} className={styles.headerIcon} />
          <strong className={styles.title}>{t('mesh.title') || 'Conexão & Malha P2P'}</strong>
        </div>
        <span className={styles.badgeLocal}>Modo Local</span>
      </header>

      <section className={styles.section}>
        <div className={styles.authCard}>
          <div className={styles.authInfo}>
            <span className={styles.authLabel}>Conta de Sincronização</span>
            <span className={styles.authStatus}>Não conectado (Opcional)</span>
          </div>
          <button
            type="button"
            className={styles.loginGoogleBtn}
            onClick={() => openModal('sync')}
          >
            <GoogleIcon size={14} />
            <span>Conectar Google / Email</span>
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.deviceCard}>
          <div className={styles.deviceHeader}>
            <Laptop size={14} />
            <span>{t('mesh.thisDevice') || 'Este Computador (ID Local)'}</span>
          </div>
          <div className={styles.deviceIdRow}>
            <code className={styles.deviceId}>ALETHE-7X9K-2M4P-8Q1V-99ZZ</code>
            <button
              type="button"
              className={styles.copyBtn}
              onClick={copyDeviceId}
              title="Copiar Device ID"
            >
              {copied ? <CheckCircle2 size={13} className={styles.successIcon} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('mesh.projectSync') || 'Sincronização do Projeto'}</span>
        </div>

        {activeProject ? (
          <div className={styles.projectSyncCard}>
            <div className={styles.projectInfo}>
              <FolderSync size={15} className={styles.syncIcon} />
              <div className={styles.projectNames}>
                <strong>{activeProject.name}</strong>
                <span className={styles.projectPath}>{activeProject.defaultCwd}</span>
              </div>
            </div>

            <div className={styles.actionButtons}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => openModal('sync')}
              >
                <Share2 size={13} />
                <span>{t('mesh.inviteFriend') || 'Convidar Amigo'}</span>
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={() => openModal('meshFolderTree')}
                title="Configurar Pastas & Backups"
              >
                <Archive size={13} />
                <span>{t('mesh.vault') || 'Cofre & Pastas'}</span>
              </button>
            </div>
          </div>
        ) : (
          <EmptyState
            compact
            icon={<FolderSync size={18} />}
            title={t('mesh.noProject') || 'Nenhum projeto ativo'}
            description={t('mesh.noProjectDesc') || 'Selecione um projeto para sincronizar.'}
          />
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('mesh.security') || 'Segurança & Backups'}</span>
        </div>
        <div className={styles.securityPill}>
          <ShieldCheck size={14} className={styles.shieldIcon} />
          <span>mTLS 1.3 · Delta Sync 128KB · .alethe Oculto</span>
        </div>
      </section>
    </div>
  )
}