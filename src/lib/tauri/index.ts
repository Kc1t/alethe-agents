// Barrel do wrapper de transporte do Alethe. Reexporta a camada de abstração
// unificada (Tauri IPC vs Web REST/WS) em `src/lib/api/`. Os call-sites seguem
// importando de `.../lib/tauri` sem nenhuma alteração — este barrel resolve tudo.
// `handoff`, `mcp`, and `skills` are not migrated to `lib/api/` yet, so they
// still export their own local (desktop-only) implementations here.

export * from '../api/agents'
export * from '../api/aiMemory'
export * from '../api/cli'
export * from '../api/coreEvents'
export * from '../api/filesystem'
export * from '../api/git'
export * from '../api/graphify'
export * from '../api/mesh'
export * from '../api/misc'
export * from '../api/profiles'
export * from '../api/sessions'
export * from '../api/syncAccess'
export * from '../api/syncRendezvous'
export * from '../api/syncSecurity'
export * from '../api/syncSubscription'
export * from '../api/transport'
export * from '../api/usage'
export * from '../api/window'
export * from './handoff'
export * from './mcp'
export * from './pty'
export * from './skills'
