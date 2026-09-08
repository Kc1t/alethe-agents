import type { DiffSummaryEntry } from './api/git'
import type { TFunction } from './i18n'

/** A file the previous procedure claims to cover, but which has changed since that claim was
 *  written. Reported separately from the plain list because it calls for a different decision:
 *  amend the step that already exists, or add a new one. */
export type StaleCoverage = {
  path: string
  stepSummary: string
}

/** How many files the prompt lists individually before switching to a count. A prompt that pastes
 *  four hundred paths into a terminal costs tokens, scrolls the conversation away, and tells the
 *  agent nothing it cannot get from the repository itself. */
export const MAX_LISTED_FILES = 60

function formatCounts(entry: DiffSummaryEntry): string {
  // Binary files carry no line counts. Saying "+0 -0" would be a lie; the path alone is honest.
  if (entry.additions == null || entry.deletions == null) return ''
  return ` (+${entry.additions} -${entry.deletions})`
}

/**
 * Builds the prompt asking the agent to write up the procedure for the work it just did.
 *
 * Delivered into the agent's own terminal, so it is text the user watches being typed — which is
 * why it goes through `t()` and arrives in the app's language rather than the repository's.
 *
 * The shape is deliberate. It states what changed rather than asking the agent to go find out
 * (it has the diff already, and a prompt that starts with a research task gets a research answer);
 * it demands that no changed file go unmentioned while explicitly allowing one step to cover many,
 * because a forty-file refactor written as forty steps produces filler; and it asks for a
 * verification per step, which is the part that separates a procedure from a changelog.
 */
export function buildChangeProcedurePrompt(
  t: TFunction,
  changed: DiffSummaryEntry[],
  stale: StaleCoverage[] = [],
): string {
  const listed = changed.slice(0, MAX_LISTED_FILES)
  const overflow = changed.length - listed.length

  const lines: string[] = [
    t('changeTrigger.promptIntro', { count: changed.length }),
    '',
    t('changeTrigger.promptFilesHeader'),
    ...listed.map((entry) => `- ${entry.path}${formatCounts(entry)}`),
  ]
  if (overflow > 0) lines.push(t('changeTrigger.promptFilesOverflow', { count: overflow }))

  lines.push('', t('changeTrigger.promptRulesHeader'))
  lines.push(t('changeTrigger.promptRuleCoverage'))
  lines.push(t('changeTrigger.promptRuleGrouping'))
  lines.push(t('changeTrigger.promptRuleVerification'))

  if (stale.length > 0) {
    lines.push('', t('changeTrigger.promptStaleHeader'))
    for (const item of stale) {
      lines.push(t('changeTrigger.promptStaleItem', { path: item.path, step: item.stepSummary }))
    }
    lines.push(t('changeTrigger.promptStaleChoice'))
  }

  return lines.join('\n')
}
