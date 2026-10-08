# Alethe Plugin System — Design

Date: 2026-09-01
Status: proposed
Target: v1.7.0 onward (`apiVersion: 1`)

## 1. Problem

Alethe is 67k lines of TypeScript and 34k lines of Rust across 264 Tauri commands
and 76 backend modules. Features that serve some users are paid for by all of them:
git, browser panes, Graphify, todos, Playwright, Spotify, PR review, dictation.

`src/lib/features.ts` already admits the problem with eight on/off toggles, but a
toggle is not a boundary. Turning a feature off leaves its code in the bundle, in the
type graph, and in the maintainer's lap; the switch is enforced by conditionals spread
across sixteen call sites (`RightSidebar/index.tsx:75-195`, `App.tsx`, `TitleBar`,
`MainMenu`, `ProjectContainer`, and more). Every new feature adds another conditional
and another thing only its author wanted.

`src-tauri/src/plugins.rs` (RFC-012) reserves the name but implements only manifest
CRUD in the profile directory: three kinds, no loading, no UI, no distribution.

## 2. Goals

- Move peripheral features out of the core into separately versioned repositories.
- Let third parties ship features without a fork and without core review of every idea.
- Keep the core free to refactor its own UI without breaking installed plugins.
- Make an unused plugin cost nothing at startup — RAM discipline is a product claim.
- Bound the damage a hostile or compromised plugin can do, by construction.
- Make the common review case (a patch that asks for no new power) cheap enough to
  approve without a maintainer reading it.

## 3. Non-goals

- Replacing the core with a plugin composition. Alethe is not becoming Cordis.
- Letting plugins style or restructure the Alethe shell.
- Running plugin code in the main webview.
- A hosted marketplace backend. The registry is a file in a git repository.
- Solving prompt injection by review. It is addressed at runtime or not at all.

## 4. The core / plugin boundary

**Core, never a plugin.** These are the product:

- PTY spawn, attach, resize, restart, scrollback (`pty.rs`).
- Workspace model: groups, projects, containers, panes, sub-tabs, layouts,
  persistence to `projects.json`, profiles.
- Agent orchestration over MCP (`orchestrator_core.rs`,
  `bin/alethe-orchestrator-mcp.rs`) and agent runtime adapters.
- Skills (`skills.rs`).
- The theming engine and design tokens (`styles/theme.css`).
- The plugin host itself.

**Plugin frontier.** Everything in `features.ts` today, plus Spotify, PR review,
dictation, and AI memory. Git is the first migration because it is the largest
(~6.2k lines: 2.1k TSX, 4.1k Rust) and the most actively changed.

## 5. Precedent

Two systems were studied. The VS Code model is the one adopted.

**deepseek-harness** composes the whole application from Cordis plugins declared in a
`cordis.yml` roster, with host and browser halves, service-injection ordering
(`inject`), disposer-based teardown, and hot reload. Its distribution is a GitHub topic
(`dsh-plugin`), not a marketplace. Two ideas are taken: activation ordering derived
from declared dependencies rather than load order, and explicit user approval before an
untrusted plugin runs.

**VS Code** is closer to Alethe's situation: a desktop app with local process access and
a large third-party ecosystem. Its rules, and why each matters here:

- Extensions have no DOM access. The documented reason is not only security: *"This
  separation allows Microsoft to refactor the interface without breaking extensions."*
  This is the strongest argument for the restriction. A plugin ecosystem coupled to
  `RightSidebar/index.tsx` would freeze that file forever.
- Extensions still add visible UI — buttons, activity-bar icons, panels — by declaring
  into **named contribution points** (`commands` + `menus`, `viewsContainers`, `views`)
  which VS Code renders. Declaring into a slot, not drawing into the DOM.
- Rich custom rendering goes to a **webview**: an isolated frame the extension owns the
  inside of, communicating only by `postMessage`, with `default-src 'none'` CSP and
  local resources reachable only through `asWebviewUri` under `localResourceRoots`.
- First-class features get **purpose-built contribution points**. VS Code's own Git is a
  built-in extension using the public `SourceControl` API — the API is credible because
  its author's own flagship feature has to fit through it.
- **Activation events** keep extensions unloaded until needed (`onView:`, `onCommand:`,
  `onStartupFinished`; the `*` wildcard is explicitly discouraged).

Two VS Code weaknesses are deliberately not copied. Its extension host is not a security
sandbox — extensions get full Node, including `child_process` — and its marketplace does
not deeply review code, which has repeatedly let malicious extensions through. Alethe
isolates plugin code itself, not only its UI, and curates releases.

## 6. What the spike found

Investigated by reading configuration and working code, not by execution. The one
runtime assertion still to prove is marked in §16.

1. **`csp: null` is stale documentation.** Commit `31abcf2 fix(security): constrain
   production renderer` replaced it with a strict policy. `CLAUDE.md:108` and
   `AGENTS.md:108` still describe the old state and should be corrected.

2. **The real CSP already forecloses the wrong designs.**
   `script-src 'self'` means plugin JavaScript cannot be loaded into the main document
   at all. `worker-src 'none'` closes the worker variant. `frame-src` already permits
   `asset:`, `http://asset.localhost`, `http:`, `https:`.

3. **Child-webview machinery already exists**, driven from the frontend rather than
   Rust: `WebPane/PrivateBrowserSurface.tsx:153` constructs
   `new Webview(getCurrentWindow(), label, {...})`, positions it through `applyRect`
   fed by `visibleRectOf` (`lib/surfaceGeometry.ts`), and **evicts it on hide** via
   `evictionTimer`. Covered by `PrivateBrowserSurface.test.tsx`,
   `nativeSurfaces.test.ts`, `surfaceGeometry.test.ts`.

4. **Tauri v2's ACL is per webview.** `src-tauri/capabilities/default.json` declares
   `"webviews": ["main"]`. A child webview under any other label receives no
   permissions; `invoke` is refused by Tauri, not by application code.
   `withGlobalTauri` is unset, so `window.__TAURI__` is never injected.

5. **`assetProtocol` is `null`** — present in the CSP, not enabled. Serving plugin files
   needs a registered URI scheme (§10).

Finding 4 is the foundation of this design: the isolation boundary is enforced by the
framework and is already configured, rather than being asserted by a hand-written
bridge.

## 7. Architecture

Three processes-worth of separation, from most to least trusted.

**The core** is the main webview plus Rust. It owns every Tauri command, renders all
shell UI, and is the only party that calls `invoke`.

**A plugin host** is one hidden Tauri child webview per *activated* plugin, labelled
`plugin-host-<pluginId>-<nonce>`. It runs the plugin's JavaScript. It carries no ACL
capability, so `invoke` fails inside it regardless of what the plugin attempts. It
reaches the core only through `postMessage` on a channel the core opened and whose
plugin identity the core holds — the plugin never asserts its own identity.

Per-plugin webviews rather than one shared host (VS Code's model) buys realm isolation
between plugins for free, and lazy activation plus eviction keeps the cost proportional
to what is actually in use. A shared host running each plugin in a `Worker` is a later
optimisation if RAM measurements demand it.

**A view surface** is a visible child webview created only for `type: "webview"` views,
positioned and evicted by the same code path as `PrivateBrowserSurface`. It also holds
no ACL capability.

Declarative views cost no webview at all: the plugin host sends a data model and the
core renders it with Alethe components, so those views inherit the design system and
survive shell refactors.

### Message flow

```
plugin code (plugin host webview, zero ACL)
  -> postMessage { id, capability: "git.status", args }
core broker (main webview)
  -> resolves sender to a pluginId by channel identity
  -> rejects unless pluginId's granted permissions cover "git:read"
  -> invoke("git_status", ...)          <-- only the core ever invokes
  <- postMessage { id, ok, value }
```

The broker validates; the plugin never carries its own claim. Capabilities whose scope
is a path or a host (`fs:read`, `network`) are additionally validated in Rust, because a
compromised main webview must not be the only thing standing between a plugin and the
filesystem.

## 8. Plugin anatomy

A plugin is a directory with `plugin.json` at its root and built assets beside it.
No native binary, no spawned process: distribution stays a signed zip of JavaScript,
CSS, and JSON, which is what makes install-from-a-link viable.

```json
{
  "$schema": "https://alethe.app/schemas/plugin-1.json",
  "id": "alethe-git",
  "name": "Git",
  "version": "1.0.0",
  "apiVersion": 1,
  "publisher": "kc1t",
  "repository": "https://github.com/Kc1t/alethe-plugin-git",
  "license": "MIT",
  "engines": { "alethe": "^1.7.0" },

  "activation": ["onView:git.status", "onCommand:git.commit"],
  "permissions": ["git:read", "git:write", "project:active"],

  "main": "dist/plugin.js",

  "contributes": {
    "views": [
      { "id": "git.status", "container": "rightSidebar",
        "titleKey": "git.title", "icon": "git-branch", "type": "tree" },
      { "id": "git.graph", "container": "pane",
        "titleKey": "git.graph", "icon": "git-commit", "type": "webview",
        "entry": "dist/graph/index.html" }
    ],
    "commands": [
      { "id": "git.commit", "titleKey": "git.commit", "icon": "check" }
    ],
    "menus": {
      "view/title": [
        { "command": "git.commit", "when": "view == git.status", "group": "navigation" }
      ]
    },
    "configuration": { "git.autoFetch": { "type": "boolean", "default": false } }
  }
}
```

Unknown top-level keys are rejected, not ignored: a manifest that means something to a
future `apiVersion` must not load silently under this one.

## 9. Contribution points (apiVersion 1)

| Point | Renders where | Notes |
|---|---|---|
| `views` (`type: "tree"`) | RightSidebar tab, ProjectSidebar section | Data model in, Alethe components out |
| `views` (`type: "webview"`) | Pane or sidebar tab | Child webview; the escape hatch |
| `commands` | Command surfaces, menus | Id, title key, icon |
| `menus` | `view/title`, `titlebar`, `sidebar/project/context`, `terminal/context` | `when` clauses over context keys |
| `configuration` | Preferences modal | JSON-schema fragment |
| `themes` | Appearance page | Token overrides for `theme.css` variables only |
| `mcpServers` | Agent MCP config | Reuses `mcp_store.rs`; serves the agent side |

`RightSidebar/index.tsx` stops branching on `enabledFeatures` and starts rendering a tab
list assembled from contributions. Core features keep their tabs by contributing
through the same registry — the API has to carry Alethe's own weight to be worth
trusting, which is the lesson from VS Code shipping Git as an extension.

**Domain-specific points, phase 4.** Alethe's first-class extension point is not source
control; it is terminals and agents. `agentProviders` (a new agent CLI installable as a
plugin without touching `agentRuntimeAdapter.ts`), `sessionInspectors`, and
`usageProviders` are where the ecosystem grows along the axis that is actually Alethe's.
They are deferred until the generic points have shipped and proven.

## 10. Serving plugin assets

`assetProtocol` stays disabled. The core registers an asynchronous URI scheme in Rust,
`alethe-plugin://<pluginId>/<path>`, resolving under the installed plugin's directory
only, with `..` traversal rejected after canonicalisation and a symlink check. This is
`asWebviewUri` plus `localResourceRoots` with the root fixed per plugin rather than
configurable. `frame-src` gains the scheme; nothing else does.

Each view webview is served an HTML document carrying its own restrictive meta CSP.

## 11. Permissions

Permissions are declared in the manifest, granted at install, and shown before install
in plain language. There is no runtime permission prompt in v1: a permission change is
a new version, which is a new review (§14).

Initial set: `git:read`, `git:write`, `project:active`, `terminal:read`,
`terminal:write`, `agent:observe`, `fs:read:<glob>`, `network:<host>`, `mcp:register`,
`storage`.

`ctx` is assembled per plugin at activation and contains only granted capabilities. An
ungranted capability is absent, not throwing — a plugin cannot probe for what it lacks.

A capability is served either by a core Rust command or by an MCP server, and the plugin
cannot tell which. This is deliberate: it keeps the harness path open, so moving git's
4.1k Rust lines out of the core later is a change of provider rather than a rewrite of
the plugin.

## 12. Activation and lifecycle

Nothing loads at startup. A plugin activates when one of its `activation` events fires:
`onView:<id>` when its view first becomes visible, `onCommand:<id>` when its command
runs, `onStartupFinished` after the workspace settles. There is no wildcard.

Activation creates the plugin host webview and calls the module's exported
`activate(ctx)`, which returns a disposer. Deactivation runs the disposer, closes any
view surfaces, and closes the host webview. A view hidden for longer than the eviction
delay releases its surface, matching `PrivateBrowserSurface`.

An installed-but-never-opened plugin therefore costs one manifest read.

## 13. Distribution

**The registry** is `registry/plugins/<id>.json` in a public Alethe repository. A
version entry is admitted only by merged pull request:

```json
{
  "id": "alethe-git",
  "repository": "https://github.com/Kc1t/alethe-plugin-git",
  "versions": [
    {
      "version": "1.0.1",
      "tag": "v1.0.1",
      "commit": "9f2c1e0b…",
      "sha256": "3ab9…",
      "apiVersion": 1,
      "permissions": ["git:read", "git:write", "project:active"],
      "reviewedAt": "2026-09-14T12:00:00Z",
      "reviewMode": "automatic"
    }
  ]
}
```

The entry pins a **commit**, and the artifact is built by Alethe CI from that commit in
a network-isolated sandbox — never downloaded from the publisher's release page. This
closes the gap Obsidian leaves open, where an initial review is followed by unreviewed
author-published updates. A committed lockfile is mandatory, since a hermetic build
cannot resolve dependencies otherwise.

**Two install doors.**

*Marketplace*: reviewed, hash-pinned, may be enabled on install.

*Direct URL*: a GitHub link the user pastes. Supported, because it is how an author
tests their own plugin and how a private plugin is used at all. It installs
**disabled**, is badged as unreviewed wherever it appears, and states plainly that no
one has checked it. Enabling is a separate, deliberate act.

## 14. Review pipeline

The design target is that most patches need no maintainer attention, because a
marketplace that depends on a human reading every diff dies of backlog.

**Layer 1 — provenance.** Registry pins commit and artifact hash; the artifact is built
by Alethe CI from source. Reviewed source is the code that ships.

**Layer 2 — the permission diff.** CI compares the new manifest's `permissions` against
the last admitted version.

- *Unchanged*: the patch cannot exceed the blast radius already approved. Eligible for
  automatic admission if Layer 3 passes.
- *Changed*: human review, always, with no exception for patch-level versions.
  Privilege escalation is the one event that always costs attention.

**Layer 3 — mechanical gates**, each posted as a PR comment:

- Diff is computed against the last admitted tag, so review effort is proportional to
  the change rather than to the plugin.
- New or changed dependencies in the lockfile route to human review.
- `eval`, `new Function`, dynamic `import()` of a remote URL, or network access to a
  host not declared in `permissions` fail outright.
- Obfuscation heuristics — minified output without a source map, abnormal string
  entropy, very long literals — route to human review.
- Abnormal bundle-size growth routes to human review.
- Manifest schema validation, `apiVersion` compatibility, and id/publisher ownership.

**Layer 4 — the runtime, which is the actual wall.** Every gate above is evadable by a
patient adversary. What bounds damage is that plugin code runs in a webview with no ACL
capability and reaches only the `ctx` methods its permissions granted. Layers 1-3 are
defense in depth; the capability model is the boundary.

**Revocation.** `registry/revocations.json` lists banned artifact hashes. The app fetches
it at startup and on a schedule, disables matching installations, and tells the user
why. Something will eventually get through; being unable to un-ship it is the difference
between an incident and a disaster.

Publisher reputation may reorder the human review queue. It never skips Layer 2.

## 15. Untrusted plugin output

Prompt injection cannot be reviewed for: the payload arrives at runtime, in data,
after any review. A plugin with clean, audited source that surfaces a GitHub issue title
can carry an instruction to an orchestrated agent without its author's involvement.

Therefore: any plugin-originated string that enters an agent's context is wrapped in an
untrusted-data envelope naming its origin plugin, and is never concatenated into an
instruction position. Plugin-contributed MCP tools are registered to agents with
provenance metadata so their results carry the same marking. This is a core
responsibility and is not delegated to plugins.

## 16. Risks and open questions

- **Runtime proof of isolation.** Findings 3 and 4 come from configuration and code, not
  execution. Phase 0 must demonstrate a plugin webview attempting `invoke` and being
  refused, in the running app.
- **Meta-CSP on custom-scheme documents.** Whether a document served over
  `alethe-plugin://` can tighten its own policy beyond the app config needs verification
  in Phase 0; the view-surface design assumes it can.
- **RAM.** One webview per activated plugin plus one per open webview view. Lazy
  activation and eviction bound it, but this must be measured against the existing
  memory analytics before phase 3, not assumed.
- **Z-order.** A native surface floats above the DOM and cannot be clipped by CSS
  overflow — the reason `visibleRectOf` exists. Shell dropdowns and modals will not
  paint over a plugin webview view. The browser pane already lives with this; it is a
  real constraint on where webview views can be placed.
- **Core shrinkage is smaller than it looks.** Migrating git moves ~2.1k lines of TSX
  out. The ~4.1k Rust lines stay as a capability provider until an MCP-backed provider
  replaces them. The core stops owning the git *panel*, not git.
- **Maintainer load.** Curation is permanent work that scales with success. The design
  bets on Layer 2 keeping the human queue small; if it does not, the marketplace stalls.

## 17. Testing

- Vitest over manifest validation, permission resolution, the `when`-clause evaluator,
  activation-event matching, and registry entry verification.
- Rust tests over URI scheme resolution, including traversal and symlink rejection.
- Playwright e2e (`e2e/specs/`) over install from a local directory, activation on view
  reveal, a granted capability succeeding, an ungranted capability being absent, and a
  revoked hash disabling on next launch.
- A fixture plugin lives in the repository and is used by the e2e suite, so the public
  API is exercised by Alethe's own tests.

## 18. Phasing

**Phase 0 — vertical slice.** Plugin host webview, one fixture plugin loaded from disk,
one declarative view in the RightSidebar, one command, and a visible refusal when the
plugin reaches for an ungranted capability. Proves §16's first two risks. Reviewed in
`npm run dev`.

**Phase 1 — the contract.** Manifest schema and loader, activation events, permission
broker, declarative views and commands, menus with `when` clauses, configuration, plugin
management UI in Preferences. `features.ts` toggles migrate to plugin enablement.

**Phase 2 — rich UI.** `alethe-plugin://` scheme, webview views, eviction. Migrate
`GitGraph`, `GitGraphList`, `GitGraphCommitDetail`, `DiffPane`.

**Phase 3 — distribution.** Registry format, CI build-and-verify, the four review
layers, revocation, marketplace UI, install from URL.

**Phase 4 — the harness axis.** `agentProviders`, `sessionInspectors`,
`usageProviders`. Complete the git migration; then browser, Graphify, Spotify, todos.

Each phase ends with something demonstrable in the running app rather than with
infrastructure only visible to its author.

This spec is too large for one implementation plan. Each phase gets its own plan,
written when the phase before it has landed and its assumptions have been checked
against what was actually built.
