// Compatibility entry point for older direct imports.
//
// Git, worktree, and safe-merge logic lives in the shared API module so the
// desktop (Tauri IPC) and web (HTTP core) transports share one implementation.
export * from '../api/git'
