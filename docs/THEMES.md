# Adding a Theme to Alethe

There are two ways to add a theme, and the one you want is almost always the first.

## As a plugin (recommended)

A theme plugin registers everything at runtime — palette, picker swatch, terminal colors — without
touching the app's stylesheet or any type union. It can be enabled and disabled without a restart.
Read [`PLUGINS.md`](PLUGINS.md) first for the manifest and lifecycle; this page covers the theme
contribution itself.

### 1. Contribute the theme

```ts
import type { PluginContext, PluginModule } from '../../lib/plugins'

const plugin: PluginModule = {
  activate(context: PluginContext) {
    context.contributes.theme({
      id: 'midnight',
      label: 'Midnight',
      description: 'Cold blues on near-black.',
      swatch: ['#0b0d12', '#1b2130', '#7aa2f7'],
      tokens: {
        '--bg': '#0b0d12',
        '--fg': '#e6e9ef',
        '--accent': '#7aa2f7',
        // …
      },
      terminal: {
        background: '#0b0d12',
        foreground: '#e6e9ef',
        cursor: '#7aa2f7',
      },
    })
  },
}

export default plugin
```

The manifest must declare `"capabilities": ["ui.theme"]`, or activation fails.

### 2. What each field does

- **`id`** — must match `^[a-z][a-z0-9-]*$`. It becomes part of a `[data-theme='…']` selector.
- **`label`** / **`description`** — shown in the picker. If a `theme.<id>.label` message is
  registered they win; otherwise these strings are used as-is. Bundled official themes keep their
  translated keys in core i18n; third-party themes are named by their author and are not translated.
- **`swatch`** — background, accent, foreground. Drives the three-color preview and the light/dark
  guess.
- **`light`** — set it when the luminance guess from `swatch[0]` gets it wrong. It decides light
  artwork, the mermaid theme, and the terminal base palette.
- **`tokens`** — CSS custom properties. Names must carry the leading `--`.
- **`terminal`** — xterm palette entries, merged over the built-in light or dark base. Omit it and
  the terminal follows the base for your mode.

### 3. Token reference

Start from the `:root, [data-theme='dark']` block in `src/styles/theme.css` — it defines the full
set and acts as the fallback, so you only need to override what differs. The groups are: surfaces
(`--bg`, `--bg-elevated`, `--bg-sunken`, `--panel`, `--panel-hover`, `--border`, `--border-strong`),
text (`--fg*`, `--text-*`), accent (`--accent`, `--accent-strong`, `--accent-on`, `--accent-soft`,
`--accent-faint`, `--accent-border`, `--accent-ring`, `--accent-bg-soft`, `--accent-border-soft`),
cards (`--surface-*`, `--border-subtle`, `--border-accent`), status (`--status-*`), per-agent brand
(`--agent-*`), the project palette (`--project-*`), and misc (`--focus-ring`, `--shape-tabs-lane-*`,
`--shadow-*`, `--radius-*`, `--font-*`).

### 4. What is validated

Contributed tokens are sanitized before they reach the page (`src/lib/themeTokens.ts`). A token is
dropped when:

- the name is not a custom property (`--kebab-case`, lowercase);
- the value is empty, longer than 240 characters, or contains `url(`, `image-set(`, `expression(`,
  `javascript:`, `data:`, `@`, `;`, `{`, `}`, `<`, `>`, `\`, or a comment sequence.

So a theme can style the UI but cannot reach the network or inject rules of its own. Dropping is
silent and per-token — one bad value does not cost the theme its other colors.

If the whole theme is unavailable (its plugin is disabled, or it was uninstalled), the app renders
the default theme and **keeps your stored choice**, so re-enabling the plugin restores it.

## As a built-in

Only for a theme that is part of the product's identity. It costs six touchpoints and a type change,
which is exactly the cost the plugin path exists to avoid.

1. `src/lib/types.ts` — add the id to the `BuiltinTheme` union.
2. `src/lib/themes.ts` — add a `BUILTIN_THEME_OPTIONS` entry with the three swatch colors.
3. `src/styles/theme.css` — add a `[data-theme='<id>']` block.
4. `src/lib/i18n/messages/en.ts` — add `theme.<id>.label` and `theme.<id>.desc`.
5. `src/lib/i18n/messages/pt-BR.ts` — the same keys. `pt-BR.ts` is typed against `en.ts`, so
   `npm run build` fails if one is missing.
6. `src/components/XTermView/xtermThemes.ts` — add the palette to `XTERM_THEMES`, which
   `satisfies Record<BuiltinTheme, unknown>` and will not compile without it.

`src/lib/themes.test.ts` asserts that the built-in list, the CSS blocks, and the i18n keys stay in
sync in both directions, so a half-finished built-in theme fails the test suite.

> App icons are a separate, independent four-value `AppIconTheme` union
> (`src/lib/themeIcons.ts`) — a new theme does not need one.
