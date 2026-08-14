/**
 * Compatibility entry point for older direct imports.
 *
 * PTY transport, profile ownership, and browser/Tauri routing live in the
 * shared API module so no caller can bypass the active ownership contract.
 */
export * from '../api/pty'
