// Pushes this device's current profile picture to every known chat contact whenever it changes —
// keeps `ChatContactRecord.avatar_thumbnail` on their side live instead of only ever reflecting a
// snapshot from pairing time. Best-effort by design (mirrors `AddChatContactModal.tsx`'s own
// `sendAckToIssuer`): a contact temporarily unreachable just misses this update, no different from
// missing any other relay envelope, and their avatar simply stays as it was until the next change.

import { downscaleAvatar } from '../image/downscaleAvatar'
import { connectRendezvous, sendRendezvousFrame } from './syncRendezvous'
import { syncListChatContacts, syncSealAvatarUpdate } from './syncSecurity'
import { isTauriEnv } from './transport'
import { syncLocalIdentity } from '../tauri'

/** Fire-and-forget: downscales `profileImageUrl` once, then seals+sends an `avatar_update`
 * envelope to every current chat contact. Desktop-only (same reasoning as the rest of the P2P/
 * relay chat stack) — silently a no-op in Web mode. */
export async function broadcastAvatarUpdate(profileImageUrl: string | null): Promise<void> {
  if (!isTauriEnv()) return
  try {
    const [thumbnail, contacts, identity] = await Promise.all([
      downscaleAvatar(profileImageUrl),
      syncListChatContacts(),
      syncLocalIdentity(),
    ])
    if (contacts.length === 0) return
    await connectRendezvous()
    await Promise.all(
      contacts.map(async (contact) => {
        try {
          const ciphertext = await syncSealAvatarUpdate(
            identity.accountRoute,
            thumbnail,
            contact.agreementPublicKey,
          )
          await sendRendezvousFrame({
            type: 'enqueue',
            kind: 'avatar_update',
            id: `avatar_${crypto.randomUUID()}`,
            recipientAccountRoute: contact.accountRoute,
            expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
            ciphertext,
          })
        } catch (cause) {
          console.error('[avatar-sync] failed to notify contact', contact.accountRoute, cause)
        }
      }),
    )
  } catch (cause) {
    console.error('[avatar-sync] broadcastAvatarUpdate failed', cause)
  }
}
