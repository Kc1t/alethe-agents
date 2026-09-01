export function workspacePanelScreenId(
  activeTabId: string | null,
  activeGroupId: string | null,
  activeProjectId: string | null,
): string {
  if (activeTabId) return `tab-${activeTabId}`
  if (activeGroupId) return `group-${activeGroupId}`
  if (activeProjectId) return `project-${activeProjectId}`
  return 'workspace'
}

export function panelLayoutStorageId(
  profileId: string,
  screenId: string,
  persistenceId: string,
): string {
  return `alethe-panels:${profileId}:${screenId}:${persistenceId}`
}
