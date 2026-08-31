// Pushes this device's own bio to chat contacts — either every one of them (when the bio itself
// changes) or a single one (when opening a conversation with them). Mirrors `avatarSync.ts`
// exactly — same reasoning, same best-effort/throttle behavior — for the bio field instead.

import { connectRendezvous, sendRendezvousFrame } from './syncRendezvous'
import { syncListChatContacts, syncSealBioUpdate } from './syncSecurity'
import { isTauriEnv } from './transport'
import { syncLocalIdentity } from '../tauri'

async function sealAndSendBioUpdate(
  bio: string | null,
  identityAccountRoute: string,
  recipientAccountRoute: string,
  recipientAgreementPublicKey: string,
): Promise<void> {
  const ciphertext = await syncSealBioUpdate(identityAccountRoute, bio, recipientAgreementPublicKey)
  await sendRendezvousFrame({
    type: 'enqueue',
    kind: 'bio_update',
    id: `bio_${crypto.randomUUID()}`,
    recipientAccountRoute,
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    ciphertext,
  })
}

/** Fire-and-forget: seals+sends a `bio_update` envelope (with the current bio, possibly empty) to
 * every current chat contact. Call whenever the bio is saved in Preferences. Desktop-only, silent
 * no-op in Web mode. */
export async function broadcastBioUpdate(bio: string): Promise<void> {
  if (!isTauriEnv()) return
  try {
    const [contacts, identity] = await Promise.all([syncListChatContacts(), syncLocalIdentity()])
    if (contacts.length === 0) return
    await connectRendezvous()
    const trimmed = bio.trim()
    await Promise.all(
      contacts.map((contact) =>
        sealAndSendBioUpdate(trimmed || null, identity.accountRoute, contact.accountRoute, contact.agreementPublicKey).catch(
          (cause) => {
            console.error('[bio-sync] failed to notify contact', contact.accountRoute, cause)
          },
        ),
      ),
    )
  } catch (cause) {
    console.error('[bio-sync] broadcastBioUpdate failed', cause)
  }
}

/** Same throttle reasoning as `avatarSync.ts`'s `sendAvatarUpdateTo`. */
const RESEND_THROTTLE_MS = 5 * 60 * 1000
const lastSentAtByAccountRoute = new Map<string, number>()

/** Sends this device's current bio to exactly one contact — meant to be called every time a
 * conversation with them opens, backfilling anyone who missed the original broadcast (offline at
 * the time, or paired afterward). No-op if the local bio is empty — nothing to backfill. */
export async function sendBioUpdateTo(
  bio: string,
  recipientAccountRoute: string,
  recipientAgreementPublicKey: string,
): Promise<void> {
  if (!isTauriEnv()) return
  const trimmed = bio.trim()
  if (!trimmed) return
  const lastSentAt = lastSentAtByAccountRoute.get(recipientAccountRoute) ?? 0
  if (Date.now() - lastSentAt < RESEND_THROTTLE_MS) return
  lastSentAtByAccountRoute.set(recipientAccountRoute, Date.now())
  try {
    const identity = await syncLocalIdentity()
    await connectRendezvous()
    await sealAndSendBioUpdate(trimmed, identity.accountRoute, recipientAccountRoute, recipientAgreementPublicKey)
  } catch (cause) {
    console.error('[bio-sync] sendBioUpdateTo failed', recipientAccountRoute, cause)
  }
}
