import { Bot } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'

import type { CustomAgentIconSpec } from '../../lib/types'
import { customAgentIconFileSrc } from '../../lib/customAgentIconAssets'
import {
  AntigravityIcon,
  ClaudeIcon,
  CodexIcon,
  CopilotIcon,
  CursorIcon,
  FreebuffIcon,
  KiroIcon,
  MimoIcon,
  ShellIcon,
  WslIcon,
} from './AgentIcons'

function toIconSize(size: number | string | undefined): number {
  return typeof size === 'number' ? size : 16
}

const presetIconByKey: Record<string, ComponentType<{ size?: number }>> = {
  shell: ShellIcon,
  wsl: WslIcon,
  claude: ClaudeIcon,
  codex: CodexIcon,
  copilot: CopilotIcon,
  cursor: CursorIcon,
  freebuff: FreebuffIcon,
  mimo: MimoIcon,
  kiro: KiroIcon,
  antigravity: AntigravityIcon,
}

function PresetIcon({ presetKey, size }: { presetKey: string; size?: number | string }) {
  const Icon = presetIconByKey[presetKey]
  if (Icon) return <Icon size={toIconSize(size)} />
  return <Bot size={size ?? 16} />
}

function UrlAgentIcon({ href, size }: { href: string; size?: number | string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [href])
  if (failed) return <Bot size={size ?? 16} />
  const px = toIconSize(size)
  return (
    <img
      src={href}
      alt=""
      width={px}
      height={px}
      draggable={false}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

function FileAgentIcon({ assetId, size }: { assetId: string; size?: number | string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setSrc(null)
    setFailed(false)
    void customAgentIconFileSrc(assetId).then((resolved) => {
      if (live) setSrc(resolved)
    })
    return () => {
      live = false
    }
  }, [assetId])
  if (!src || failed) return <Bot size={size ?? 16} />
  const px = toIconSize(size)
  return (
    <img
      src={src}
      alt=""
      width={px}
      height={px}
      draggable={false}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

export type CustomAgentIconInput = CustomAgentIconSpec | string | undefined

export function customAgentIconComponent(
  input: CustomAgentIconInput,
): ComponentType<{ size?: number | string }> {
  const spec: CustomAgentIconSpec =
    typeof input === 'string' || input === undefined
      ? { kind: 'preset', key: input ?? 'bot' }
      : input
  if (spec.kind === 'url') {
    const href = spec.href
    return (props) => <UrlAgentIcon href={href} size={props.size} />
  }
  if (spec.kind === 'file') {
    const assetId = spec.assetId
    return (props) => <FileAgentIcon assetId={assetId} size={props.size} />
  }
  const presetKey = spec.key
  return (props) => <PresetIcon presetKey={presetKey} size={props.size} />
}
