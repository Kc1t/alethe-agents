import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv } from './transport'

/**
 * Thin wrapper around `sync_file_pipeline_session.rs` — the event-driven driver that offers a
 * local project folder to a P2P-connected peer and, on the receiving side, stages/verifies/
 * publishes the incoming project tree. Frames for this exchange share the same underlying P2P
 * session chat uses, tagged (`p2pChannel.ts`) so `ChatPanel.tsx`'s single drain loop can route
 * them here instead of to `syncIngestChatTransportFrame`.
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
export async function syncFilePipelineOfferProject(remoteAccountRoute: string, projectRoot: string): Promise<string> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_file_pipeline_offer_project', { remoteAccountRoute, projectRoot })
}

/** Feeds one already-untagged file-sync frame (drained from the shared P2P queue) into the local
 * state machine — call for every frame with the file-sync channel tag, from either side. */
export async function syncFilePipelineIngestFrame(remoteAccountRoute: string, frame: number[]): Promise<FileSyncEvent> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_file_pipeline_ingest_frame', { remoteAccountRoute, frame })
}
