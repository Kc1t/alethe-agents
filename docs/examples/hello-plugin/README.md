# Hello Plugin — a local plugin you can run without a build step

Copy this whole folder into Alethe's plugins directory, keeping the folder name
equal to the manifest `id`:

```
<plugins folder>/example.hello/plugin.json
<plugins folder>/example.hello/main.js
```

Find the folder through **Preferences → Plugins → Open plugins folder**, then press
**Rescan folder** on the same page. The plugin appears as `Local`, **disabled** — enabling it asks
you to confirm the capabilities it wants first, because nothing has reviewed it.

Once enabled:

- A **Hello** tab appears in the right sidebar. Its code loads the first time you open it, not
  before — that is `"activation": ["onView:example.hello.panel", …]` at work.
- `Ctrl+P` → "hello" runs **Hello: say hi**, which bumps the counter the panel shows.

## What it demonstrates

- Declaring a view and a command in `plugin.json`, so Alethe can draw the tab without running any
  plugin code.
- Implementing them with `context.registerView` / `context.registerCommand`. Either call is refused
  if the manifest did not declare that id.
- Binding against `window.alethe` (`react`, `registerPlugin`) instead of importing from the host —
  the production bundle is minified with `mangle.toplevel`, so module names do not survive.
- Reading `SidebarTabProps` (`projectId`, `cwd`, `ptyId`, `terminalName`).
- Styling through the app's own tokens (`var(--fg)`, `var(--accent)`) so the panel follows the
  active theme.

See [`../../PLUGINS.md`](../../PLUGINS.md) for the full contract.
