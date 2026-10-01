# Plugin System (RFC-012)

Alethe loads features as plugins so the core does not have to own every one of them. Official
plugins ship inside the app, are enabled by default, and can be turned off. Turning one off removes
its surfaces immediately — no restart.

A plugin **announces** what it contributes in its manifest, and **implements** it in code. That
split is what lets the shell draw a plugin's sidebar tab before the plugin has been loaded, and only
load it when someone actually opens it.

## The two transports

| | Bundled | Local |
|---|---|---|
| Lives in | `src/plugins/<id>/`, shipped in the app bundle | `<profile>/plugins/<id>/` on disk — the directory name must equal the manifest `id` |
| Loaded by | a code-split `import()` from the app origin | a `<script>` served over `alethe-plugin://` |
| Binds against | the app's modules directly | `window.alethe` |
| Trust | first-party | unreviewed; installs disabled, enabling asks first |

Both go through the **same** `activate(context)` contract. Only the transport differs, so a bundled
plugin exercises the real API rather than a privileged shortcut.

## Manifest

```jsonc
{
  "id": "alethe.git-control",
  "name": "Git Control",
  "version": "1.0.0",
  "apiVersion": 1,
  "kind": "ui",                 // ui | theme | agentType | skill | validationPipeline
  "description": "…",
  "entry": "main.js",           // local plugins only
  "styles": "styles.css",       // optional, local plugins only
  "capabilities": ["ui.sidebarTab", "ui.command", "invoke:git_*"],

  "activation": ["onView:git", "onCommand:git.reveal"],

  "contributes": {
    "views": [
      { "id": "git", "container": "leftSidebar", "title": "Source Control",
        "titleKey": "ui.sidebar.git", "panelTitleKey": "ui.sidebar.sourceControl",
        "icon": "git-branch", "order": 10 }
    ],
    "commands": [
      { "id": "git.reveal", "title": "Source Control", "icon": "git-branch",
        "keywords": "git commit branch diff status" }
    ]
  }
}
```

`id` accepts `[A-Za-z0-9._-]` and is validated on the Rust side against path traversal. `entry` and
`styles` must be plain file names. Contribution ids follow the same shape and must be unique within
a manifest. A manifest whose `apiVersion` is not 1 is refused, on install and on activation.

**Unknown keys are rejected, not ignored** (`deny_unknown_fields`, top level and inside
`contributes`). A manifest written for a future `apiVersion` must fail loudly rather than load with
half its meaning lost.

`icon` names an entry in the curated map in `src/lib/plugins/icons.ts`. A manifest names an icon; it
never supplies a component. An unknown name falls back to a generic puzzle icon.

## Activation

Nothing is loaded at startup unless it asks to be.

| Event | Fires |
|---|---|
| `onStartupFinished` | once the plugin host has finished discovery |
| `onView:<id>` | the first time that declared view is rendered |
| `onCommand:<id>` | the first time that declared command runs |

An empty or absent `activation` list means `["onStartupFinished"]`, so a plugin that declares
nothing still behaves the way it always did. An event pointing at a view or command the manifest
does not declare is a manifest error, reported in the Plugins page rather than ignored.

A declared view or command **always** activates its plugin on demand, whatever `activation` says;
the list decides what happens at startup. Concurrent activations are coalesced, so a plugin is
loaded once no matter how many surfaces reach for it at the same time.

An installed-but-never-opened plugin therefore costs one manifest read.

## Capabilities

A capability is an exact token (`ui.theme`) or a prefix with a single trailing `*`
(`invoke:git_*`). A bare `*` is rejected, so no manifest can claim everything by accident. A plugin
that contributes something it did not declare fails activation with `capability_denied`; declaring
views without `ui.sidebarTab`, or commands without `ui.command`, fails before anything is
registered.

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
    context.registerView('git', GitTab)          // implements a declared view
    context.registerCommand('git.reveal', run)   // implements a declared command
    context.registerMessages('en', { title: 'My Panel' })
    context.contributes.theme({ /* … */ })       // themes and panes stay imperative
  },
  deactivate() {
    // Optional. Everything registered through `context` is disposed for you.
  },
}

export default plugin
```

`registerView` and `registerCommand` refuse an id the manifest does not declare — announcing is the
manifest's job, implementing is the code's. Everything registered through the context returns a
`Disposable` and is tracked; deactivation disposes in reverse order, so disabling a plugin fully
undoes it. If `activate` throws, whatever it registered is rolled back and the error surfaces in
Preferences → Plugins.

Messages are namespaced to `plugin.<id>.` automatically, and a plugin can never shadow a core key.
`context.t('title')` resolves `plugin.<id>.title`.

## Storage

`context.storage` is a plugin's own persisted record — a JSON object, one per plugin, per profile.

```ts
const items = await context.storage.get('items', [])
await context.storage.set('items', [...items, item])
await context.storage.remove('items')
await context.storage.clear()
```

It lives in `<profile>/plugin-data/<id>.json`, **not** inside the plugin's directory. Two reasons,
both of which would bite later: everything under `plugins/<id>/` is reachable over
`alethe-plugin://`, so a plugin's data would be fetchable as an asset; and a reimport replaces that
directory, which would take the user's data with it. Data therefore survives an upgrade, and an
uninstall removes it — that is the user asking for the plugin gone.

Writes are read-modify-write and queue per plugin, so two concurrent `set` calls cannot lose a
value. A body must be a JSON object and is capped at 1 MB; a corrupt file reads as an empty record
rather than throwing, so a plugin still starts.

## Contribution points

| Point | Declared in | Capability | Registers |
|---|---|---|---|
| `views` | manifest | `ui.sidebarTab` | a tab in the left or right sidebar |
| `commands` | manifest | `ui.command` | an entry in the command palette (Ctrl+P) |
| `contributes.theme` | code | `ui.theme` | tokens, picker swatch, terminal palette |
| `contributes.pane` | code | `ui.pane` | a workspace pane for one `Terminal.kind` |
| `contributes.modal` | code | `ui.modal` | a modal the shell mounts when `openModal` matches its id |
| `contributes.agentProvider` | code | `agent.provider` | a new agent CLI: label, binary, unrestricted flag, accent, icon |

Themes, panes and agent providers stay imperative because none of them is revealed by a tab: a theme
applies as soon as it exists, a pane only renders for a terminal that already carries its kind, and a
provider only matters once someone opens a terminal with it.

### Agent providers

`AgentType` is open (`BuiltinAgentType | (string & {})`), the same shape as `Theme`. A provider
supplies its id, display name, CLI binary, unrestricted-mode flag and accent token; the launcher,
the pickers, the icons and the colors all resolve through `src/lib/agentProviders.ts`, falling back
safely for an id nobody registered. Adding an agent CLI is a plugin, not nine edits across the core.

Provider names are not translated — they are product names, like an extension's display name.

### Views

A view gets the focused surface as props:

```ts
type SidebarTabProps = {
  projectId: string | null
  cwd: string | null
  ptyId: string | null
  terminalName: string | null
}
```

Every field is null when there is no usable terminal; the view renders its own empty state. Anything
else it needs it reads from the stores directly. The shell draws the panel header, so a view renders
its body only — that is what lets the same component serve either sidebar.

A view's container comes from the manifest and can be overridden per user. The `projects` and
`files` tabs are not contributions: they are the sidebar's own structure, not features mounted
inside it. Contributed tabs sit alongside them, and the shells fall back to `projects` when the
active tab's plugin is disabled.

### Panes

Core panes go through the same registry (`src/components/WorkspaceView/corePanes.tsx`), so there is
one lookup path and a plugin cannot silently shadow a built-in kind. A pane whose provider is
missing renders an "unavailable" placeholder rather than falling back to a terminal — falling back
would attach a shell to that pane's working directory, which is a different thing entirely.

## Registering a bundled plugin

Add it to `BUNDLED_PLUGINS` in `src/plugins/index.ts`:

```ts
{
  manifest: MY_MANIFEST,
  load: () => import('./my-plugin/main').then((module) => module.default),
}
```

Vite code-splits it into its own chunk. Nothing else is needed.

## Local plugins and `alethe-plugin://`

A local plugin's assets are served by a custom URI scheme whose root is **fixed per plugin**:
`alethe-plugin://<pluginId>/<path>`, resolved by `src-tauri/src/plugin_assets.rs`. This is preferred
over Tauri's `assetProtocol`, whose scope is configurable and therefore weaker.

The resolver rejects an invalid plugin id, `..` segments, absolute paths, drive and UNC prefixes,
backslashes, and percent-encoded traversal; it canonicalizes both the plugin directory and the
target and refuses anything that lands outside — which is what defeats a symlink pointing elsewhere.
Content type comes from the extension only, never sniffed, so a `.txt` holding script text is served
inert.

The scheme is allowed in `script-src`, `style-src`, `font-src` and `img-src`, in both its
`alethe-plugin:` and `http://alethe-plugin.localhost` forms. **Windows and Android reach a custom
scheme only through the `.localhost` form**, so the loader builds the URL per platform.

The two shapes differ in where the plugin id sits, which the handler has to reconcile:

| Platform | What the page requests | What reaches the handler | Plugin id |
|---|---|---|---|
| macOS, Linux | `alethe-plugin://<id>/<path>` | same | the host |
| Windows, Android | `http://alethe-plugin.localhost/<id>/<path>` | `alethe-plugin://localhost/<id>/<path>` | first path segment |

Tauri rewrites the `.localhost` form and the host arrives as the literal string `localhost`, not as
`alethe-plugin.localhost`. `split_target` in `plugin_assets.rs` handles both and is covered by a
test, because getting it wrong fails silently: the script simply never loads. No remote
origin and no `eval` were added; `src/securityPolicy.test.ts` asserts each directive literally,
including those negatives.

**Importing.** Preferences → Plugins → *Import plugin* opens a folder picker and copies the
directory in (`plugin_import_dir`). The manifest is validated before anything is written, declared
assets must exist, symlinks are refused, and the copy is bounded (200 files, 10 MB, 5 levels). The
plugin arrives disabled; re-importing over an existing id keeps whatever the user had chosen.

`src/lib/plugins/localTransport.ts` injects the `<script>`, hands the plugin `window.alethe`
(`apiVersion`, `react`, `jsxRuntime`, `registerPlugin`), and waits for the plugin to register
itself. Nothing is evaluated from a string. A plugin that fails to load, or never registers within
ten seconds, is reported as an activation error and leaves no script or stylesheet behind.

The global is string-keyed because the production bundle is minified with `mangle.toplevel` — a
plugin cannot import from the host by module name.

## The catalogue

Preferences → Plugins lists plugins published by other people. The index is a single file,
`plugins.json`, at the root of this repository, read from
`raw.githubusercontent.com/Kc1t/alethe-agents/main/plugins.json`:

```jsonc
{
  "schema": 1,
  "plugins": [
    {
      "id": "acme.panel",
      "name": "Panel",
      "description": "…",
      "author": "acme",
      "repo": "acme/alethe-panel",
      "downloadUrl": "https://github.com/acme/alethe-panel/releases/latest",
      "version": "1.0.0",
      "minApiVersion": 1,
      "capabilities": ["ui.sidebarTab"]
    }
  ]
}
```

An entry with a `package` can be installed from inside the app; one without it is a pointer, and
*Get plugin* opens the author's page for a manual download and import.

**Installing from the app is not a weaker path than importing by hand.** The manual route has no
integrity check at all — a zip from a link is whatever the link served today. The `package.sha256`
in the index pins the bytes to what the reviewer of the pull request saw, so the installed plugin is
verifiable in a way a hand-dropped folder never was. The power granted is identical either way; only
the evidence differs.

What installing does *not* do is grant permission to run. The plugin lands disabled, exactly like an
imported one, and turning it on still goes through the trust dialog listing its capabilities.

A listing is dropped, not shown, when its id is not a plain id, its name is empty, its
`downloadUrl` is not `https`, its `minApiVersion` is above this build, or it carries a `package`
whose URL is not `https` or whose `sha256` is not 64 hex characters. `plugin_catalog_open`
re-checks the URL against the cached catalogue, so a link can never be turned into a general
opener, and it launches the browser without a shell in the chain. The command is on the
forbidden list, so no plugin can call it.

`plugin_install_from_catalog` takes only an id. The URL and the hash are read from the cached index
inside Rust, so a caller cannot aim it at something the catalogue never listed. Beyond the hash, the
unpacking refuses archive entries that escape the destination (`..`, absolute paths, drive letters,
UNC roots), caps the download, the unpacked size and the entry count, and requires the `id` inside
the archive's own `plugin.json` to match the id being installed — without that last check a listing
could ship an archive claiming to be a plugin the user already trusted and replace it.

The index is cached in `<profile>/plugins/catalog-cache.json` for six hours. When the network
fails the cache is served and flagged stale — a directory the user cannot reach is more useful
stale than empty. The fetch happens in Rust, so no CSP change was needed.

Keeping the index in the app repository is the simple starting point — moving it to its own
repository later changes one constant and keeps the URL shape.

### Publishing a plugin

The plugin lives in its author's repository; nothing is hosted here. Getting listed is a pull
request against `main` adding one entry to `plugins.json`.

1. Publish the plugin somewhere a person can download it — a release asset, or a folder in the
   repository. The link must be reachable without signing in.
2. Open a pull request adding one object to `plugins`, keeping the file valid JSON.
3. Once it is merged, the entry reaches everyone within six hours, or immediately on *Refresh*.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Must match the `id` in `plugin.json`. Letters, digits, `-`, `_`, `.` only. |
| `name` | yes | Shown in the list. |
| `downloadUrl` | yes | `https` only. Where *Get plugin* sends the user. |
| `description` | no | One line. |
| `author` | no | Shown as *By …*. |
| `repo` | no | `owner/name`, displayed only — never used to build a path. |
| `version` | no | Shown next to the name. |
| `minApiVersion` | no | Defaults to `1`. Older apps hide the entry instead of failing on it. |
| `capabilities` | no | Copy them from `plugin.json` so the list can show what the plugin asks for. |
| `package.url` | no | `https` link to a zip. Adding it makes the plugin installable from the app. |
| `package.sha256` | with `package` | 64 hex characters over the exact zip bytes. |

An entry that breaks the rules is **dropped silently** rather than shown, so a listing that never
appears is usually a malformed `id`, an empty `name`, a non-`https` link, or a `minApiVersion`
above the running build. `capabilities` here is a label for the user: the app enforces the ones in
the installed `plugin.json`, not the ones claimed in the index.

Review is a human reading the pull request. Listing is not an endorsement and not an audit — the
plugin still arrives switched off and still goes through the trust dialog, which is why the
catalogue can afford to be an open directory.

An empty `plugins` array is a valid index and the correct thing to publish while nothing is ready:
the app shows an empty catalogue instead of an error.

`package` is optional and older builds ignore it, so adding one does not need a schema bump and does
not break an app that predates installing.

### Building the package

The zip holds the plugin directory — `plugin.json` at the root, or inside a single wrapping folder,
which is the shape a forge's "download zip" produces. Anything else is refused as ambiguous.

```powershell
Compress-Archive -Path my-plugin\* -DestinationPath my-plugin.zip
(Get-FileHash my-plugin.zip -Algorithm SHA256).Hash.ToLower()
```

```bash
zip -r my-plugin.zip my-plugin
sha256sum my-plugin.zip
```

Attach the zip to a release and put that URL in `package.url`. **Re-hash whenever the zip changes**:
a stale hash does not install a stale plugin, it fails the check and installs nothing.

The plugin's `main.js` must be a bundle that binds against `window.alethe` rather than importing the
host. Do not bundle React — take it from `window.alethe.react`, which is why the surface is
string-keyed: the app is minified with `mangle.toplevel`, so nothing is reachable by module name.
`docs/examples/notes-plugin/` is a working plugin in plain JavaScript with no build step at all, and
is the shortest way to see the contract.

## Where things live

| Path | Role |
|---|---|
| `src/lib/plugins/host.ts` | discovery, declaration, activation, enable/disable, the plugin context |
| `src/lib/plugins/registry.ts` | `ContributionList` and the contribution registries |
| `src/lib/plugins/permissions.ts` | capability matching and the forbidden-command list |
| `src/lib/plugins/localTransport.ts` | `window.alethe` and the local `<script>` loader |
| `src/lib/plugins/storage.ts` | `context.storage` — the per-plugin persisted record |
| `src/lib/plugins/icons.ts` | the icon names a manifest may use |
| `src/lib/themeTokens.ts` | theme token sanitization and stylesheet injection |
| `src/lib/tauri/plugins.ts` | IPC bindings |
| `src-tauri/src/plugins.rs` | manifest storage, id validation, enable/disable state |
| `src-tauri/src/plugin_assets.rs` | `alethe-plugin://` path resolution and safety |
| `src/components/ContributedView/` | renders a declared view, activating it on reveal |
| `src/components/modals/preferences/PluginsPage.tsx` | the management UI |
| `src/components/ContributedModals/` | mounts the contributed modal matching `openModal` |
| `src-tauri/src/plugin_catalog.rs` | the catalogue index: fetch, cache and validation |
| `src-tauri/src/plugin_package.rs` | download, checksum and safe unpacking of a package |
| `src/components/modals/preferences/PluginCatalog.tsx` | the catalogue UI |
| `plugins.json` | the published index |
| `src/plugins/` | bundled plugins |

Enable/disable state lives in `<profile>/plugins/state.json` and covers bundled plugins too, so the
choice survives an app update. The two sources are treated differently on purpose: a **bundled**
plugin runs unless it is listed as disabled, while a **local** plugin runs only once it is listed as
enabled. Dropping a folder into the plugins directory therefore grants nothing by itself — the
plugin shows up switched off and enabling it goes through the trust dialog.
