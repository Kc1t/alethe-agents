# Bug: characters appear duplicated when typing into a terminal

## Symptom

Typing directly into a terminal pane (observed in a Claude Code session, `npm run app`
dev build) renders **duplicated characters** on screen — not random typos, a consistent
letter-doubling pattern. Example, reconstructed from a live screenshot:

```
typed:    tudo que eu escrevo aparece corrompido de modo fantasma
rendered: tudooqueeescrevooapprece corrompidooe ddemodoofantasmas
```

Confirmed by the user as a real rendering bug (letters genuinely different from what was
typed), not fast typing/typos.

## Leading hypothesis

Most interactive CLIs (Claude Code included) render their own composer by **echoing
typed characters back over stdout** as they're received — they don't rely on local
terminal echo. If the frontend has **two live listeners on the same PTY's output stream**
(`pty://data/{id}` / the `listenPtyData` Tauri event) for the same session, every byte the
CLI echoes gets written into the xterm.js buffer twice, producing exactly this
letter-for-letter doubling. This would NOT double literal keystrokes sent to the process
(so command execution / actual input value is unaffected) — only what's *rendered*.

React 18 `StrictMode` is enabled (`src/main.tsx:88`), which double-invokes effects on
mount in dev only (mount → cleanup → mount) specifically to catch missing-cleanup bugs.
That was the first suspect.

## What's already been ruled out

1. **`onData` (typed-keystroke) write ordering** — `src/components/XTermView/useXtermSession.ts`,
   `queueInput`/`flushInput`/`inputWriteChain` (~line 1094-1113). Single shared
   `inputWriteChain` promise, appended-to synchronously before any `await` — no possible
   interleaving under rapid typing. Not the cause.
2. **PTY output-listener StrictMode leak** — `registerPtyStreamListeners`
   (~line 1533-1610). Every `await listenPtyData(...)` / `listenPtyActivity(...)` /
   `listenPtyResync(...)` / `listenPtyResized(...)` is immediately followed by
   `if (disposed) { xUnlisten(); return false }` before the disposer is stored in
   `unlistenData`/`unlistenActivity`/etc. This is the correct StrictMode-safe pattern — a
   cancelled (first) invocation's late-resolving listener registration unlistens itself
   immediately instead of leaking. Doesn't look like the source, assuming `disposed` is
   flipped synchronously in the effect's cleanup (worth double-checking, but the pattern
   itself is sound).
3. **This session's own changes** — the only commit this session touching this file
   (`d7f6187`) modified `pasteText` (the Ctrl+V / browser-paste-event path only). It does
   not touch `onData` or the PTY output-listener registration at all. Unlikely to be the
   introduction point, though a full `git bisect` was not run to confirm.

## Where to look next

- Confirm the `disposed` flag (declared near the top of the big effect starting at
  `useXtermSession.ts:335`) is set to `true` **synchronously** as the very first line of
  the effect's cleanup (returned around line 2446), before any other teardown. If
  something async runs before that flag flips, the disposed-check pattern above stops
  being reliable.
- Check whether the SAME `ptyId` can legitimately be attached from more than one call
  site at once outside of this effect (e.g. a secondary viewer/mirror pane — see the
  `gsdSyncViewer` concept and the "shared grid" comments throughout this file — anything
  that also independently calls `listenPtyData`/`registerPtyStreamListeners`-equivalent
  logic for the same id).
- Check the Rust side (`src-tauri/src/pty.rs`) for the event-emission loop: is it
  possible for a single PTY session to end up with two live output-broadcast
  subscriptions registered against the same frontend `ptyId` (e.g. after a restart/resume
  that doesn't fully tear down the previous broadcast task)?
- Reproduce live with logging: add a temporary counter/log inside the `listenPtyData`
  callback (the one at `useXtermSession.ts:1538` calling `queueTerminalWrite(chunk)`) to
  confirm whether it fires twice per actual PTY output event, or whether the duplication
  happens elsewhere (e.g. `queueTerminalWrite`/the render/write-flush path itself writing
  each queued chunk twice).
- Determine whether this only reproduces in the `npm run app` (dev, StrictMode) build, or
  also in a production/installed build — if it's dev-only, that all but confirms the
  StrictMode-related PTY-attachment angle even though the specific leak site hasn't been
  found yet.

## Repro

Type continuously into any active terminal tab running an interactive CLI that echoes
its own input (Claude Code, Codex, OpenCode). Was captured happening live during a
`npm run app` dev session on this branch.
