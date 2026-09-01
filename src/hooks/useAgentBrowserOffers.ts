import { useEffect } from 'react'

import { getLocale, translate } from '../lib/i18n'
import {
  browserPaneObserve,
  listenBrowserTargetOpened,
  type OpenedPage,
  openInBrowser,
} from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

function labelFor(page: OpenedPage): string {
  if (page.title.trim()) return page.title.trim()
  try {
    return new URL(page.url).hostname
  } catch {
    return page.url
  }
}

/**
 * The shared browser has no window, so a page an agent opens is invisible until someone goes looking
 * for it. Much of the time that is right — an agent reading a page needs no UI at all. When it does,
 * the reader picks where it goes, since a page appearing on its own is rarely what they were in the
 * middle of.
 */
export function useAgentBrowserOffers(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let unlisten: (() => void) | null = null

    // Nothing else connects the app to the shared browser. A pane connects only when it opens, so
    // without this the first page an agent opens is the one nobody sees.
    void browserPaneObserve().catch(() => {})

    void listenBrowserTargetOpened((page) => {
      if (cancelled) return
      const projectId = useProjectsStore.getState().activeProjectId
      if (!projectId) return

      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'webPane.agentOpenedTitle'),
        body: translate(getLocale(), 'webPane.agentOpenedBody', { page: labelFor(page) }),
        // Two spelled-out choices rather than a button and an implied "ignore": leaving it in the
        // background is a real answer here, not a failure to respond.
        actions: [
          {
            label: translate(getLocale(), 'webPane.agentOpenedAction'),
            run: () => {
              useProjectsStore.getState().createWebPane(projectId, {
                url: page.url,
                name: labelFor(page),
                engine: 'cdp',
                watchTargetId: page.targetId,
              })
            },
          },
          {
            label: translate(getLocale(), 'webPane.agentOpenedOutside'),
            run: () => {
              // A copy in the reader's own browser, not the agent's tab: nothing can drive a page
              // in someone else's browser, so this shows the page but not the work happening on it.
              void openInBrowser(page.url).catch(() => {})
            },
          },
          {
            label: translate(getLocale(), 'webPane.agentOpenedDismiss'),
            quiet: true,
            run: () => {},
          },
        ],
      })
    }).then((stop) => {
      if (cancelled) stop()
      else unlisten = stop
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [enabled])
}
