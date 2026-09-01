import { createContext, useContext } from 'react'

export type WorkspaceSurfaceInfo = {
  tabId: string | null
  active: boolean
}

const WorkspaceSurfaceContext = createContext<WorkspaceSurfaceInfo | null>(null)

export const WorkspaceSurfaceProvider = WorkspaceSurfaceContext.Provider

export function useWorkspaceSurface(): WorkspaceSurfaceInfo | null {
  return useContext(WorkspaceSurfaceContext)
}
