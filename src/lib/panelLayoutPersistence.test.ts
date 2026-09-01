import { describe, expect, it } from 'vitest'

import { panelLayoutStorageId, workspacePanelScreenId } from './panelLayoutPersistence'

describe('workspace panel layout persistence', () => {
  it('scopes layouts to the active workspace screen', () => {
    expect(workspacePanelScreenId('tab-a', 'group-a', 'project-a')).toBe('tab-tab-a')
    expect(workspacePanelScreenId(null, 'group-a', 'project-a')).toBe('group-group-a')
    expect(workspacePanelScreenId(null, null, 'project-a')).toBe('project-project-a')
    expect(workspacePanelScreenId(null, null, null)).toBe('workspace')
  })

  it('keeps profiles, screens, and nested groups isolated', () => {
    expect(panelLayoutStorageId('profile-a', 'tab-a', 'pane-project-a')).toBe(
      'alethe-panels:profile-a:tab-a:pane-project-a',
    )
    expect(panelLayoutStorageId('profile-a', 'tab-b', 'pane-project-a')).not.toBe(
      panelLayoutStorageId('profile-a', 'tab-a', 'pane-project-a'),
    )
    expect(panelLayoutStorageId('profile-b', 'tab-a', 'pane-project-a')).not.toBe(
      panelLayoutStorageId('profile-a', 'tab-a', 'pane-project-a'),
    )
  })
})
