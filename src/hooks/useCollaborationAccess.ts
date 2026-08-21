import { useEffect } from 'react'

import { getLocale, translate } from '../lib/i18n'
import { notifyCollaborationEvent } from '../lib/notifications'
import { type AccessRecord, syncAccessList, syncAccessUpdate } from '../lib/tauri'

function textFor(record: AccessRecord): { title: string; body: string } {
  const t = (key: Parameters<typeof translate>[1]) => translate(getLocale(), key)
  if (record.kind === 'remote_invitation') {
    return {
      title: t('collaboration.notification.invitationTitle'),
      body: t('collaboration.notification.invitationBody'),
    }
  }
  if (record.kind === 'revocation') {
    return {
      title: t('collaboration.notification.securityTitle'),
      body: t('collaboration.notification.revocationBody'),
    }
  }
  if (record.kind === 'connection_candidate') {
    return {
      title: t('collaboration.notification.connectionTitle'),
      body: t('collaboration.notification.connectionBody'),
    }
  }
  return {
    title: t('collaboration.notification.providerTitle'),
    body: t('collaboration.notification.providerBody'),
  }
}

export function useCollaborationAccess(): void {
  useEffect(() => {
    let active = true
    let running = false
    const poll = async () => {
      if (!active || running) return
      running = true
      try {
        const unread = (await syncAccessList()).filter((record) => record.unread)
        for (const record of unread) {
          if (!active) break
          const message = textFor(record)
          await notifyCollaborationEvent(message.title, message.body)
          await syncAccessUpdate(record.id, 'read')
        }
      } catch {
        // The next poll retries. Native delivery already falls back to the in-app history.
      } finally {
        running = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 10_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])
}
