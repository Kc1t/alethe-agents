/**
 * The live P2P session (`p2pSendFrame`/`p2pDrainFrames`) is one shared queue per peer — Phase 4
 * ships exactly one logical stream per session, so chat and file sync cannot each have their own.
 * Every frame sent through it now carries a one-byte channel tag so the single drain loop
 * (`ChatPanel.tsx`) can route each received frame to the right consumer instead of two readers
 * racing to drain the same queue. Must stay in sync with the Rust-side constants of the same name
 * in `sync_file_pipeline_session.rs` — they are not derived from a shared source, so a change to
 * either side without the other silently breaks routing.
 */
export const P2P_CHANNEL_CHAT = 1
export const P2P_CHANNEL_FILE_SYNC = 2

export function tagFrame(tag: number, payload: number[]): number[] {
  return [tag, ...payload]
}

/** `null` for an empty frame (should never happen in practice — nothing sends a zero-byte frame). */
export function untagFrame(frame: number[]): { tag: number; payload: number[] } | null {
  if (frame.length === 0) return null
  return { tag: frame[0], payload: frame.slice(1) }
}
