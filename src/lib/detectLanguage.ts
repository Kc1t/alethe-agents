// Local, offline language detection for commit messages. Deliberately not a general-purpose
// detector: it only has to answer "is this text in the language the app is set to, or not?", well
// enough to decide whether to offer a translate button. Nothing here touches the network — that is
// the point, since detection runs on every commit the user opens while translation only happens on
// an explicit click.

export type DetectedLanguage = 'en' | 'pt-BR'

/** Function words carry the signal: they are frequent, short, and rarely shared between the two
 * languages. Content words in a commit message are mostly code identifiers and English jargon
 * ("fix", "refactor", "commit") even when the sentence around them is Portuguese, so counting
 * those would classify almost everything as English. */
const PORTUGUESE_MARKERS = new Set([
  'a',
  'ao',
  'aos',
  'as',
  'às',
  'com',
  'como',
  'da',
  'das',
  'de',
  'do',
  'dos',
  'e',
  'em',
  'ele',
  'ela',
  'era',
  'essa',
  'esse',
  'está',
  'estava',
  'foi',
  'for',
  'isso',
  'já',
  'mais',
  'mas',
  'me',
  'mesmo',
  'na',
  'nas',
  'não',
  'no',
  'nos',
  'num',
  'numa',
  'o',
  'os',
  'ou',
  'para',
  'pela',
  'pelo',
  'por',
  'porque',
  'quando',
  'que',
  'se',
  'sem',
  'ser',
  'seu',
  'sua',
  'só',
  'também',
  'tem',
  'ter',
  'um',
  'uma',
  'vez',
  'você',
  'agora',
  'ainda',
  'antes',
  'depois',
  'onde',
  'quem',
  'todos',
  'toda',
  'está',
  'estão',
  'fazer',
  'feito',
  'sendo',
  'pois',
  'até',
  'entre',
  'sobre',
  'muito',
])

const ENGLISH_MARKERS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'not',
  'of',
  'on',
  'or',
  'she',
  'should',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'were',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'we',
  'our',
  'because',
  'after',
  'before',
  'now',
  'still',
  'about',
  'between',
  'over',
  'only',
  'every',
  'each',
  'also',
])

/** Words that belong to both lists ("a", "e"/"and" collisions, "no", "for", "do", "as", "os"…)
 * would otherwise let one language's grammar be counted as the other's. */
const AMBIGUOUS = new Set([...PORTUGUESE_MARKERS].filter((word) => ENGLISH_MARKERS.has(word)))

/** Characters that essentially only appear in Portuguese here. A single one is not proof (a name,
 * a quoted string), so this contributes weight rather than deciding on its own. */
const PORTUGUESE_CHARACTERS = /[ãõçáéíóúâêôàü]/i

/** Minimum number of decisive marker words before a verdict is trusted. A commit subject like
 * "fix: typo" carries no grammar at all, and guessing on it would mislabel messages and offer to
 * translate text that needs no translation. */
const MIN_MARKERS = 2

/**
 * Best guess at which language `text` is written in, or `null` when the text carries too little
 * signal to tell — the common case for short, keyword-only commit subjects. Callers should treat
 * `null` as "don't offer translation", never as a default language.
 */
export function detectLanguage(text: string): DetectedLanguage | null {
  const words = text
    .toLocaleLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)

  let portuguese = 0
  let english = 0
  for (const word of words) {
    if (AMBIGUOUS.has(word)) continue
    if (PORTUGUESE_MARKERS.has(word)) portuguese += 1
    else if (ENGLISH_MARKERS.has(word)) english += 1
  }

  // Accented characters are a strong hint but not a verdict on their own: they only break a tie or
  // reinforce an existing lean, never outvote a clear count of English function words.
  if (PORTUGUESE_CHARACTERS.test(text)) portuguese += 1

  const decisive = Math.max(portuguese, english)
  if (decisive < MIN_MARKERS) return null
  if (portuguese === english) return null
  return portuguese > english ? 'pt-BR' : 'en'
}
