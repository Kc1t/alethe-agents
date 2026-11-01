import { AgentIcon } from '../../components/icons/AgentIcons'
import { Dropdown } from '../../components/ui/Dropdown'
import { useProjectsStore } from '../../stores/projectsStore'
import { agentAccentVar, agentLabel } from '../agentProviders'
import type { PluginAgents, PluginComponents, PluginDropdownProps } from './types'

function PluginAgentIcon({ agent, size = 16 }: { agent: string; size?: number }) {
  const theme = useProjectsStore((state) => state.preferences.uiTheme)
  return <AgentIcon type={agent} size={size} theme={theme} />
}

function PluginDropdown({ value, options, onChange, ariaLabel, disabled }: PluginDropdownProps) {
  return (
    <Dropdown
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={ariaLabel}
      disabled={disabled}
    />
  )
}

export const pluginAgents: PluginAgents = {
  label: (agent) => agentLabel(agent),
  accent: (agent) => agentAccentVar(agent),
}

export const pluginComponents: PluginComponents = {
  AgentIcon: PluginAgentIcon,
  Dropdown: PluginDropdown,
}
