import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'
import { McpStep } from './onboarding/McpStep'

/**
 * The onboarding MCP step for installs that already finished onboarding — `onboardingDone`
 * is a plain boolean, so a new step is invisible to them.
 */
export function McpIntroModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'mcpIntro')
  const closeModal = useUiStore((state) => state.closeModal)
  const openModal = useUiStore((state) => state.openModal_)
  const setPreferences = useProjectsStore((state) => state.setPreferences)

  if (!open) return null

  const dismiss = () => {
    setPreferences({ mcpOnboardingSeen: true })
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={t('mcp.introTitle')}
      width={640}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={dismiss}>
            {t('mcp.introLater')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => {
              setPreferences({ mcpOnboardingSeen: true })
              openModal('mcpManager')
            }}
          >
            {t('mcp.introOpen')}
          </button>
        </>
      }
    >
      <McpStep />
    </Modal>
  )
}
