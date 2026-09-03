// Barrel do wrapper de transporte do Alethe. Reexporta a camada de abstração
// unificada (Tauri IPC vs Web REST/WS) em `src/lib/api/`. Call sites keep
// importing from `.../lib/tauri` unchanged — this barrel resolves everything.
// `browserPane`, `browserSession`, `handoff`, `mcp`, `orchestrator`, `pty`, and
// `skills` are not migrated to `lib/api/` yet, so they still export their own
// local (desktop-only) implementations here.

export * from '../api/agents'
export * from '../api/aiMemory'
export * from '../api/changeTrigger'
export * from '../api/cli'
export * from '../api/cloudflareDeploy'
export * from '../api/coreEvents'
export * from '../api/filesystem'
export * from '../api/git'
export * from '../api/mesh'
export * from '../api/misc'
export * from '../api/p2pBridge'
export * from '../api/plugins'
export * from '../api/selfTest'
export * from '../api/profiles'
export * from '../api/sessions'
export * from '../api/syncAccess'
export * from '../api/syncRendezvous'
export * from '../api/syncSecurity'
export * from '../api/syncSubscription'
export * from '../api/transport'
export * from '../api/usage'
export * from '../api/window'
export * from './browserPane'
export * from './browserSession'
export * from './handoff'
export * from './mcp'
export * from './orchestrator'
export * from './pty'
export * from './skills'
