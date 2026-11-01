import { createContext, useContext } from 'react'

import type { TFunction } from '../../../../lib/i18n'
import type { PlaybooksState } from '../../../../lib/playbooks/state'
import type { Theme } from '../../../../lib/types'

export type PlaybooksEditorContext = {
  s: PlaybooksState
  t: TFunction
  theme: Theme
  lightTheme: boolean
  touch: (global?: boolean) => void
  redraw: () => void
  select: (id: string | null) => void
  selectedId: string | null
}

export const PlaybooksContext = createContext<PlaybooksEditorContext | null>(null)

export function usePlaybooks(): PlaybooksEditorContext {
  const value = useContext(PlaybooksContext)
  if (!value) throw new Error('usePlaybooks outside the playbooks editor')
  return value
}
