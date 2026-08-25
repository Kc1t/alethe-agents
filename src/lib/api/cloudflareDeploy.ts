import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv } from './transport'

/**
 * Desktop-only by design: deploying a personal Cloudflare Worker means writing files and running
 * `npm`/`wrangler` processes on the machine the user is sitting at, and `wrangler login` opens
 * that machine's own browser. There is no meaningful Web-mode equivalent, so unlike most of
 * `lib/api/*`, these calls have no `webApiFetch` fallback.
 */

/** Copies the bundled `services/rendezvous-cloudflare` worker source into a writable directory
 * and returns its path, ready to use as the `cwd` for `npm install` / `wrangler login` /
 * `wrangler deploy` PTY commands. */
export async function getCloudflareDeployWorkdir(): Promise<string> {
  if (!isTauriEnv()) throw new Error('cloudflare_deploy_desktop_only')
  return invoke('cloudflare_deploy_workdir')
}

/** Mints a random local value for the deployed worker's `ABUSE_HASH_KEY` secret. Generated on
 * this device only; never sent anywhere except piped into `wrangler secret put` by the caller. */
export async function generateCloudflareSecret(): Promise<string> {
  if (!isTauriEnv()) throw new Error('cloudflare_deploy_desktop_only')
  return invoke('cloudflare_generate_secret')
}
