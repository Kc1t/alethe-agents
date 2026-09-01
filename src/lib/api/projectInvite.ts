import { invoke } from '@tauri-apps/api/core'

import type { PathScope } from '../sync/authorization'
import type { SyncPermission } from '../sync/contracts'

/**
 * Inviting an existing chat contact to a project.
 *
 * Three messages rather than one, because granting access needs a real account id and a saved
 * contact only keeps `accountRoute`, its one-way hash (ADR-0004). The invite asks for the id
 * instead of the app quietly recording one: it travels only on an accept, for one named project.
 * See `src-tauri/src/sync_project_invite.rs` for the full reasoning.
 */

export type ProjectInvitePayload = {
  inviteId: string
  projectId: string
  projectName: string
  fromAccountRoute: string
  sentAtMs: number
}

export type ProjectInviteResponsePayload = {
  inviteId: string
  accepted: boolean
  /** Present only on an accept — the identity the owner needs to issue the grant. */
  accountId?: string | null
  deviceId?: string | null
  agreementPublicKey?: string | null
}

/** Seals an invite naming a project. Carries no grant and no secret. */
export async function sealProjectInvite(params: {
  inviteId: string
  projectId: string
  projectName: string
  fromAccountRoute: string
  recipientAgreementPublicKey: string
  sentAtMs: number
}): Promise<string> {
  return invoke<string>('sync_seal_project_invite', params)
}

/** Opens an invite addressed to this device, or `null` if it wasn't (or isn't from a contact). */
export async function openProjectInvite(ciphertext: string): Promise<ProjectInvitePayload | null> {
  return invoke<ProjectInvitePayload | null>('sync_open_project_invite', { ciphertext })
}

/** Seals the accept/decline. On accept this is where this device hands over its account id. */
export async function sealProjectInviteResponse(params: {
  inviteId: string
  accepted: boolean
  recipientAgreementPublicKey: string
}): Promise<string> {
  return invoke<string>('sync_seal_project_invite_response', params)
}

export async function openProjectInviteResponse(
  ciphertext: string,
): Promise<ProjectInviteResponsePayload | null> {
  return invoke<ProjectInviteResponsePayload | null>('sync_open_project_invite_response', {
    ciphertext,
  })
}

/**
 * Issues the grant after an accept and returns the sealed `chat_contact_confirm` envelope to send
 * back — the same envelope the pairing flow uses, so the invitee's side already knows how to
 * materialize a grant from it.
 */
export async function grantProjectToInvitee(params: {
  projectId: string
  accountId: string
  deviceId: string
  agreementPublicKey: string
  permissions: SyncPermission[]
  pathScopes: PathScope[]
  expiresAtMs: number
}): Promise<string> {
  return invoke<string>('sync_grant_project_to_invitee', params)
}

export type SentProjectInvite = {
  inviteId: string
  projectId: string
  recipientAccountRoute: string
  sentAtMs: number
}

/**
 * Records an invite that has just been sent.
 *
 * Persisted rather than held in memory: the invite stays answerable in the relay mailbox for a
 * day, and the answer alone doesn't say which project it was for — so forgetting it when the app
 * closes meant an invite answered the next morning could never be completed.
 */
export async function rememberSentProjectInvite(params: {
  inviteId: string
  projectId: string
  recipientAccountRoute: string
}): Promise<void> {
  await invoke('sync_remember_sent_project_invite', params)
}

/** Consumes the record for `inviteId`; `null` if it was already answered, expired, or not ours. */
export async function takeSentProjectInvite(inviteId: string): Promise<SentProjectInvite | null> {
  return invoke<SentProjectInvite | null>('sync_take_sent_project_invite', { inviteId })
}
