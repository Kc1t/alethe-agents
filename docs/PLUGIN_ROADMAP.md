# Plugin System — Roadmap and Handoff

Status of this document: **implementation brief**. It describes what already ships, the decisions
behind it, and the work that comes next in priority order.

Read [`PLUGINS.md`](PLUGINS.md) first — it is the reference for the contract as it exists today.
This file is about what to build on top of it.

---

## 1. What already ships

A working plugin system with two official bundled plugins. Not a prototype: it is on the main path,
covered by tests, and the app's own features go through it.

| Piece | Where |
|---|---|
| Host: discovery, declaration, activation, enable/disable, plugin context | `src/lib/plugins/host.ts` |
| Contribution registries (`ContributionList`) | `src/lib/plugins/registry.ts` |
| Capability matching and forbidden commands | `src/lib/plugins/permissions.ts` |
| `window.alethe` and the local `<script>` loader | `src/lib/plugins/localTransport.ts` |
| Icon names a manifest may use | `src/lib/plugins/icons.ts` |
| Theme token sanitization and stylesheet injection | `src/lib/themeTokens.ts` |
| Agent provider registry and resolvers | `src/lib/agentProviders.ts` |
| Per-view sidebar placement | `src/lib/viewPlacement.ts` |
| Legacy `enabledFeatures.git` migration | `src/lib/plugins/legacyMigration.ts` |
| IPC bindings | `src/lib/tauri/plugins.ts` |
| Manifest storage, id validation, enable/disable state | `src-tauri/src/plugins.rs` |
| `alethe-plugin://` resolution and safety | `src-tauri/src/plugin_assets.rs` |
| Renders a declared view, activating it on reveal | `src/components/ContributedView/` |
| Management UI | `src/components/modals/preferences/PluginsPage.tsx` |
| Bundled plugins | `src/plugins/theme-pack/`, `src/plugins/git-control/` |
| Core panes, registered like any contribution | `src/components/WorkspaceView/corePanes.tsx` |

**Contribution points:** `views` and `commands` (declared in the manifest), `theme`, `pane` and
`agentProvider` (registered in code).

**Consumers converted:** both left-sidebar shells, the right sidebar, `WorkspaceView/PaneArea.tsx`,
`FindJumpModal` (Ctrl+P lists commands above terminals), and the agent pickers.

**Verification:** `npx tsc --noEmit`, `npx vitest run`, `cargo test --lib`, `npm run build`.

> Run these separately. Chaining build + vitest + cargo in one shell has been observed to get killed
> by the OOM killer on this machine (exit 137).

### Delivered from this roadmap

- **W1 — manifest-declared contributions.** A manifest announces `views` and `commands`; the code
  supplies implementations through `registerView` / `registerCommand`, which refuse an undeclared id.
  Unknown keys are rejected top level and inside `contributes`.
- **W2 — lazy activation.** `activation` accepts `onStartupFinished`, `onView:<id>` and
  `onCommand:<id>`; no wildcard. An event pointing at nothing is a manifest error. Concurrent
  activations coalesce. Git Control now loads on first reveal instead of at startup.
- **W3 — agent providers.** `AgentType` is open, resolvers fall back safely, and
  `contributes.agentProvider` registers a new CLI without touching the core.
- **W5 — local plugins.** `alethe-plugin://<pluginId>/<path>` resolves only inside that plugin's
  directory, rejecting traversal, percent-encoded traversal and symlink escapes; content type comes
  from the extension, never sniffed. The scheme is allowed in `script-src`, `style-src`, `font-src`
  and `img-src`; no remote origin and no `eval` were added, and `securityPolicy.test.ts` asserts each
  directive literally including those negatives. Preferences has a real Plugins page with a trust
  gate before enabling anything from disk.

### Still open

- **W4 — declarative views.** `SidebarTabContribution.component` still takes a React component, which
  couples third-party plugins to our component tree. The recommendation stands: keep `component` for
  bundled and explicitly-trusted plugins, add data-model views for third parties.
- **W6 — distribution.** Registry format, CI build from a pinned commit, the permission-diff review
  gate, revocations. Deliberately not started: it only matters once third parties publish.
- **W7 — untrusted plugin output.** No plugin-originated string reaches an agent's context yet, so
  the envelope has no consumer. It becomes required the moment one does.

## 2. Decisions already made

Do not relitigate these without talking to the owner. Each one has a reason.

**Bundled plugins load by code-split `import()`, not by an IIFE bundle.** Same origin, so
`script-src 'self'` already allows it. Local plugins use the `alethe-plugin://` scheme and bind
against `window.alethe`, which is string-keyed because the production bundle is minified with
`mangle.toplevel`. Both transports go through the same `activate(context)` contract.

**Plugins run in the main webview with full power.** This was an explicit product decision: plugins
must be able to add whole tabs, todo lists, and things that participate in agent behaviour. The
consequence is that manifest permissions are a **guard rail, not a sandbox** — an in-process plugin
can reach `invoke` directly. This is the Obsidian model.

**Announcing and implementing are separate.** The manifest says what exists; the code says how it
behaves. This is what makes lazy activation possible at all — the shell cannot draw a tab for a
plugin it has not loaded unless the tab is declared somewhere it can read cheaply.

**A stored theme whose plugin is disabled is not reset.** The preference is kept and only the
*applied* theme falls back. Do not add a destructive migration here — plugins activate
asynchronously, so validating `uiTheme` at hydrate time would wipe the choice on every boot.

**A pane whose provider is missing renders an "unavailable" placeholder**, never a terminal. Falling
back to a terminal would attach a shell to that pane's working directory.

**Sidebar placement is per view, not per feature.** `preferences.viewPlacements` overrides the
container a manifest declares, migrated once from the old `gitControlPlacement`.

**`projects` and `files` are not contributions.** They are the sidebar's own structure, not features
mounted inside it.

**`SidebarMergePanel`, `mergeStore` and the merge modals stayed in core** when Git Control moved out.
They mount unconditionally today, and `ROADMAP.md` phase 4 plans the Merge Center's return as the
terminal stage of a run.

## 3. Not verified in the running app

The plugin scheme and the local loader are covered by unit tests but have **not** been exercised in
the running app. Two things need a human at the keyboard:

1. That WebView2 maps `alethe-plugin://` the way the CSP expects (`http://alethe-plugin.localhost`),
   so a local plugin's `entry` actually loads.
2. That a Tauri child webview under a label other than `main` is refused `invoke`.
   `src-tauri/capabilities/default.json` declares `"webviews": ["main"]`, so this should hold — but
   it has been read, not executed. Any future move to real isolation rests on it.

## 4. Traps

- **`npm run build` is the i18n gate.** `pt-BR.ts` is typed against `en.ts`; a missing translation
  fails the build. Every visible string goes through `t()`.
- **There are two left-sidebar shells.** `ProjectSidebar/index.tsx` (clean) and
  `NormalProjectSidebar.tsx` (normal) are near-duplicates. Any sidebar change must satisfy both.
  This is why the tab registry pays for itself.
- **`ContributionList` is owner-checked** on both dispose and `update`, so one plugin can never drop
  or overwrite another's contribution, and a stale disposable is a no-op.
- **Runtime i18n never shadows a core key**, by design (`registerMessages` skips keys present in
  `en`). Plugin keys are namespaced `plugin.<id>.` by the host.
- **Theme tokens are sanitized** (`src/lib/themeTokens.ts`): custom properties only, and values are
  refused if they contain `url(`, `@`, `;`, `{`, `}`, `\`, or a comment sequence. Do not loosen this
  to make a theme work — fix the theme.
- **`docs/CHANGELOG.md` under `[Unreleased]` is mandatory** for every feature addition, change, or
  removal, in the same task.

---

## 5. Open questions for the owner

1. **Third-party plugins: in-process or isolated?** The current answer is in-process with full power
   (§2). W5's proof may show isolation is cheaper than assumed. If a public registry is ever on the
   table, this decision should be revisited before it, not after.
2. **Does `component` stay for third parties?** W4 recommends keeping it for bundled and adding
   declarative views for third parties. Confirm before either is built.
3. **Should contributed agent providers be toggleable?** The Preferences "Enabled agents" list is a
   hardcoded built-in array, so a contributed provider cannot be switched off there.
   `isAgentEnabled` treats contributed providers as enabled, which is why they appear in the pickers
   at all.

---

## 6. Not part of this work

`pty::tests::a_kill_never_runs_while_the_child_lock_is_held` is failing in the working tree. It is
unrelated to the plugin system — it belongs to in-progress PTY/process-tree work and is a guard test
that scans the source for a child lock held across `kill_process_tree`.
