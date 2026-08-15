# Adding a Theme to Alethe

Adding a custom theme is a great first contribution—it's visual, self-contained, and satisfying. In Alethe, a theme touches seven files/locations because the application UI and terminal palette are configured separately.

Follow these touchpoints from top to bottom when adding a theme.

## The 7 Touchpoints

### 1. Register the Theme ID

Add your theme's unique identifier to the `Theme` union.

**File:** `src/lib/types.ts`

For example, the existing `nord` theme is registered like this:

```typescript
export type Theme =
  | 'dark'
  | 'light'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'solarized'
  | 'tokyo-night'
  | 'vscode'
  | 'min-dark'
  | 'min-light'
  | 'dark-lemon'
  | 'orca'
```

Add your new theme ID to this union.

### 2. Configure the Swatch Preview

Add an entry to `THEME_OPTIONS`. The three colors are used for the theme swatch shown in the theme picker.

**File:** `src/lib/themes.ts`

The existing `nord` entry is:

```typescript
{ id: 'nord', colors: ['#2e3440', '#88c0d0', '#a3be8c'] },
```

The three colors represent, roughly:

1. Background
2. Accent
3. Foreground

Choose colors that represent the main visual characteristics of your theme.

### 3. Implement the UI Token Variables

Add a `[data-theme='<id>']` block containing the theme's CSS custom properties.

**File:** `src/styles/theme.css`

The existing `nord` block is:

```css
[data-theme='nord'] {
  --bg: #2e3440;
  --bg-elevated: #3b4252;
  --bg-sunken: #242933;
  --panel: #434c5e;
  --panel-hover: #4c566a;
  --border: #4c566a;
  --border-strong: rgba(236, 239, 244, 0.24);
  --fg: #eceff4;
  --fg-muted: #d8dee9;
  --fg-faint: #aeb8c8;
  --text-primary: #eceff4;
  --text-secondary: #d8dee9;
  --text-tertiary: #aeb8c8;
  --text-quaternary: #7f8ca2;
  --accent: #88c0d0;
  --accent-strong: #8fbcbb;
  --accent-on: #2e3440;
  --accent-soft: rgba(136, 192, 208, 0.14);
  --accent-faint: rgba(136, 192, 208, 0.14);
  --accent-border: rgba(136, 192, 208, 0.42);
  --accent-ring: rgba(136, 192, 208, 0.18);
  --accent-bg-soft: rgba(136, 192, 208, 0.14);
  --accent-border-soft: rgba(136, 192, 208, 0.36);
  --surface-modal: #3b4252;
  --surface-card-default: #434c5e;
  --surface-card-default-strong: #4c566a;
  --surface-card-selected: rgba(136, 192, 208, 0.14);
  --border-subtle: #4c566a;
  --border-accent: rgba(136, 192, 208, 0.42);
  --status-working: #a3be8c;
  --status-working-soft: rgba(163, 190, 140, 0.16);
  --status-waiting: #ebcb8b;
  --status-waiting-soft: rgba(235, 203, 139, 0.16);
  --status-stopped: #aeb8c8;
  --status-stopped-soft: rgba(174, 184, 200, 0.14);
  --status-disabled: #4c566a;
  --status-offline: #bf616a;
  --status-offline-soft: rgba(191, 97, 106, 0.16);
  --agent-shell: #a3be8c;
  --agent-claude: #d08770;
  --agent-codex: #88c0d0;
  --agent-opencode: #b48ead;
  --focus-ring: #88c0d0;
  --shape-tabs-lane-bg: #242933;
  --shape-tabs-lane-border: rgba(236, 239, 244, 0.08);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.42);
  --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.54);
}
```

The `dark` block defines these groups of tokens:

- **Surfaces:** `--bg`, `--bg-elevated`, `--bg-sunken`, `--panel`, `--panel-hover`, `--border`, `--border-strong`
- **Text:** `--fg`, `--fg-muted`, `--fg-faint`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-quaternary`
- **Accent:** `--accent`, `--accent-strong`, `--accent-on`, `--accent-soft`, `--accent-faint`, `--accent-border`, `--accent-ring`, `--accent-bg-soft`, `--accent-border-soft`
- **Cards and surfaces:** `--surface-modal`, `--surface-card-default`, `--surface-card-default-strong`, `--surface-card-selected`, `--border-subtle`, `--border-accent`
- **Status:** `--status-working`, `--status-working-soft`, `--status-waiting`, `--status-waiting-soft`, `--status-stopped`, `--status-stopped-soft`, `--status-disabled`, `--status-offline`, `--status-offline-soft`, `--status-active`, `--status-idle`
- **Agent colors:** `--agent-shell`, `--agent-claude`, `--agent-codex`, `--agent-opencode`, `--agent-freebuff`, `--agent-mimo`, `--agent-antigravity`, `--agent-shell-soft`, `--agent-claude-soft`, `--agent-codex-soft`, `--agent-opencode-soft`, `--agent-freebuff-soft`, `--agent-mimo-soft`, `--agent-antigravity-soft`
- **Focus:** `--focus-ring`
- **Tabs lane:** `--shape-tabs-lane-bg`, `--shape-tabs-lane-border`
- **Shadows:** `--shadow-sm`, `--shadow-md`, `--shadow-lg`
- **Shape and typography:** `--radius-sm`, `--radius-md`, `--radius-lg`, `--font-sans`, `--font-mono`

The animation tokens (`--anim-instant`, `--anim-fast`, `--anim-normal`, `--anim-slow`, `--ease-spring`, `--ease-out-fluid`, and `--ease-in-out-fluid`) are also defined in the `:root`/`dark` block.

A theme does not have to repeat every token. The `:root` selector provides fallback values for tokens that a theme block omits, so only the values that need to change for the new theme need to be overridden. Existing themes are the best reference for which tokens are worth customizing.

### 4. Add English Localization

Add the user-facing name and description.

**File:** `src/lib/i18n/messages/en.ts`

The existing `nord` entries are:

```typescript
/* ---- theme labels ---- */
'theme.nord.label': 'Nord',
'theme.nord.desc': 'Cool blues and soft contrast.',
```

Use the same key format for the new theme:

```typescript
'theme.<id>.label': '<Theme Name>',
'theme.<id>.desc': '<Short description>',
```

### 5. Add Portuguese (`pt-BR`) Localization

Add the same two keys to the Portuguese translation file.

**File:** `src/lib/i18n/messages/pt-BR.ts`

The existing `nord` entries are:

```typescript
/* ---- theme labels ---- */
'theme.nord.label': 'Nord',
'theme.nord.desc': 'Azuis frios e contraste suave.',
```

The keys must match the English file exactly. The Portuguese values should be translated appropriately.

### 6. Map the Terminal Palette

The terminal uses xterm.js and has its own color palette, so it must be updated separately from the application CSS.

**File:** `src/components/XTermView/xtermThemes.ts`

The existing `nord` palette is:

```typescript
const NORD_THEME = {
  background: '#2e3440',
  foreground: '#eceff4',
  cursor: '#eceff4',
  selectionBackground: '#4c566a',
} as const
```

Then `getXtermTheme()` registers it:

```typescript
export function getXtermTheme(theme: Theme) {
  if (theme === 'light') return LIGHT_THEME
  if (theme === 'dracula') return DRACULA_THEME
  if (theme === 'nord') return NORD_THEME
  // ...
  return DARK_THEME
}
```

Add the new theme's palette and a corresponding condition in `getXtermTheme()`.

ANSI color overrides such as `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and their `bright*` variants are optional. Existing themes provide examples of both minimal and full terminal palettes.

### 7. Add the Theme Icon

Add the theme's PNG asset and register it in the theme icon map.

**Asset:** `src/assets/theme-icons/<id>.png`

The existing `nord.png` is a **220 × 220 PNG with RGBA transparency**. New theme icons should use the same dimensions and PNG format.

Then update:

**File:** `src/lib/themeIcons.ts`

The existing `nord` import and mapping are:

```typescript
import nordIcon from '../assets/theme-icons/nord.png'

export const THEME_ICONS: Record<AppIconTheme, string> = {
  dark: darkIcon,
  light: lightIcon,
  dracula: draculaIcon,
  nord: nordIcon,
  // ...
}
```

Add the new icon import and its entry in `THEME_ICONS`.

## Contrast & Design Guidelines

Alethe has both dark and light themes and is intended for long development sessions. Do not ship foreground/background combinations that are difficult to read.

Check the actual text, muted text, accents, borders, and terminal text against their backgrounds. Avoid highly saturated combinations where the foreground and background visually fight each other. The final theme should remain comfortable to read for extended periods.

## How to Test Your Local Changes

The issue can be verified by following the documentation with a temporary theme:

1. Create a throwaway theme and follow all seven touchpoints above.
2. Run `npm run dev` for frontend-only UI work.
3. Go to **Preferences > Appearance**.
4. Switch to the new theme.
5. Check the theme picker and swatch.
6. Check the application UI.
7. Check the theme icon.
8. Open a terminal and check its background, text, cursor, selection, and terminal colors.
9. Switch between the new theme and another theme to make sure both UI and terminal colors update correctly.
10. Delete the throwaway theme before committing.

For work that requires the terminal/backend, use `npm run app` instead of `npm run dev`.

## Final Checklist

```text
[ ] Theme ID added to src/lib/types.ts
[ ] Theme swatch added to src/lib/themes.ts
[ ] UI tokens added to src/styles/theme.css
[ ] English localization added to src/lib/i18n/messages/en.ts
[ ] Portuguese localization added to src/lib/i18n/messages/pt-BR.ts
[ ] xterm palette added to src/components/XTermView/xtermThemes.ts
[ ] Theme icon PNG added to src/assets/theme-icons/
[ ] Theme icon registered in src/lib/themeIcons.ts
[ ] Picker, UI, terminal, and icon tested locally
```
