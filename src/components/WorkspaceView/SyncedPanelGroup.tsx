import { useEffect, useRef } from 'react'
import { Group as PanelGroup, type GroupProps, useGroupRef } from 'react-resizable-panels'

import { useProjectsStore } from '../../stores/projectsStore'

const SAVE_DEBOUNCE_MS = 180
/** Abaixo disso, a diferença é ruído de arredondamento do layout, não uma mudança real. */
const LAYOUT_EPSILON = 0.5

type Layout = Record<string, number>

function layoutsMatch(a: Layout | undefined, b: Layout | undefined): boolean {
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const other = b[key]
    return other !== undefined && Math.abs(a[key] - other) < LAYOUT_EPSILON
  })
}

/**
 * `PanelGroup` cuja posição das barras divisórias é compartilhada entre os
 * clientes Desktop e Web.
 *
 * A posição é guardada em proporção (porcentagem por painel), não em pixels,
 * então faz sentido mesmo com as duas janelas em tamanhos bem diferentes. A
 * gravação acontece só quando o ponteiro é solto (`onLayoutChanged`, não
 * `onLayoutChange`) — espelhar durante o arrasto geraria uma rajada de sync e
 * de SIGWINCH nos agentes, exatamente o que o settle/cooldown do terminal
 * existe pra evitar.
 *
 * Requer um `id` estável e derivado do domínio: o default do
 * `react-resizable-panels` é o `useId()` do React, que gera valores diferentes
 * em cada cliente e nunca casaria entre eles.
 */
export function SyncedPanelGroup({
  id,
  children,
  ...rest
}: Omit<GroupProps, 'id' | 'defaultLayout' | 'onLayoutChanged' | 'groupRef'> & { id: string }) {
  const groupRef = useGroupRef()
  const savedLayout = useProjectsStore((s) => s.preferences.paneLayouts?.[id])
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const saveTimerRef = useRef<number | null>(null)
  // Layout aplicado por nós a partir do estado compartilhado. Sem isto, aplicar
  // uma mudança remota podia ricochetear como se fosse edição local.
  const appliedRemoteRef = useRef<Layout | undefined>(savedLayout)
  // Só o layout do primeiro render vira `defaultLayout`: trocá-lo depois faz o
  // react-resizable-panels reconstruir o layout no meio de um arrasto (mesmo
  // motivo dos refs de defaultSize das sidebars em App.tsx). Mudanças
  // posteriores entram pelo caminho imperativo abaixo.
  const defaultLayoutRef = useRef(savedLayout)

  useEffect(() => {
    if (!savedLayout) return
    if (layoutsMatch(savedLayout, appliedRemoteRef.current)) return
    const current = groupRef.current?.getLayout()
    if (layoutsMatch(savedLayout, current)) return
    appliedRemoteRef.current = savedLayout
    groupRef.current?.setLayout(savedLayout)
    // Os terminais medem o novo espaço sozinhos pelo ResizeObserver, mas
    // precisam saber que a mudança veio de FORA: sem isso, um observador da
    // grade compartilhada interpretaria o painel mudando de tamanho como "o
    // usuário redimensionou este cliente" e reivindicaria a grade, brigando
    // com quem a sincronizou. O evento faz o observador só re-basear a escala.
    window.dispatchEvent(new CustomEvent('alethe:pane-layout-synced'))
  }, [groupRef, savedLayout])

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    },
    [],
  )

  return (
    <PanelGroup
      {...rest}
      id={id}
      groupRef={groupRef}
      defaultLayout={defaultLayoutRef.current}
      onLayoutChanged={(layout) => {
        if (layoutsMatch(layout, appliedRemoteRef.current)) return
        appliedRemoteRef.current = layout
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null
          const previous = useProjectsStore.getState().preferences.paneLayouts
          setPreferences({ paneLayouts: { ...previous, [id]: layout } })
        }, SAVE_DEBOUNCE_MS)
      }}
    >
      {children}
    </PanelGroup>
  )
}
