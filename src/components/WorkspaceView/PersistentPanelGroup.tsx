import { Group, type GroupProps, useDefaultLayout } from 'react-resizable-panels'

import { panelLayoutStorageId, workspacePanelScreenId } from '../../lib/panelLayoutPersistence'
import { useProjectsStore } from '../../stores/projectsStore'

type PersistentPanelGroupProps = Omit<
  GroupProps,
  'defaultLayout' | 'id' | 'onLayoutChange' | 'onLayoutChanged'
> & {
  persistenceId: string
  panelIds: string[]
}

export function PersistentPanelGroup({
  persistenceId,
  panelIds,
  ...props
}: PersistentPanelGroupProps) {
  const profileId = useProjectsStore((state) => state.activeProfileId)
  const activeTabId = useProjectsStore((state) => state.workspace.activeTabId)
  const activeGroupId = useProjectsStore((state) => state.workspace.activeGroupId)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const screenId = workspacePanelScreenId(activeTabId, activeGroupId, activeProjectId)
  const storageId = panelLayoutStorageId(profileId, screenId, persistenceId)
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: storageId,
    panelIds,
  })

  return (
    <Group
      {...props}
      id={storageId}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    />
  )
}
