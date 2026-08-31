// Pushes this device's current profile picture to chat contacts — either every one of them (when
// the picture itself changes) or a single one (when opening a conversation with them — see
// `sendAvatarUpdateTo` below). Keeps `ChatContactRecord.avatar_thumbnail` on their side live
// instead of only ever reflecting a snapshot from pairing time. Best-effort by design (mirrors
// `AddChatContactModal.tsx`'s own `sendAckToIssuer`): a contact temporarily unreachable just
// misses this update, no different from missing any other relay envelope.

import { downscaleAvatar } from '../image/downscaleAvatar'
import { connectRendezvous, sendRendezvousFrame } from './syncRendezvous'
import { syncListChatContacts, syncSealAvatarUpdate } from './syncSecurity'
import { isTauriEnv } from './transport'
import { syncLocalIdentity } from '../tauri'

async function sealAndSendAvatarUpdate(
  thumbnail: string | null,
  identityAccountRoute: string,
  recipientAccountRoute: string,
  recipientAgreementPublicKey: string,
): Promise<void> {
  const ciphertext = await syncSealAvatarUpdate(identityAccountRoute, thumbnail, recipientAgreementPublicKey)
  await sendRendezvousFrame({
    type: 'enqueue',
    kind: 'avatar_update',
    id: `avatar_${crypto.randomUUID()}`,
    recipientAccountRoute,
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    ciphertext,
  })
}

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
      contacts.map((contact) =>
        sealAndSendAvatarUpdate(thumbnail, identity.accountRoute, contact.accountRoute, contact.agreementPublicKey).catch(
          (cause) => {
            console.error('[avatar-sync] failed to notify contact', contact.accountRoute, cause)
          },
        ),
      ),
    )
  } catch (cause) {
    console.error('[avatar-sync] broadcastAvatarUpdate failed', cause)
  }
}

/** Throttle window per recipient — opening the same conversation repeatedly in one session (e.g.
 * navigating away and back) must not re-send the same small envelope every single time; a few
 * minutes is enough to still recover promptly from the actual gap this exists for (a contact who
 * never received any avatar update at all, or missed the one sent while offline). */
const RESEND_THROTTLE_MS = 5 * 60 * 1000
const lastSentAtByAccountRoute = new Map<string, number>()

/** Sends this device's current profile picture to exactly one contact — meant to be called every
 * time a conversation with them opens, not only when the picture changes. Closes the gap
 * `broadcastAvatarUpdate` alone leaves: that function only fires at the moment the picture is
 * *changed*, so a contact who was offline during that moment, or who was paired *after* it, never
 * receives it — nothing ever re-sends or backfills it otherwise. This is the backfill: cheap,
 * idempotent (the recipient just overwrites its stored thumbnail with whatever arrives), and
 * throttled per contact so opening the same chat repeatedly doesn't spam the relay. */
export async function sendAvatarUpdateTo(
  profileImageUrl: string | null,
  recipientAccountRoute: string,
  recipientAgreementPublicKey: string,
): Promise<void> {
  if (!isTauriEnv()) return
  if (!profileImageUrl) return // nothing to send — avoid overwriting a good thumbnail with null
  const lastSentAt = lastSentAtByAccountRoute.get(recipientAccountRoute) ?? 0
  if (Date.now() - lastSentAt < RESEND_THROTTLE_MS) return
  lastSentAtByAccountRoute.set(recipientAccountRoute, Date.now())
  try {
    const [thumbnail, identity] = await Promise.all([downscaleAvatar(profileImageUrl), syncLocalIdentity()])
    await connectRendezvous()
    await sealAndSendAvatarUpdate(thumbnail, identity.accountRoute, recipientAccountRoute, recipientAgreementPublicKey)
  } catch (cause) {
    console.error('[avatar-sync] sendAvatarUpdateTo failed', recipientAccountRoute, cause)
  }
}
