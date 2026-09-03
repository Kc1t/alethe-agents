# Plugin System (RFC-012)

Alethe loads features as plugins so the core does not have to own every one of them. Official
plugins ship inside the app, are enabled by default, and can be turned off. Turning one off removes
its surfaces immediately — no restart.

## The two transports

| | Bundled | Local |
|---|---|---|
| Lives in | `src/plugins/<id>/`, shipped in the app bundle | `<profile>/plugins/<id>/` on disk |
| Loaded by | a code-split `import()` from the app origin | its `entry` script asset |
| CSP impact | none — same origin, `script-src 'self'` already allows it | needs the asset protocol (not yet enabled) |
| Status | working | manifest-only today; script assets are not loaded yet |

Both go through the **same** `activate(context)` contract. Only the transport differs, so a bundled
plugin exercises the real API rather than a privileged shortcut.

## Manifest

```jsonc
{
  "id": "alethe.theme-pack",
  "name": "Theme Pack",
  "version": "1.0.0",
  "apiVersion": 1,
  "kind": "theme",              // ui | theme | agentType | skill | validationPipeline
  "description": "…",
  "entry": "main.js",           // local plugins only
  "styles": "styles.css",       // optional
  "capabilities": ["ui.theme"]
}
```

`id` accepts `[A-Za-z0-9._-]` and is validated on the Rust side against path traversal. `entry` and
`styles` must be plain file names. A manifest whose `apiVersion` is not 1 is refused, both on
install and on activation.

**Unknown top-level keys are rejected, not ignored** (`deny_unknown_fields`). A manifest written for
a future `apiVersion` must fail loudly rather than load with half its meaning lost.

## Capabilities

A capability is an exact token (`ui.theme`) or a prefix with a single trailing `*`
(`invoke:git_*`). A bare `*` is rejected, so no manifest can claim everything by accident. A plugin
that contributes something it did not declare fails activation with `capability_denied`.

`context.invoke` additionally refuses a hard-coded set of commands regardless of what the manifest
says — PTY spawn/write, validation command execution, the projects file writer, filesystem writes
and deletes, secret reveal, and the plugin commands themselves. See
`src/lib/plugins/permissions.ts`.

> **Honest limit.** A plugin runs in the app's own webview, so this gate is a guard rail, not a
> sandbox: enforcement is advisory. Treat installing a local plugin the way you would treat running
> any other program. Real isolation would mean a child webview — the app already does that for
> browser panes — and is the path if a public registry ever exists.

## Writing a plugin

```ts
import type { PluginContext, PluginModule } from '../../lib/plugins'

const plugin: PluginModule = {
  activate(context: PluginContext) {
    context.registerMessages('en', { title: 'My Panel' })
    context.contributes.theme({ /* … */ })
  },
  deactivate() {
    // Optional. Everything registered through `context` is disposed for you.
  },
}

export default plugin
```

Every `context.contributes.*` and `context.registerMessages` call returns a `Disposable` and is
tracked. Deactivation disposes them in reverse order, so disabling a plugin fully undoes it. If
`activate` throws, whatever it managed to register is rolled back and the error surfaces in the
plugin list.

Messages are namespaced to `plugin.<id>.` automatically, and a plugin can never shadow a core key.
`context.t('title')` resolves `plugin.<id>.title`.

## Registering a bundled plugin

Add it to `BUNDLED_PLUGINS` in `src/plugins/index.ts`:

```ts
{
  manifest: MY_MANIFEST,
  load: () => import('./my-plugin/main').then((module) => module.default),
}
```

Vite code-splits it into its own chunk. Nothing else is needed.

## Contribution points

| Point | Capability | Registers |
|---|---|---|
| `contributes.theme` | `ui.theme` | a full theme: tokens, picker swatch, terminal palette |
| `contributes.pane` | `ui.pane` | a workspace pane for one `Terminal.kind` |
| `contributes.sidebarTab` | `ui.sidebarTab` | a tab in the left or right sidebar |
| `contributes.command` | `ui.command` | an entry in the command palette (Ctrl+P) |

The registry machinery (`src/lib/plugins/registry.ts`) is generic — a `ContributionList` is
owner-tagged, refuses duplicate ids, and exposes a stable snapshot for `useSyncExternalStore` — so
modals, commands and settings sections slot in the same way when their closed unions are converted.

### Panes

Core panes are registered through the same registry (`src/components/WorkspaceView/corePanes.tsx`),
so there is one lookup path and a plugin cannot silently shadow a built-in kind. A pane whose
provider is missing renders an "unavailable" placeholder rather than falling back to a terminal —
falling back would attach a shell to that pane's working directory, which is a different thing
entirely.

### Sidebar tabs

A tab declares which side it belongs to and gets the focused surface as props:

```ts
type SidebarTabProps = {
  projectId: string | null
  cwd: string | null
  ptyId: string | null
  terminalName: string | null
}
```

Every field is null when there is no usable terminal; the tab renders its own empty state. Anything
else the tab needs it reads from the stores directly.

A tab can move between sidebars by re-registering — Git Control does exactly that when the user
changes its placement preference (`src/plugins/git-control/main.tsx`).

### Commands

A command is an id, a label, optional keywords, and a `run` function. Contributed commands appear in
the Ctrl+P palette above the terminal list. The left sidebar's active tab lives in `uiStore`
(`leftSidebarTab`), so a command can reveal a tab — that is how Git Control's `git.reveal` works.

### Sidebar tabs

The `projects` and `files` tabs are not contributions: they are the sidebar's own structure, not
features mounted inside it. Contributed tabs are added alongside them, and the shells reset to
`projects` when the active tab's plugin is disabled.

## Where things live

| Path | Role |
|---|---|
| `src/lib/plugins/host.ts` | discovery, activation, enable/disable, the plugin context |
| `src/lib/plugins/registry.ts` | `ContributionList` and the contribution registries |
| `src/lib/plugins/permissions.ts` | capability matching and the forbidden-command list |
| `src/lib/themeTokens.ts` | theme token sanitization and stylesheet injection |
| `src/lib/tauri/plugins.ts` | IPC bindings |
| `src-tauri/src/plugins.rs` | manifest storage, id validation, enable/disable state |
| `src/plugins/` | bundled plugins |
| `src/components/WorkspaceView/corePanes.tsx` | core panes, registered like any contribution |

Enable/disable state lives in `<profile>/plugins/state.json` and covers bundled plugins too, so the
choice survives an app update.
