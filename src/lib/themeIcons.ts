import darkIcon from '../assets/theme-icons/dark.png'
import lightIcon from '../assets/theme-icons/light.png'
import draculaIcon from '../assets/theme-icons/dracula.png'
import nordIcon from '../assets/theme-icons/nord.png'
import gruvboxIcon from '../assets/theme-icons/gruvbox.png'
import solarizedIcon from '../assets/theme-icons/solarized.png'
import tokyoNightIcon from '../assets/theme-icons/tokyo-night.png'
import vscodeIcon from '../assets/theme-icons/vscode.png'
import minDarkIcon from '../assets/theme-icons/min-dark.png'
import minLightIcon from '../assets/theme-icons/min-light.png'
import darkLemonIcon from '../assets/theme-icons/dark-lemon.png'
import orcaIcon from '../assets/theme-icons/orca.png'
import blueGradientIcon from '../assets/theme-icons/alethe-blue-gradient.png'
import pinkGradientIcon from '../assets/theme-icons/alethe-pink-gradient.png'
import type { AppIconTheme } from './types'

export const THEME_ICONS: Record<AppIconTheme, string> = {
  dark: darkIcon,
  light: lightIcon,
  dracula: draculaIcon,
  nord: nordIcon,
  gruvbox: gruvboxIcon,
  solarized: solarizedIcon,
  'tokyo-night': tokyoNightIcon,
  vscode: vscodeIcon,
  'min-dark': minDarkIcon,
  'min-light': minLightIcon,
  'dark-lemon': darkLemonIcon,
  orca: orcaIcon,
  'alethe-blue-gradient': blueGradientIcon,
  'alethe-pink-gradient': pinkGradientIcon,
}

export function getThemeIcon(theme: AppIconTheme): string {
  return THEME_ICONS[theme] ?? THEME_ICONS.dark
}
