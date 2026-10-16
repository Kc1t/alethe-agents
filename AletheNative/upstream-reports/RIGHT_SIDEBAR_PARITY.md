# Right sidebar web parity handoff

Source: `origin/main`, read without checkout. Scope: `InterfaceStyle.web` only.

## Outcome and validation

- Retained native tabs, headers, cards, file picker and empty-state paths for `.mac`.
- Added Jev after MCP and Plugins after Agents; feature-gated tabs retain their gates.
- Markdown without an opened file now displays the web empty state rather than a directory scan.
- Removed the two web-hidden redundant Markdown header buttons; their existing identifiers remain
  on the unchanged native buttons. Refresh, copy, document tab identifiers are retained.
- MCP uses `AgentLogo(agent:size:)` at 13pt in filters, server presence and skill presence.
- PR header is 44pt; agent list spacing is 6pt. Added missing approval and context-menu icons.
- GSD rows show progress when present, otherwise status, with single-line metadata.
- Agent filters scroll independently of fixed-size scope buttons. Headers and list labels use
  single-line truncation; empty-state descriptions wrap vertically. All dimensions use metrics.
- `python3 AletheNative/Scripts/check-strings.py`: passed.
- `git diff --check`: passed before documentation update; rerun at handoff.
- No build or UI harness run, as instructed. Actual rendering at 1280×800 and 800×500 with zoom
  0.8–1.5 requires reviewer validation; static layout review does not establish pixel parity.

## Deliberate or remaining differences

- Jev and Plugins have no macOS backend. Their controls are disabled. Availability descriptions
  replace the web voice shortcut instructions and augment the plugin empty state. Plugins also
  has an icon and bold title as requested; upstream's plugin empty state is plain text only.
- SF Symbols substitute for Lucide. The Agents bot uses `cpu`; GSD's animated dot matrix uses
  a small native progress indicator. SwiftUI font metrics and Markdown rendering differ from CSS.
- Narrow tab strips and MCP filters scroll to keep the close and scope controls usable.
- Native PR data remains account-wide; project-scoped web fetching and repository-specific empty
  descriptions are not added. Model and schema are unchanged.
- Web planning-document discovery, project Markdown-tab merging and the drag highlight overlay
  are not implemented by this presentation pass. Markdown file opening and drops remain supported.
- Shared `Components.swift`, web changelog and migration plan were not edited.
- No ai-memory skill or writable memory connector is available in this session. This handoff records
  the work state, constraints and next validation steps durably in the existing upstream-reports folder.
- Changes are unstaged; no commit or push was run.

## CSS value ledger

The following ledger pairs reference declarations with their original CSS line numbers. Values
remain in CSS px here and are passed through `metrics.size`, `space`, `radius`, `font` or `monoFont`
as native points. Colors use the corresponding theme tokens. The shared tab style supplies the
28×26 controls, 14pt icon, 4pt radius, 1pt active border and selected panel/strong-border colors.
The normal web stylesheet is the reference; clean-style overrides remain a separate parity gap.

TSX icon sizes: strip 14; Markdown header/actions 15, empty 20, tab file 11 and close 10;
GSD empty 20, busy 13 and idle/error dot 7; Agents header 15, empty 20, maximize 13,
stop and approval icons 11; MCP agent logos 13, search/refresh 13, empty plug 20;
PR header 16, empty 20, refresh/browser 13; Jev header 15, trash 14, empty mic 18;
Plugins header 16, refresh/search 13. The shared controls remain in use; panel-specific label fonts override their default 14pt icon font.

### `src/components/RightSidebar/RightSidebar.module.css`

| Selector | Reference declarations (source line: value) |
| --- | --- |
| `.sidebarTabs` | L14 `gap: 4px`; L15 `min-height: 34px`; L16 `padding: 4px 10px`; L17 `border-bottom: 1px solid var(--border)`; L18 `flex: 0 0 auto` |
| `.sidebarTab` | L25 `gap: 5px`; L26 `width: 28px`; L27 `min-width: 28px`; L28 `height: 26px`; L29 `flex: 0 0 28px`; L30 `padding: 0`; L31 `border: 1px solid transparent`; L32 `border-radius: var(--radius-sm)`; L33 `color: var(--fg-muted)`; L34 `font-size: 0`; L35 `font-weight: 650` |
| `.sidebarTabActive` | L49 `color: var(--fg)`; L50 `background: var(--panel)`; L51 `border-color: var(--border-strong)`; L52 `box-shadow: var(--shadow-sm)` |
| `.toolbarDivider` | L61 `width: 1px`; L62 `height: 14px`; L64 `margin: 0 5px`; L65 `background: var(--border)` |
| `.toolbarUtility` | L69 `width: 28px`; L70 `height: 26px`; L73 `flex: 0 0 28px`; L74 `border-radius: var(--radius-sm)`; L75 `color: var(--fg-muted)` |
| `.gitEmpty, .emptyMarkdown` | L160 `flex: 1`; L161 `min-height: 180px`; L164 `padding: 24px`; L165 `color: var(--fg-muted)` |
| `.emptyMarkdown` | L171 `gap: 8px`; L172 `font-size: 11px` |
| `.emptyMarkdown strong` | L176 `color: var(--fg)`; L177 `font-size: 12px` |
| `.emptyMarkdown span` | L181 `max-width: 240px`; L182 `line-height: 1.45` |
| `.header` | L361 `height: 38px`; L362 `flex: 0 0 auto`; L366 `gap: 8px`; L367 `padding: 0 10px 0 12px`; L368 `border-bottom: 1px solid var(--border)` |
| `.heading` | L372 `flex: 1`; L373 `min-width: 0`; L376 `gap: 7px`; L377 `color: var(--fg)`; L378 `font-size: 12px`; L379 `font-weight: 650` |
| `.headerActions` | L392 `gap: 2px`; L393 `flex: 0 0 auto` |
| `.headerAction` | L397 `width: 24px`; L398 `height: 24px`; L401 `border-radius: var(--radius-sm)`; L402 `color: var(--fg-muted)` |
| `.path` | L411 `flex: 0 0 auto`; L412 `padding: 7px 10px`; L414 `color: var(--fg-faint)`; L415 `border-bottom: 1px solid var(--border)`; L416 `font: 10px/1.35 var(--font-mono)` |
| `.readmeTabs` | L423 `gap: 3px`; L424 `padding: 5px 8px 0`; L426 `border-bottom: 1px solid var(--border)` |
| `.readmeTab` | L433 `flex: 0 0 auto`; L434 `min-width: 0`; L435 `max-width: 180px`; L436 `padding: 0`; L437 `border-bottom: 2px solid transparent`; L438 `color: var(--fg-muted)`; L439 `font-size: 10px` |
| `.readmeTabSelect` | L445 `min-width: 0`; L446 `max-width: 150px`; L448 `gap: 5px`; L449 `padding: 5px 4px 5px 7px` |
| `.readmeTabClose` | L465 `padding: 5px 6px 5px 3px`; L466 `color: var(--fg-muted)` |
| `.content` | L484 `flex: 1`; L485 `min-height: 0`; L487 `padding: 12px` |
| `.empty` | L492 `min-height: 220px`; L497 `gap: 7px`; L498 `padding: 24px`; L499 `color: var(--fg-muted)` |
| `.empty strong` | L504 `color: var(--fg)`; L505 `font-size: 12px` |
| `.empty span` | L509 `max-width: 100%`; L511 `font-size: 11px`; L512 `line-height: 1.4` |
| `.gsdPanel` | L516 `min-height: 0`; L517 `flex: 1`; L519 `padding: 8px 6px 18px` |
| `.gsdList` | L525 `gap: 2px` |
| `.gsdRow` | L529 `min-height: 34px`; L532 `gap: 8px`; L533 `width: 100%`; L534 `padding: 5px 6px`; L535 `border: 1px solid transparent`; L536 `border-radius: var(--radius-sm)`; L537 `color: var(--fg)` |
| `.gsdRowState` | L549 `flex: 0 0 auto`; L553 `width: 14px` |
| `.gsdIdleDot` | L557 `width: 7px`; L558 `height: 7px`; L559 `border-radius: 50%`; L560 `background: var(--status-idle)` |
| `.gsdErrorDot` | L564 `width: 7px`; L565 `height: 7px`; L566 `border-radius: 50%`; L567 `background: var(--status-offline)` |
| `.gsdRowBody` | L571 `min-width: 0`; L572 `flex: 1`; L575 `gap: 1px` |
| `.gsdRowName` | L579 `min-width: 0`; L583 `font-size: 12px`; L584 `font-weight: 500` |
| `.gsdRowMeta` | L588 `min-width: 0`; L592 `color: var(--fg-faint)`; L593 `font-size: 10px`; L595 `letter-spacing: 0.03em` |

### `src/components/RightSidebar/AgentsPanel.module.css`

| Selector | Reference declarations (source line: value) |
| --- | --- |
| `.header` | L10 `min-height: 38px`; L13 `gap: 7px`; L14 `padding: 0 8px 0 12px`; L15 `color: var(--fg)`; L16 `border-bottom: 1px solid var(--border)`; L17 `font-size: 12px`; L18 `font-weight: 650`; L19 `flex: 0 0 auto` |
| `.scope` | L30 `padding: 1px 6px`; L31 `border: 1px solid var(--border)`; L32 `border-radius: 8px`; L33 `color: var(--fg-muted)`; L34 `font-size: 9px`; L35 `font-weight: 600` |
| `.running` | L41 `color: var(--status-working)`; L42 `font-size: 10px`; L43 `font-weight: 600` |
| `.iconAction` | L53 `width: 24px`; L54 `height: 22px`; L58 `border-radius: var(--radius-sm)`; L59 `color: var(--fg-muted)` |
| `.list` | L74 `flex: 1`; L75 `min-height: 0`; L79 `gap: 6px`; L80 `padding: 8px` |
| `.card` | L86 `gap: 8px`; L87 `padding: 8px`; L88 `border: 1px solid var(--border)`; L89 `border-radius: var(--radius-md)`; L90 `background: var(--panel)` |
| `.dot` | L94 `width: 8px`; L95 `height: 8px`; L96 `margin-top: 4px`; L97 `border-radius: 50%`; L99 `background: var(--status-stopped)` |
| `.cardBody` | L125 `flex: 1`; L126 `min-width: 0`; L129 `gap: 4px` |
| `.cardTop` | L135 `gap: 6px`; L136 `min-width: 0` |
| `.cardTitle` | L140 `flex: 1`; L141 `min-width: 0`; L145 `color: var(--fg)`; L146 `font-size: 11px`; L147 `font-weight: 600` |
| `.elapsed` | L152 `color: var(--fg-faint)`; L153 `font-size: 10px` |
| `.cardMeta` | L161 `gap: 6px`; L162 `min-width: 0`; L163 `font-size: 10px`; L164 `color: var(--fg-muted)` |
| `.chip` | L168 `max-width: 100%`; L172 `padding: 1px 6px`; L173 `border: 1px solid var(--border)`; L174 `border-radius: 8px`; L175 `font-weight: 600` |
| `.actions` | L201 `gap: 6px` |
| `.answerButton` | L207 `gap: 4px`; L208 `padding: 2px 8px`; L209 `border: 1px solid var(--border)`; L210 `border-radius: var(--radius-sm)`; L211 `color: var(--fg)`; L212 `background: var(--bg-elevated)`; L213 `font-size: 10px`; L214 `font-weight: 600` |
| `.empty` | L234 `flex: 1`; L235 `min-height: 180px`; L239 `gap: 8px`; L240 `padding: 24px`; L241 `color: var(--fg-muted)`; L243 `font-size: 11px` |
| `.empty strong` | L247 `color: var(--fg)`; L248 `font-size: 12px` |
| `.empty span` | L252 `max-width: 240px`; L253 `line-height: 1.45` |

### `src/components/McpPanel/McpPanel.module.css`

| Selector | Reference declarations (source line: value) |
| --- | --- |
| `.header` | L11 `gap: 8px`; L12 `padding: 10px 10px 8px`; L13 `border-bottom: 1px solid var(--border-subtle)` |
| `.segmented` | L18 `flex: 1`; L19 `min-width: 0`; L20 `background: var(--bg-sunken)`; L21 `border: 1px solid var(--border)`; L22 `border-radius: var(--radius-md)`; L23 `padding: 3px`; L24 `gap: 2px` |
| `.segmented button` | L28 `flex: 1`; L30 `border: 0`; L31 `color: var(--fg-muted)`; L33 `font-size: 12px`; L34 `padding: 4px 8px`; L35 `border-radius: var(--radius-sm)` |
| `.addMore` | L68 `gap: 6px`; L69 `margin: 0 10px 10px`; L70 `padding: 7px 10px`; L71 `border: 1px dashed var(--border-strong)`; L72 `border-radius: var(--radius-md)`; L74 `color: var(--fg-muted)`; L75 `font-size: 12px` |
| `.search input` | L98 `width: 100%`; L99 `background: var(--bg-sunken)`; L100 `border: 1px solid var(--border)`; L101 `border-radius: var(--radius-md)`; L102 `padding: 6px 10px 6px 29px`; L103 `color: var(--fg)`; L105 `font-size: 12.5px` |
| `.stats` | L120 `gap: 10px`; L121 `padding: 8px 12px 6px`; L122 `font-size: 11.5px`; L123 `color: var(--fg-faint)` |
| `.list` | L133 `flex: 1`; L134 `min-height: 0`; L136 `padding: 0 6px 10px` |
| `.row` | L140 `width: 100%`; L143 `gap: 5px`; L144 `padding: 8px`; L146 `border: 1px solid transparent`; L147 `border-radius: var(--radius-md)` |
| `.rowTop` | L162 `gap: 8px`; L163 `min-width: 0` |
| `.name` | L167 `flex: 1`; L168 `min-width: 0`; L169 `font-size: 12.5px`; L170 `font-weight: 500` |
| `.summary` | L177 `font-family: var(--font-mono, monospace)`; L178 `font-size: 10.5px`; L179 `color: var(--fg-faint)` |
| `.badge` | L187 `font-size: 10px`; L188 `line-height: 1`; L189 `padding: 3px 6px`; L190 `border-radius: 20px`; L191 `border: 1px solid var(--border)`; L192 `color: var(--fg-faint)` |
| `.diagnostics` | L201 `border-top: 1px solid var(--border-subtle)`; L202 `padding: 8px 12px 10px`; L205 `gap: 6px` |
| `.diagnosticsTitle` | L209 `font-size: 10.5px`; L210 `letter-spacing: 0.04em`; L212 `color: var(--fg-faint)` |
| `.diagnostic` | L218 `gap: 7px`; L219 `font-size: 11.5px`; L220 `color: var(--fg-muted)`; L221 `min-width: 0` |
| `.diagnosticAgent` | L233 `min-width: 76px`; L234 `color: var(--fg)` |
| `.emptyWrap` | L238 `flex: 1`; L239 `min-height: 0`; L242 `padding: 12px` |
| `.filters` | L258 `gap: 8px`; L259 `padding: 8px 10px 0`; L260 `min-width: 0` |
| `.agentFilter` | L266 `gap: 3px`; L267 `flex: 1`; L268 `min-width: 0` |
| `.agentChip, .agentChipOn` | L276 `width: 24px`; L277 `height: 24px`; L278 `border-radius: var(--radius-sm)`; L279 `border: 1px solid transparent`; L281 `opacity: 0.45` |
| `.agentChipOn` | L290 `opacity: 1`; L291 `background: var(--panel)`; L292 `border-color: var(--border-strong)` |
| `.scopeToggle i` | L328 `width: 1px`; L329 `height: 10px`; L330 `background: var(--border-strong)` |
| `.agentIcons` | L336 `gap: 3px` |

### `src/components/EmptyState/EmptyState.module.css`

| Selector | Reference declarations (source line: value) |
| --- | --- |
| `.root` | L6 `gap: 14px`; L7 `padding: 28px 22px`; L8 `border: 1px solid var(--border)`; L9 `border-radius: var(--radius-lg)`; L10 `background: var(--bg-sunken)`; L11 `color: var(--fg)` |
| `.compact` | L16 `padding: 20px 18px`; L17 `gap: 10px` |
| `.iconWrap` | L25 `width: 56px`; L26 `height: 56px`; L27 `border-radius: 18px`; L30 `color: var(--accent)`; L31 `background: var(--accent-soft)`; L32 `border: 1px solid var(--accent-border)`; L33 `box-shadow: var(--shadow-sm)`; L34 `flex-shrink: 0` |
| `.copy` | L46 `gap: 6px`; L47 `max-width: 40ch` |
| `.compact .title` | L58 `font-size: 15px` |
| `.description` | L62 `color: var(--fg-muted)`; L63 `font-size: 13px`; L64 `line-height: 1.55` |
| `.compact .description` | L68 `font-size: 12px` |
| `.root` | L126 `padding: 22px 16px` |

### `src/components/PullRequestsSidebar/PullRequestsSidebar.module.css`

| Selector | Reference declarations (source line: value) |
| --- | --- |
| `.header` | L12 `flex: 0 0 auto`; L16 `height: 44px`; L17 `padding: 0 10px`; L18 `border-bottom: 1px solid var(--border)` |
| `.heading` | L24 `gap: 7px`; L25 `min-width: 0`; L26 `color: var(--fg)`; L27 `font-size: 14px`; L28 `font-weight: 500` |
| `.scope` | L32 `min-width: 0`; L36 `color: var(--fg-muted)`; L37 `font-size: 11px`; L38 `font-weight: 400` |
| `.refreshButton` | L42 `width: 26px`; L43 `height: 26px`; L46 `border-radius: var(--radius-sm)`; L47 `color: var(--fg-muted)` |
| `.content` | L64 `flex: 1`; L65 `min-height: 0`; L67 `padding: 10px` |
| `.state` | L73 `gap: 8px`; L74 `padding: 16px`; L75 `color: var(--fg-muted)`; L76 `font-size: 12px` |
| `.error` | L84 `padding: 12px`; L85 `border: 1px solid var(--status-offline)`; L86 `border-radius: var(--radius-md)`; L87 `background: var(--status-offline-soft)`; L88 `color: var(--fg)`; L89 `font-size: 12px` |
| `.empty` | L93 `min-height: 220px`; L98 `gap: 7px`; L99 `padding: 24px`; L100 `color: var(--fg-muted)` |
| `.emptyIcon` | L105 `width: 38px`; L106 `height: 38px`; L109 `margin-bottom: 3px`; L110 `border: 1px solid var(--border)`; L111 `border-radius: var(--radius-md)`; L112 `background: var(--bg-elevated)`; L113 `color: var(--fg-faint)` |
| `.empty strong` | L117 `color: var(--fg)`; L118 `font-size: 12px` |
| `.empty span` | L122 `max-width: 210px`; L123 `font-size: 11px`; L124 `line-height: 1.45` |
| `.list` | L129 `grid-template-columns: minmax(0, 1fr)`; L130 `gap: 8px` |
| `.card` | L134 `min-width: 0`; L135 `padding: 10px 12px`; L136 `border: 1px solid var(--border)`; L137 `border-radius: var(--radius-md)`; L138 `background: var(--bg-elevated)` |
| `.cardTop` | L144 `gap: 8px`; L145 `color: var(--fg-faint)`; L146 `font: 10px var(--font-mono)` |
| `.repo` | L150 `min-width: 0`; L154 `flex: 1` |
| `.number` | L158 `flex: 0 0 auto` |
| `.draftBadge` | L162 `flex: 0 0 auto`; L163 `padding: 1px 6px`; L164 `border-radius: 999px`; L165 `background: var(--status-waiting-soft)`; L166 `color: var(--status-waiting)`; L168 `letter-spacing: 0.03em` |
| `.title` | L172 `margin: 6px 0`; L176 `color: var(--fg)`; L177 `font-size: 13px`; L178 `font-weight: 500` |
| `.meta` | L182 `margin: 0`; L183 `color: var(--fg-faint)`; L184 `font-size: 11px` |
| `.actions` | L190 `gap: 6px`; L191 `margin-top: 10px` |
| `.actionLink, .actionButton` | L198 `gap: 5px`; L199 `height: 26px`; L200 `padding: 0 10px`; L201 `border: 1px solid var(--border)`; L202 `border-radius: var(--radius-sm)`; L203 `color: var(--fg-muted)`; L205 `font-size: 11px` |
| `.actionLink` | L211 `width: 26px`; L212 `padding: 0` |
| `.actionButton` | L223 `flex: 1`; L225 `border-color: var(--accent-border)`; L226 `background: var(--accent-soft)`; L227 `color: var(--fg)` |

### `src/components/VoiceHistoryPanel/VoiceHistoryPanel.module.css`

| Selector | Reference declarations (source line: value) |
| --- | --- |
| `.header` | L12 `flex: 0 0 auto`; L16 `height: 44px`; L17 `padding: 0 10px`; L18 `border-bottom: 1px solid var(--border)` |
| `.heading` | L24 `gap: 7px`; L25 `color: var(--fg)`; L26 `font-size: 14px`; L27 `font-weight: 500` |
| `.clearButton` | L31 `width: 26px`; L32 `height: 26px`; L35 `border-radius: var(--radius-sm)`; L36 `color: var(--fg-muted)` |
| `.content` | L49 `flex: 1`; L50 `min-height: 0`; L52 `padding: 10px` |
| `.empty` | L56 `min-height: 220px`; L61 `gap: 7px`; L62 `padding: 24px`; L63 `color: var(--fg-muted)` |
| `.emptyIcon` | L68 `width: 38px`; L69 `height: 38px`; L72 `margin-bottom: 3px`; L73 `border: 1px solid var(--border)`; L74 `border-radius: var(--radius-md)`; L75 `background: var(--bg-elevated)`; L76 `color: var(--fg-faint)` |
| `.empty strong` | L80 `color: var(--fg)`; L81 `font-size: 12px` |
| `.empty span` | L85 `max-width: 210px`; L86 `font-size: 11px`; L87 `line-height: 1.45` |

### `src/components/PluginsSidebar/PluginsSidebar.module.css`

| Selector | Reference declarations (source line: value) |
| --- | --- |
| `.header` | L12 `flex: 0 0 auto`; L16 `height: 44px`; L17 `padding: 0 10px`; L18 `border-bottom: 1px solid var(--border)` |
| `.heading` | L24 `gap: 7px`; L25 `min-width: 0`; L26 `color: var(--fg)`; L27 `font-size: 14px`; L28 `font-weight: 500` |
| `.refreshButton` | L38 `width: 26px`; L39 `height: 26px`; L42 `border-radius: var(--radius-sm)`; L43 `color: var(--fg-muted)` |
| `.searchRow` | L66 `flex: 0 0 auto`; L69 `gap: 6px`; L70 `padding: 8px 10px`; L71 `color: var(--fg-muted)`; L72 `border-bottom: 1px solid var(--border)` |
| `.search` | L76 `flex: 1`; L77 `min-width: 0`; L78 `height: 26px`; L79 `padding: 0 8px`; L80 `border: 1px solid var(--border)`; L81 `border-radius: var(--radius-sm)`; L82 `background: var(--bg-elevated)`; L83 `color: var(--fg)`; L84 `font-size: 12px` |
| `.content` | L93 `flex: 1`; L94 `min-height: 0`; L96 `padding: 10px` |
| `.empty` | L100 `padding: 24px 12px`; L101 `color: var(--fg-muted)`; L102 `font-size: 11px` |

### Shared refresh control

`src/components/modals/controls.module.css:223–243`: `.iconBtnSm` uses width/height 26,
padding 0, transparent border 1, radius `--radius-sm`, `--fg-muted`; hover uses
`--panel-hover` / `--fg`; disabled uses `--fg-faint`.
