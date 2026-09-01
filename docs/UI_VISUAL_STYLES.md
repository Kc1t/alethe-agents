# Alethe visual styles

Alethe supports two application-wide visual languages. They share behavior, accessibility, theme
palettes, and component logic; only presentation changes.

## Normal

Normal is the production-compatible default. It preserves colored project and group borders,
rounded containers, surfaced rows, and the existing control density. New features must remain fully
usable in Normal before adding Clean-specific presentation.

## Clean

Clean is an opt-in minimal system. Its source of truth is
[`src/styles/visual-clean.css`](../src/styles/visual-clean.css). Component styles may add scoped
rules with `[data-visual-style='clean']`, but should consume the shared tokens from that file.

### Core rules

- Workspace and dense-list surfaces are square. Controls may keep a small radius.
- Dense rows are 30 px high; toolbars are 42 px high.
- Sidebar horizontal padding is 8 px and the standard internal gap is 6 px.
- Borders use the theme border token and stay one pixel wide.
- Hover states change the surface color without lifting, scaling, or adding shadows.
- Active states use the same restrained surface hierarchy and preserve readable status colors.
- Menus and dropdowns share a restrained 180 ms entrance with a short offset and minimal scale;
  dialogs avoid elevated shadows and spring motion.
- Pane focus uses a neutral strong border instead of a colored outer glow.
- Inactive terminal, sub-tab, and top-bar identities are visually muted; only the focused item is
  fully emphasized.
- Project, terminal, and branch text must use flex-safe ellipsis and never overlap actions or badges.
- Interactive labels remain available through visible text, tooltips, or accessible names.

### Shared tokens

| Token | Purpose |
|---|---|
| `--clean-row-height` | Dense project, terminal, task, and inspector rows |
| `--clean-toolbar-height` | Primary sidebar and compact navigation toolbars |
| `--clean-control-height` | Inputs, selects, and compact controls |
| `--clean-sidebar-padding` | Sidebar horizontal inset |
| `--clean-section-gap` | Separation between semantic sections |
| `--clean-item-gap` | Standard icon-to-label and action spacing |
| `--clean-surface-radius` | Workspace and large surface radius |
| `--clean-row-radius` | Dense selectable row radius |
| `--clean-control-radius` | Buttons, inputs, and small control radius |
| `--clean-popover-radius` | Menus, dropdowns, and floating inspectors |
| `--clean-popover-duration` | Shared entrance duration for menus and dropdowns |
| `--clean-popover-ease` | Shared entrance easing for menus and dropdowns |
| `--clean-popover-animation` | Complete reusable popover entrance animation |
| `--clean-modal-radius` | Dialog surfaces |
| `--clean-border` | Standard subtle border |
| `--clean-hover-bg` | Hover surface color |
| `--clean-active-bg` | Selected surface color |
| `--clean-focus-border` | Neutral focused-pane border |
| `--clean-shadow` | Elevation treatment, intentionally none in Clean |

Clean also neutralizes the shared `--shadow-sm`, `--shadow-md`, and `--shadow-lg` tokens and the
theme-colored selection surface, border, and ring tokens. Existing components therefore inherit the
flat elevation and neutral selection model without duplicating overrides. Semantic status colors and
primary actions retain their meaning.

## Implementation pattern

Use base component styles for Normal and a scoped override for Clean:

```css
.item {
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

:global([data-visual-style='clean']) .item {
  min-height: var(--clean-row-height);
  border: 0;
  border-radius: var(--clean-row-radius);
}
```

Do not fork component behavior or state management by visual style. Both modes must render the same
information and expose the same actions.
