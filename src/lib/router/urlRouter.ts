import { useUiStore } from '../../stores/uiStore'
import { isTauriEnv } from '../api/transport'
import { log } from '../logger'

// Mapeamento de caminhos HTTP para visões e modais equivalentes na interface React do Alethe.
export const ROUTE_PATH_MAP: Record<
  string,
  {
    view: 'home' | 'workspace' | 'agentCanvas'
    sidebarMode?: 'todo' | 'markdown' | 'git' | 'gsdSync'
    modal?: 'preferences'
  }
> = {
  '/': { view: 'workspace' },
  '/workspace': { view: 'workspace' },
  '/agents': { view: 'agentCanvas' },
  '/git': { view: 'workspace', sidebarMode: 'git' },
  '/sessions': { view: 'workspace', sidebarMode: 'gsdSync' },
  '/settings': { view: 'workspace', modal: 'preferences' },
}

/**
 * Inicializa a escuta de histórico do navegador (HTML5 History API) para sincronização de rotas.
 * Este método foi feito para permitir navegação transparente com botões Voltar/Avançar no modo Web.
 */
export function initUrlRouter() {
  if (typeof window === 'undefined' || isTauriEnv()) return

  // Sincroniza o estado inicial da UI com base na URL acessada diretamente pelo usuário
  syncUiFromUrl(window.location.pathname)

  // Escuta os eventos popstate do navegador (acionados por voltar/avançar no histórico)
  window.addEventListener('popstate', () => {
    log('info', 'Router', `Navegação popstate detectada: ${window.location.pathname}`)
    syncUiFromUrl(window.location.pathname)
  })
}

/**
 * Atualiza a store de UI baseada no caminho da URL atual.
 * Este método foi feito para garantir que a visão e sidebars corretas sejam exibidas.
 */
export function syncUiFromUrl(pathname: string) {
  const target = ROUTE_PATH_MAP[pathname] || ROUTE_PATH_MAP['/workspace']
  const uiStore = useUiStore.getState()

  uiStore.setActiveView(target.view)

  if (target.sidebarMode) {
    useUiStore.setState({ rightSidebarMode: target.sidebarMode })
  }
  if (target.modal === 'preferences') {
    uiStore.openModal_('preferences')
  }
}

/**
 * Navega para uma nova rota na versão Web (altera a URL no navegador sem recarga de página).
 * Este método foi feito para manipular o histórico de navegação no browser.
 */
export function navigateToRoute(path: string) {
  if (typeof window === 'undefined' || isTauriEnv()) return

  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path)
    log('info', 'Router', `Navegando para rota: ${path}`)
    syncUiFromUrl(path)
  }
}
