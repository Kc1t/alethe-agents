/** Bundled with the app (see `src/styles/theme.css`), so it is the same font on every OS. */
export const TERMINAL_FONT_FACE = 'Caskaydia Cove Nerd Font Mono'

/**
 * The bundled face first: it carries the Powerline and Nerd Font glyphs TUIs draw with. Without it
 * Linux fell back to Liberation Mono, and any glyph that font lacks came from a third font with
 * other widths, overlapping its neighbours on xterm's fixed grid.
 */
export const TERMINAL_FONT_FAMILY = `"${TERMINAL_FONT_FACE}", "Cascadia Mono", Consolas, monospace`

/** What the terminal switches to once the bundled face has loaded. */
export const LOADED_TERMINAL_FONT_FAMILY = `"${TERMINAL_FONT_FACE}", monospace`

type FontSource = Pick<FontFaceSet, 'check' | 'load'>

/**
 * xterm measures its cells once, from whatever font is ready when it opens, and only measures
 * again when the font option changes. If the bundled face was still loading, this calls `apply`
 * with an equivalent but different family once it is ready, which makes xterm measure again.
 */
export function remeasureWhenFontLoads(
  fontSize: number,
  apply: (fontFamily: string) => void,
  fonts: FontSource | undefined = typeof document === 'undefined' ? undefined : document.fonts,
): void {
  if (!fonts) return
  const spec = `${fontSize}px "${TERMINAL_FONT_FACE}"`
  if (fonts.check(spec)) return
  void fonts
    .load(spec)
    .then((loaded) => {
      if (loaded.length > 0) apply(LOADED_TERMINAL_FONT_FAMILY)
    })
    .catch(() => {
      /* The fallbacks in TERMINAL_FONT_FAMILY stay in effect. */
    })
}
