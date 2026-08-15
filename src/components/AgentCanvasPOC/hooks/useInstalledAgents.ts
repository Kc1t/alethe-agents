import { useCallback, useEffect, useState } from 'react'

import { CORE_AGENTS } from '../../../lib/agentCanvasConfig'
import { AGENT_LIBRARY } from '../../../lib/agentLibrary'
import { useT } from '../../../lib/i18n'
import {
  economyAgentsEnabled,
  installAgent as installAgentCmd,
  type InstalledAgent,
  listInstalledAgents,
  setEconomyAgents,
  uninstallAgent as uninstallAgentCmd,
} from '../../../lib/tauri'

type Session = { folder: string; ptyId: string }

   
                                                                 
                                                                     
                                                         
   
export function useInstalledAgents(session: Session | null) {
  const t = useT()
  const [installed, setInstalled] = useState<InstalledAgent[]>([])
  const [coreAgentsReady, setCoreAgentsReady] = useState(false)
  const [economyOn, setEconomyOn] = useState(false)
  const [restartHint, setRestartHint] = useState(false)

  const refreshInstalled = useCallback(() => {
    if (!session) return
    listInstalledAgents(session.folder)
      .then((list) => {
        console.log(
          '[AgentCanvasPOC] agents instalados:',
          list.map((a) => a.name).join(', ') || '(nenhum)',
        )
        setInstalled(list)
      })
      .catch((err) => console.error('[AgentCanvasPOC] falha listando agents:', err))
  }, [session])

                                                                
  useEffect(() => {
    if (!session) return
    economyAgentsEnabled(session.folder)
      .then(setEconomyOn)
      .catch(() => {})
    refreshInstalled()
  }, [session, refreshInstalled])

                                                                               
                                                                                  
                                                                                  
                                                                                  
  useEffect(() => {
    if (!session) return
    setCoreAgentsReady(false)
    const folder = session.folder
    void Promise.allSettled(
      CORE_AGENTS.map((name) => {
        const tpl = AGENT_LIBRARY.find((a) => a.name === name)
        if (!tpl) return Promise.resolve(null)
        return installAgentCmd({ folder, name: tpl.name, content: tpl.content, force: false })
      }),
    ).then(() => {
      console.log('[AgentCanvasPOC] core agents garantidos na pasta')
      setCoreAgentsReady(true)
      refreshInstalled()
    })
  }, [session, refreshInstalled])

  const toggleEconomy = useCallback(() => {
    if (!session) return
    const next = !economyOn
    setEconomyAgents(session.folder, next)
      .then((touched) => {
        console.log(`[AgentCanvasPOC] modo economia ${next ? 'ON' : 'OFF'}, arquivos:`, touched)
        setEconomyOn(next)
        setRestartHint(true)
        refreshInstalled()
      })
      .catch((err) => console.error('[AgentCanvasPOC] falha togglando modo economia:', err))
  }, [session, economyOn, refreshInstalled])

  const installAgent = useCallback(
    (name: string, force = false) => {
      if (!session) return
      const template = AGENT_LIBRARY.find((item) => item.name === name)
      if (!template) return
      installAgentCmd({
        folder: session.folder,
        name: template.name,
        content: template.content,
        force,
      })
        .then((path) => {
          console.log('[AgentCanvasPOC] agent instalado:', path)
          setRestartHint(true)
          refreshInstalled()
        })
        .catch((err) => {
          if (String(err) === 'conflict') {
            if (window.confirm(t('ws.confirmOverwriteForeignAgent', { name }))) {
              installAgent(name, true)
            }
            return
          }
          console.error('[AgentCanvasPOC] falha instalando agent:', err)
        })
    },
    [session, refreshInstalled, t],
  )

  const uninstallAgent = useCallback(
    (agent: InstalledAgent) => {
      if (!session) return
      const msg = agent.from_alethe
        ? t('ws.confirmRemoveAgent', { name: agent.name })
        : t('ws.confirmRemoveForeignAgent', { name: agent.name })
      if (!window.confirm(msg)) return
      uninstallAgentCmd(session.folder, agent.name, true)
        .then(() => {
          console.log('[AgentCanvasPOC] agent removido:', agent.name)
          setRestartHint(true)
          refreshInstalled()
        })
        .catch((err) => console.error('[AgentCanvasPOC] falha removendo agent:', err))
    },
    [session, refreshInstalled, t],
  )

  return {
    installed,
    coreAgentsReady,
    economyOn,
    restartHint,
    setRestartHint,
    refreshInstalled,
    toggleEconomy,
    installAgent,
    uninstallAgent,
  }
}
