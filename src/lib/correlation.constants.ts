/**
 * The invoke-argument key that carries the correlation id to Rust.
 *
 * Kept in its own module so both the frontend wrapper and the contract test can import it without
 * pulling in the browser-only `window.__TAURI_INTERNALS__` code. Must stay identical to
 * `CORRELATION_ARG` in `src-tauri/src/obs_ipc.rs`; a silent drift between the two would leave every
 * record uncorrelated while everything still appeared to work.
 */
export const CORRELATION_ARG = '__corr'
