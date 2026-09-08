import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv } from './transport'

/**
 * Thin wrapper around the GitHub Gist signaling fallback (`sync_rendezvous_git.rs`) — an
 * additional, opt-in candidate-exchange channel alongside the primary Cloudflare rendezvous relay
 * (`syncRendezvous.ts`), never a replacement for it. Only ever carries the same small, already
 * X25519-encrypted candidate ciphertext `p2pBridge.ts`'s `prepareRemoteCandidate` produces — this
 * module has no idea what's inside it, it only ships bytes to/from a Gist.
 */

export async function githubSignalingSetToken(token: string): Promise<void> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  await invoke('sync_github_signaling_set_token', { token })
}

export async function githubSignalingClearToken(): Promise<void> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  await invoke('sync_github_signaling_clear_token')
}

export async function githubSignalingHasToken(): Promise<boolean> {
  if (!isTauriEnv()) return false
  return invoke('sync_github_signaling_has_token')
}

/** Creates a fresh signaling Gist under the caller's own GitHub account. Call once per device —
 * the resulting id belongs in every future pairing invitation this device issues, not re-created
 * per session. */
export async function githubSignalingCreateGist(): Promise<string> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_github_signaling_create_gist')
}

export async function githubSignalingPublishCandidate(params: {
  gistId: string
  sessionId: string
  senderDeviceId: string
  ciphertext: string
}): Promise<void> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  await invoke('sync_github_signaling_publish_candidate', {
    gistId: params.gistId,
    sessionId: params.sessionId,
    senderDeviceId: params.senderDeviceId,
    ciphertext: params.ciphertext,
  })
}

/** Returns the peer's candidate ciphertext for this session, or `null` if nothing new is there
 * yet — callers should poll this on their own interval/timeout, an empty result is not a failure. */
export async function githubSignalingPollCandidate(params: {
  gistId: string
  sessionId: string
  localDeviceId: string
}): Promise<string | null> {
  if (!isTauriEnv()) return null
  return invoke('sync_github_signaling_poll_candidate', {
    gistId: params.gistId,
    sessionId: params.sessionId,
    localDeviceId: params.localDeviceId,
  })
}

export async function githubSignalingCleanupSession(
  gistId: string,
  sessionId: string,
): Promise<void> {
  if (!isTauriEnv()) return
  await invoke('sync_github_signaling_cleanup_session', { gistId, sessionId })
}
