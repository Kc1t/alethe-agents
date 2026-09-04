import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv } from './transport'

/**
 * Thin wrapper around `sync_file_pipeline_session.rs` — the event-driven driver that offers a
 * local project folder to a P2P-connected peer and, on the receiving side, stages/verifies/
 * publishes the incoming project tree. Frames for this exchange share the same underlying P2P
 * session chat uses, tagged (`p2pChannel.ts`) so `ChatPanel.tsx`'s single drain loop can route
 * them here instead of to `syncIngestChatTransportFrame`.
 *
 * When there is no direct session — behind a symmetric NAT there never will be — frames go over the
 * rendezvous relay instead, cut into relay-sized fragments and sealed for the peer. That path is
 * slower but it is the difference between a transfer that crawls and one that cannot happen at all,
 * which is what this used to do. Every call therefore carries the peer's X25519 public key: it is
 * what the fragments are sealed to, and without it only the direct path is available.
 */

export type FileSyncEvent =
  | { type: 'stagingStarted'; subscriptionId: string }
  | { type: 'chunkReceived'; chunkId: string; remaining: number }
  | { type: 'syncCompleted'; destination: string }
  | { type: 'peerFinishedReceiving' }
  | { type: 'none' }

/** Starts offering `projectRoot` (a local absolute path) to `remoteAccountRoute` over the
 * existing P2P session — the peer must already be connected (`p2p.state === 'p2p'`). Returns the
 * project id derived from the offer; the actual transfer then proceeds as inbound frames are
 * drained and forwarded to `syncFilePipelineIngestFrame` on both sides. */
export async function syncFilePipelineOfferProject(
  remoteAccountRoute: string,
  projectRoot: string,
  recipientAgreementPublicKey: string,
): Promise<string> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_file_pipeline_offer_project', {
    remoteAccountRoute,
    projectRoot,
    recipientAgreementPublicKey,
  })
}

/** Feeds one already-untagged file-sync frame (drained from the shared P2P queue) into the local
 * state machine — call for every frame with the file-sync channel tag, from either side. */
export async function syncFilePipelineIngestFrame(
  remoteAccountRoute: string,
  frame: number[],
  recipientAgreementPublicKey?: string,
): Promise<FileSyncEvent> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_file_pipeline_ingest_frame', {
    remoteAccountRoute,
    frame,
    recipientAgreementPublicKey: recipientAgreementPublicKey ?? null,
  })
}

/**
 * Feeds one `filesync` envelope delivered by the relay into the local state machine.
 *
 * Resolves to `null` while the transfer is still missing fragments. That is the ordinary state, not
 * an error: a frame is cut into 10 KiB pieces to fit the relay, so most deliveries are a piece of
 * something rather than the whole of it.
 */
export async function syncFilePipelineIngestRelayEnvelope(
  senderAccountRoute: string,
  ciphertext: string,
  recipientAgreementPublicKey?: string,
): Promise<FileSyncEvent | null> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_file_pipeline_ingest_relay_envelope', {
    senderAccountRoute,
    ciphertext,
    recipientAgreementPublicKey: recipientAgreementPublicKey ?? null,
  })
}
