import antigravityLogo from '../../assets/antigravity.png'
import claudeLogo from '../../assets/claude-code.png'
import codexLogo from '../../assets/codex.png'
import freebuffLogo from '../../assets/freebuff.png'
import { iconMap } from '../../assets/icons'
import { isLightTheme } from '../../lib/themes'
import type { AgentType, Theme } from '../../lib/types'

export function ShellIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 5l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 11h5" strokeLinecap="round" />
    </svg>
  )
}

export function ClaudeIcon({ size = 16 }: { size?: number }) {
  return <img src={claudeLogo} alt="" width={size} height={size} draggable={false} />
}

export function CodexIcon({ size = 16 }: { size?: number }) {
  return <img src={codexLogo} alt="" width={size} height={size} draggable={false} />
}

export function FreebuffIcon({ size = 16 }: { size?: number }) {
  return <img src={freebuffLogo} alt="" width={size} height={size} draggable={false} />
}

export function MimoIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M5 11V6l3 3 3-3v5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function OpenCodeIcon({ size = 16, theme }: { size?: number; theme: Theme }) {
  const lightIcon = isLightTheme(theme)
  return (
    <img
      src={lightIcon ? iconMap.open : iconMap.openDark}
      alt=""
      width={size}
      height={size}
      draggable={false}
    />
  )
}

export function VSCodeIcon({ size = 14 }: { size?: number }) {
  return <img src={iconMap.vscode} alt="" width={size} height={size} draggable={false} />
}

export function AntigravityIcon({ size = 16 }: { size?: number }) {
  return <img src={antigravityLogo} alt="" width={size} height={size} draggable={false} />
}

export function GoogleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
        fill="#EA4335"
      />
    </svg>
  )
}

// GitHub Copilot mark from primer/octicons (MIT).
export function CopilotIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z" />
      <path d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z" />
    </svg>
  )
}

export function AgentIcon({
  type,
  size = 16,
  theme,
}: {
  type: AgentType
  size?: number
  theme: Theme
}) {
  if (type === 'shell') return <ShellIcon size={size} />
  if (type === 'claude') return <ClaudeIcon size={size} />
  if (type === 'codex') return <CodexIcon size={size} />
  if (type === 'copilot') return <CopilotIcon size={size} />
  if (type === 'freebuff') return <FreebuffIcon size={size} />
  if (type === 'mimo') return <MimoIcon size={size} />
  if (type === 'antigravity') return <AntigravityIcon size={size} />
  return <OpenCodeIcon size={size} theme={theme} />
}
