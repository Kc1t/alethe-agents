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
| Host: discovery, activation, enable/disable, plugin context | `src/lib/plugins/host.ts` |
| Contribution registries (`ContributionList`) | `src/lib/plugins/registry.ts` |
| Capability matching and forbidden commands | `src/lib/plugins/permissions.ts` |
| Theme token sanitization and stylesheet injection | `src/lib/themeTokens.ts` |
| Legacy `enabledFeatures.git` migration | `src/lib/plugins/legacyMigration.ts` |
| IPC bindings | `src/lib/tauri/plugins.ts` |
| Manifest storage, id validation, enable/disable state | `src-tauri/src/plugins.rs` |
| Bundled plugins | `src/plugins/theme-pack/`, `src/plugins/git-control/` |
| Core panes, registered like any contribution | `src/components/WorkspaceView/corePanes.tsx` |

**Contribution points today:** `theme`, `pane`, `sidebarTab`, `command`.

**Consumers already converted:** both left-sidebar shells (`ProjectSidebar/index.tsx` and
`NormalProjectSidebar.tsx`), the right sidebar, `WorkspaceView/PaneArea.tsx`, and `FindJumpModal`
(Ctrl+P now lists commands above terminals).

**Verification:** `npx tsc --noEmit`, `npx vitest run` (516 passing), `cargo test --lib plugins`
(7 passing), `npm run build`.

> Run these separately. Chaining build + vitest + cargo in one shell has been observed to get killed
> by the OOM killer on this machine (exit 137).

---

## 2. Decisions already made

Do not relitigate these without talking to the owner. Each one has a reason.

**Bundled plugins load by code-split `import()`, not by an IIFE bundle.** Same origin, so
`script-src 'self'` already allows it and **the CSP needed no change** — `src/securityPolicy.test.ts`
passes untouched. The IIFE + `window.alethe` transport is only needed for local/third-party plugins.
Both transports go through the same `activate(context)` contract, so bundled plugins exercise the
real API rather than a privileged shortcut.

**Plugins run in the main webview with full power.** This was an explicit product decision: plugins
must be able to add whole tabs, todo lists, and things that participate in agent behaviour. The
consequence is that manifest permissions are a **guard rail, not a sandbox** — an in-process plugin
can reach `invoke` directly. This is the Obsidian model. See §3.5 for the path to real isolation.

**A stored theme whose plugin is disabled is not reset.** The preference is kept and only the
*applied* theme falls back, so re-enabling the plugin restores the user's choice. Do not add a
destructive migration here — plugins activate asynchronously, so validating `uiTheme` at hydrate
time would wipe the choice on every boot.

**A pane whose provider is missing renders an "unavailable" placeholder**, never a terminal. Falling
back to a terminal would attach a shell to that pane's working directory, which is a different thing
entirely.

**`projects` and `files` are not contributions.** They are the sidebar's own structure, not features
mounted inside it. Contributed tabs are added alongside them.

**`SidebarMergePanel`, `mergeStore` and the merge modals stayed in core** when Git Control moved out.
They mount unconditionally today, and `ROADMAP.md` phase 4 plans the Merge Center's return as the
terminal stage of a run.

---

## 3. The work, in priority order

### W1 — Manifest-declared contributions

**The highest-leverage item. It unblocks three others.**

Today a plugin registers its contributions imperatively, inside `activate()`. That makes lazy
activation impossible: the shell cannot render a plugin's sidebar tab before loading the plugin's
code, because only the code knows the tab exists.

Move contribution *declarations* into `plugin.json`, VS Code style. The manifest says what exists;
the code supplies behaviour when activated.

```jsonc
"contributes": {
  "views": [{ "id": "git.status", "container": "rightSidebar", "titleKey": "…", "icon": "git-branch" }],
  "commands": [{ "id": "git.commit", "titleKey": "…", "icon": "check" }]
}
```

Keep the imperative API as the way a plugin *implements* a declared contribution, not as the way it
announces one.

Unblocks: W2 (lazy activation), `when` clauses, and menus.

**Trap:** `deny_unknown_fields` is already on `PluginManifest` (`src-tauri/src/plugins.rs`). Adding
`contributes` means bumping the schema deliberately — that strictness is intentional and must be
kept, not removed to make the change easier.

### W2 — Lazy activation

With W1 in place: `activation: ["onView:<id>", "onCommand:<id>", "onStartupFinished"]`, no wildcard.
Activate on first reveal of a view or first run of a command. Target: an installed-but-never-opened
plugin costs one manifest read.

This matters because RAM discipline is a product claim, not a nice-to-have.

### W3 — Agent providers (the harness axis)

**The biggest product bet in this roadmap.** Alethe's first-class extension point is not source
control; it is terminals and agents.

Adding a new agent CLI today costs nine touch points:

`AgentType`, `AGENT_TYPE_LABELS`, `ALL_AGENT_TYPES`, `UNRESTRICTED_FLAG`, `agentCliCommand`
(all in `src/lib/types.ts`), `agentRuntimeAdapter.ts`, a `*_usage.rs`, a `*_sessions.rs`, the
`--agent-*` CSS tokens, and an icon.

With an `agentProviders` contribution point, someone ships "Alethe + Cursor CLI" without a fork.

**Use the recipe that already worked for themes** — it is proven and tested in this repo:

1. `AgentType` becomes `BuiltinAgentType | (string & {})` (see `Theme` / `BuiltinTheme` in
   `src/lib/types.ts` for the exact shape).
2. `satisfies Record<AgentType, …>` becomes `Record<BuiltinAgentType, …>` plus a runtime map merge
   (see `src/components/XTermView/xtermThemes.ts`).
3. A registry with a safe fallback for unknown ids (see `src/lib/themes.ts`).
4. Runtime i18n for provider labels (`registerMessages`, already built).

Sub-points worth the same treatment: `sessionInspectors` and `usageProviders`.

### W4 — Declarative views

Today `SidebarTabContribution.component` takes a React component. That couples plugins to our
component tree: once third parties exist, `RightSidebar/index.tsx` can never be refactored again.
VS Code's documented reason for the DOM restriction is exactly this, not only security.

Add declarative views — the plugin sends a data model, the core renders it with Alethe components —
so plugin UI inherits the design system and survives shell refactors.

**Recommended synthesis, not a swap:** keep `component` for bundled and explicitly-trusted plugins,
add declarative views as the path for third parties. There is no reason to choose one.

### W5 — Local plugins from a folder

- Register an `alethe-plugin://<pluginId>/<path>` URI scheme in Rust, resolving **only** under the
  installed plugin's directory, rejecting `..` after canonicalisation and checking for symlinks.
  Preferred over enabling `assetProtocol`, because the root is fixed per plugin instead of
  configurable.
- `script-src` gains the scheme. `src/securityPolicy.test.ts` asserts every directive literally —
  update it deliberately, with the diff visible in review.
- Replace the raw JSON textarea in `preferences/MultiagentPage.tsx` with a real Plugins page: list,
  enable/disable, uninstall, "Open plugins folder", and a **trust dialog** on install that names the
  capabilities being requested.
- A local plugin installs **disabled** and is badged as unreviewed. Enabling is a separate act.

**Prove first (currently unverified):** that a Tauri child webview under a label other than `main`
is actually refused `invoke`. `src-tauri/capabilities/default.json` declares `"webviews": ["main"]`,
so this should hold — but it has been read, not executed. The whole isolation story rests on it.

### W6 — Distribution

Registry as `registry/plugins/<id>.json` in a public repo, admitted by merged PR. Two ideas worth
copying exactly:

- **Pin a commit and build the artifact in CI**, never download the publisher's release. This closes
  the gap Obsidian leaves open, where one review is followed by unreviewed author-published updates.
- **The permission diff as the review gate.** Permissions unchanged → eligible for automatic
  admission. Permissions changed → human review, always, no exception for patch versions. This is
  what keeps curation from dying of backlog.

Plus `registry/revocations.json`, fetched at startup, disabling matching installs. Something will
eventually get through; being unable to un-ship it is the difference between an incident and a
disaster.

### W7 — Untrusted plugin output

Prompt injection cannot be reviewed for: the payload arrives at runtime, in data, after any review.
A plugin with clean audited source that surfaces a GitHub issue title can carry an instruction to an
orchestrated agent.

Any plugin-originated string entering an agent's context must be wrapped in an untrusted-data
envelope naming its origin plugin, and never concatenated into an instruction position.
Plugin-contributed MCP tools register with provenance metadata so their results carry the same mark.

This is a core responsibility. It is not delegated to plugins, and it is not solved by review.

---

## 4. Traps

- **`npm run build` is the i18n gate.** `pt-BR.ts` is typed against `en.ts`; a missing translation
  fails the build. Every visible string goes through `t()`.
- **There are two left-sidebar shells.** `ProjectSidebar/index.tsx` (clean) and
  `NormalProjectSidebar.tsx` (normal) are near-duplicates. Any sidebar change must satisfy both.
  This is why the tab registry pays for itself.
- **`ContributionList` disposal is owner-checked**, and a stale disposable for a re-registered id is
  harmless because disposal runs newest-first. Git Control relies on this when its tab moves between
  sidebars.
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
3. **W3 before W6?** Recommendation: yes. Marketplace and sandbox feel urgent, but they only matter
   once third parties are publishing — and the harness axis is what makes them want to.

---

## 6. Not part of this work

`pty::tests::a_kill_never_runs_while_the_child_lock_is_held` is failing in the working tree. It is
unrelated to the plugin system — it belongs to in-progress PTY/process-tree work and is a guard test
that scans the source for a child lock held across `kill_process_tree`.
