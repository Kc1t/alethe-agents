import type { PluginSource } from './types'

/**
 * Whether turning a plugin on has to be confirmed first.
 *
 * Enabling is the moment consent is given: a plugin runs with the app's own power, so a plugin that
 * arrived on this machine — imported, pasted or installed from the catalogue — is never switched on
 * by a single click. What ships with Alethe is already part of it, and turning it back on is not a
 * new decision. Turning anything *off* needs no ceremony: withdrawing consent is always allowed.
 *
 * This lives apart from either screen because both the Preferences list and the marketplace enable
 * plugins, and a rule that exists twice is a rule that will soon exist in one version.
 */
export function requiresTrustConfirmation(source: PluginSource, next: boolean): boolean {
  return next && source === 'local'
}
