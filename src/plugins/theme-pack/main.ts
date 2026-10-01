import type { PluginContext, PluginModule } from '../../lib/plugins'
import { THEME_PACK_THEMES } from './themes'

const plugin: PluginModule = {
  activate(context: PluginContext) {
    for (const theme of THEME_PACK_THEMES) context.contributes.theme(theme)
  },
}

export default plugin
