import { useEffect, useState } from 'react'

import { recorderScratchDir } from '../../lib/api/misc'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './RecorderHelper.module.css'

declare global {
  interface Window {
    /** Setado só pelo gravador (`e2e/support/recorder.ts`, via
     *  `browser.execute()`) depois que a sessão isolada de gravação já
     *  passou pelo onboarding automatizado — nunca setado em runtime normal,
     *  então este painel nunca aparece pra um usuário de verdade mesmo
     *  estando sempre presente no bundle (mesmo raciocínio de
     *  `installE2eHooks()` em `e2eHooks.ts`: o build de e2e usa `vite build`
     *  normal, sem `import.meta.env.DEV`, então não dá pra gatear por isso). */
    __ALETHE_RECORDER_ACTIVE__?: boolean
  }
}

/**
 * Painel flutuante SÓ pra sessões de gravação de procedimento (pedido
 * explícito do dono) — oferece atalhos de configuração inicial (pular
 * criação manual de projeto) pra não repetir o mesmo trâmite manual toda vez
 * que uma gravação começa. "Pular login" não precisa de botão aqui: a
 * gravação já passa pelo onboarding via clique automatizado
 * (`quickLogin`/`completeOnboarding`) ANTES de expor este painel.
 *
 * Só renderiza algo se `window.__ALETHE_RECORDER_ACTIVE__` for `true`.
 */
export function RecorderHelper() {
  // Não dá pra ler `window.__ALETHE_RECORDER_ACTIVE__` só uma vez no mount:
  // este componente monta junto com o resto do App, ANTES do gravador
  // (`attachRecorder()`, em `e2e/support/recorder.ts`) rodar — ele só liga
  // a flag depois do onboarding automatizado terminar. Sem reatividade
  // nenhuma pra esse global (não é state do React), poll curto é o jeito
  // mais simples de pegar a mudança sem inventar um event bus só pra isso.
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (active) return
    const id = window.setInterval(() => {
      if (window.__ALETHE_RECORDER_ACTIVE__ === true) setActive(true)
    }, 300)
    return () => window.clearInterval(id)
  }, [active])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lastCreated, setLastCreated] = useState<string | null>(null)
  const createProject = useProjectsStore((s) => s.createProject)
  const setActiveProject = useProjectsStore((s) => s.setActiveProject)
  const setActiveView = useUiStore((s) => s.setActiveView)

  if (!active) return null

  const createScratchProject = async () => {
    setBusy(true)
    try {
      const cwd = await recorderScratchDir()
      const project = createProject({
        name: `recorder-${Date.now()}`,
        defaultCwd: cwd,
      })
      setActiveProject(project.id)
      // Sem isto, a Home continua montada por trás de qualquer modal aberto
      // depois — e a Home tem seu PRÓPRIO botão "OpenCode" (seletor rápido
      // de agente, escondido dentro de um `<details>` fechado). Uma busca
      // por texto sem escopo (`$('button*=OpenCode')`, usada tanto pelo
      // replay quanto pelo helper dedicado de e2e) podia acertar esse
      // elemento invisível em vez do card real — bug real, confirmado ao
      // vivo: "element not interactable" 100% reproduzível toda vez que o
      // procedimento gravado passava por aqui antes desta correção.
      setActiveView('workspace')
      setLastCreated(project.name)
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.wrap}>
      {open ? (
        <div className={styles.popup} role="dialog" aria-label="Atalhos de gravação">
          <button type="button" className={styles.action} disabled={busy} onClick={() => void createScratchProject()}>
            Criar projeto temporário (pasta nova)
          </button>
          {lastCreated ? <div className={styles.hint}>Criado: {lastCreated}</div> : null}
        </div>
      ) : null}
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen((o) => !o)}
        title="Atalhos de gravação"
        aria-label="Atalhos de gravação"
      >
        REC
      </button>
    </div>
  )
}
