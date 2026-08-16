// Barrel do wrapper de IPC do Alethe. Reexporta todos os comandos do backend,
// agora divididos por domínio dentro de `src/lib/tauri/`. Os call-sites seguem
// importando de `.../lib/tauri` sem mudança — este barrel resolve tudo.

export * from './agents'
export * from './cli'
export * from './filesystem'
export * from './git'
export * from './githubPr'
export * from './graphify'
export * from './aiMemory'
export * from './misc'
export * from './profiles'
export * from './pty'
export * from './sessions'
export * from './usage'
export * from './window'
