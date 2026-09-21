# Installing plugins from the catalogue — Design

Date: 2026-09-18
Status: **superseded — do not implement.**

> Shipped independently in `d8e98a7` (released in 1.7.0) while this was being written. The
> implementation follows the same trust chain — sha256 pinned in the index, bounded download and
> extraction, plugin arrives disabled, same button updates in place — and differs in one respect
> worth keeping: it nests the artifact as `package: { url, sha256 }` instead of the two loose
> fields §4.2 proposes. The nesting makes "both or neither" true by construction rather than by a
> validation rule, which is the better shape. Kept for the reasoning in §5.2 (updating on
> capability appetite, not version) and §8 (what the app requires of the publishing standard and
> the index), neither of which shipped with it.

> This is **subsystem A** of plugin distribution. Two others follow, each with its own spec:
> **B — the publishing standard** (how a plugin repository is laid out, what a release must contain,
> and a worked example repository), and **C — the index and its upkeep** (how an entry enters
> `plugins.json`, who reviews it, and what keeps version, hash and download counts current).
> §8 states what A requires of them, so they are designed against a contract that already exists.

## 1. Problem

The catalogue lists plugins but cannot install one. `PluginCatalog.tsx:113`'s button calls
`plugin_catalog_open` (`src/lib/tauri/plugins.ts:130`), which opens the listing in a browser; the
person then downloads a folder, finds it on disk, and imports it by hand. The module says so
plainly: "Nothing is downloaded or executed from here: the catalogue is a directory, and installing
still goes through the user importing a folder" (`src-tauri/src/plugin_catalog.rs:4-6`).

That was a deliberate decision, and this design reverses it with the owner's agreement. The reason
to reverse it: a directory that cannot install is a directory most people will not use, and the
manual path asks the least-equipped person to do the most delicate step — unpacking an archive from
the internet into an application's plugin directory — with no bounds at all.

## 2. Goals

- Install a catalogued plugin **from inside Alethe**, with the artifact verified against a hash the
  catalogue publishes.
- Keep a door for a plugin that is not catalogued: the person pastes a URL and accepts the risk.
- Never run anything without consent. A plugin arrives disabled, as an imported folder already does
  (`src-tauri/src/plugins.rs:469`).
- Update an installed plugin without losing its data and without silently widening what it may do.
- Make it possible, later, to tell where an installed plugin came from.

## 3. Non-goals

- **No sandbox.** Plugins run in the main webview with full power; that decision stands
  (`docs/PLUGIN_ROADMAP.md` §2). Verifying the artifact proves *what* runs, never *what it may do*.
- **No plugin registry of our own.** The index stays one JSON file in the app's repository.
- **No install count.** GitHub counts asset downloads; that is what we show and what we label it.
- **No GitHub API calls from the app.** See §8.
- Uninstall keeps its current meaning — the plugin gone, data included (`plugins.rs:544`).

## 4. The model

### 4.1 Two doors, and telling them apart

**The catalogue door** carries a guarantee: the index publishes a `sha256` for a named artifact, and
Alethe refuses anything that does not hash to it.

**The manual door** carries none: the person pastes a direct URL to a zip and accepts that. This is
the trust level that already exists when someone downloads a folder themselves; what changes is that
Alethe does the unpacking, under the bounds of §6, instead of the person doing it by hand.

Because the two doors differ in what they promise, an installed plugin records **where it came
from** — `catalog`, `url` or `folder` — and the Plugins page shows it. Without that, a verified
install and a pasted-URL install become indistinguishable a month later, and the first door's
guarantee quietly dilutes into the second's.

Provenance is stored **outside the plugin's directory**, alongside the enabled/disabled state,
because an update replaces that directory (`plugins.rs:401-402`) and would take the record with it.
For a `url` install the URL is stored too, so reinstalling does not send the person hunting for the
link again.

### 4.2 What the index gains

`CatalogPlugin` (`plugin_catalog.rs:35-53`) gains three fields, all optional:

```rust
/// The artifact itself. HTTPS only. Absent means this entry is a directory listing, not an install.
pub artifact_url: Option<String>,
/// Lowercase hex sha256 of the bytes at `artifact_url`. Required with it, meaningless without it.
pub sha256: Option<String>,
/// How many times the artifact has been downloaded, as published by C. Never called "installs".
pub downloads: Option<u64>,
```

`artifactUrl` and `sha256` are optional **together**: an entry with one and not the other is a
malformed entry and the plugin is listed as non-installable rather than installed unverified. An
entry with neither keeps today's behaviour, its button still opening the browser. This is why
`SUPPORTED_SCHEMA` stays at `1` (`plugin_catalog.rs:18`) — old entries remain valid, and a catalogue
may hold both kinds while authors catch up.

`downloadUrl` keeps its meaning and its comment: where a person goes, opened in a browser, never
fetched.

### 4.3 The trust chain

The index is served over HTTPS from the app's own repository
(`plugin_catalog.rs:15`), so it is exactly as trustworthy as Alethe itself. It carries the hash. The
artifact may live anywhere: the hash, not the host, is what makes it safe to run. An author whose
account is compromised after publication cannot swap the bytes without the hash failing.

That reasoning does not extend to privacy. Fetching an arbitrary URL means the app talks to a third
party, which learns that someone is installing. HTTPS and the size bound of §5 make this acceptable;
a host allowlist is deliberately **not** proposed, because it would buy nothing for integrity and
would make the catalogue a gatekeeper of hosting.

## 5. The flow

One command does the whole path, in this order:

1. **Fetch.** `artifact_url` must be `https`, including after every redirect — a redirect to `http`
   is the hole that an initial-scheme check alone leaves open. The response is read with a ceiling
   of **8 MiB** and a timeout of its own; `REQUEST_TIMEOUT` is 8s (`plugin_catalog.rs:16`), sized for
   a JSON index, not an archive.
2. **Verify**, for the catalogue door only: sha256 over the received bytes, compared to the entry.
   A mismatch refuses, and nothing is written anywhere that survives the call.
3. **Unpack** into a temporary directory **outside** `plugins/`, under §6's rules. Everything below a
   plugin directory is served over `alethe-plugin://`; an archive halfway through validation must
   never be reachable by URL, not even briefly.
4. **Import** by handing that directory to the existing `import_dir_into` (`plugins.rs:367`). It
   already reads and validates `plugin.json`, checks the id, the name, the API version, the declared
   contributions and every declared asset, refuses symlinks, and bounds files, bytes and depth. A
   second validation written beside it would drift, and the drifting one would be the one that
   matters.
5. **Record** provenance, and the source URL for the manual door.

On any failure after step 3, the temporary directory is removed. A failed install leaves nothing.

### 5.1 Consent

The plugin arrives **disabled**. Enabling it is the consent, and it goes through the trust gate that
already exists.

For a catalogue install, the gate shows what the manifest actually asks for, highlighting anything
the catalogue entry did not advertise. Because the hash already proves the artifact is the reviewed
one, such a difference means a stale index entry, not an attack — so it is shown, not refused.
Refusing would strand the person behind a maintainer's forgetfulness, with nothing they can do.

### 5.2 Updating

An update is the same path, ending in an import that replaces the directory. The plugin's data lives
outside it (`plugins.rs:483-485`) and survives.

What decides whether the plugin keeps running is **appetite, not version**:

- the new manifest asks for the same capabilities, or fewer → it stays enabled;
- the new manifest asks for a capability the person never consented to → it drops to disabled and
  the trust gate asks again.

Asking for less is not a reason to interrupt anyone. Asking for more is new consent, and consent was
given to an appetite, not to a name.

## 6. Unpacking safely

The zip is expanded under the same ceilings the folder import already enforces — `MAX_IMPORT_FILES`
(200, `plugins.rs:321`), `MAX_IMPORT_BYTES` and `MAX_IMPORT_DEPTH` — reusing those constants rather
than defining zip-only twins that would diverge. `zip = "0.6"` is already a dependency
(`src-tauri/Cargo.toml:46`), as is `reqwest` (`:48`); `sha2` is added.

Three refusals belong to the format itself:

**A name that escapes.** Every entry name is normalized and refused if the result leaves the
temporary directory: `..` segments, an absolute path, a drive letter. The refusal also covers the
characters Windows treats specially, for a reason this repository learned the expensive way — a `:`
in a scrollback file name silently made the file an NTFS alternate data stream.

**A declared size is a claim, not a fact.** A zip bomb declares little and expands hugely, so the
ceiling is enforced twice: against the size the entry declares, before writing, and against the bytes
actually written, while writing. Either one exceeding aborts the install and removes the temporary
directory.

**Anything that is not a regular file or a directory** is refused, matching the existing
`plugin_contains_symlink`. In a zip a symlink is an attribute rather than a type, so this is checked
on the entry's mode, not inferred from the name.

### 6.1 One wrapper directory

If the archive holds exactly one top-level directory and no `plugin.json` at its root, Alethe
descends one level. That is the shape GitHub produces when it zips a repository, and refusing it
would be pedantry with no security value — the descent happens before any other rule, and every rule
then applies to the directory that was descended into.

## 7. What the person sees

**In the catalogue.** The row's button reads **Install** when the entry carries an artifact and a
hash, and keeps **Open in browser** when it does not; both kinds live in the same list. An installed
plugin's row shows its version, and becomes **Update to 0.4.2** when the index holds a newer one.
The download count appears in the row labelled as downloads — never as installs, because that is not
what it measures.

**Feedback is conclusive.** The install reports what happened: it succeeded, or it failed and this
was the error. This is not a general preference; it is the specific bug this repository shipped and
fixed this week, where an installer that had already finished its work left the modal spinning
forever and a second one closed with nothing said at all.

**The manual door** sits beside the existing folder import: a field for the zip's URL and one honest
sentence saying nothing is verified there. One sentence, not a wall of warning — a wall gets read as
decoration.

**In the Plugins page**, each installed plugin shows its provenance: from the catalogue, from a URL,
or from a folder.

## 8. What A requires of B and C

**Of B, the publishing standard:**

- `plugin.json` sits at the root of the plugin directory, as it already must for a folder import
  (`MANIFEST_FILE`, `plugins.rs:19`). A zip satisfies the same rule, with §6.1's single allowance.
- The archive is a zip.
- **The asset's file name does not matter.** Because the index points at an exact URL, no naming
  convention is needed — one fewer rule for the standard to invent and for authors to get wrong.

**Of C, the index and its upkeep:**

- Each installable entry publishes `artifactUrl`, `sha256` and `version`, and the three move
  together: an entry announcing a version whose hash belongs to another build is worse than an entry
  with no hash at all, because it fails at install time with a message that blames the download.
- `downloads` is filled by C, from the counts GitHub already keeps for release assets.

The app deliberately makes **no GitHub API calls**. If each open of the catalogue queried per-plugin
download counts, the app would hit unauthenticated rate limits and would disclose to GitHub which
plugins a person is looking at. Folding the counts into the index keeps the client doing exactly what
it does today: one request, to one URL.

## 9. Testing

Decisions live in pure functions; the command wiring stays thin.

**Rust:**

- a hash mismatch refuses, and no directory is left behind;
- an entry whose name escapes the temporary directory is refused, including the Windows-specific
  spellings;
- an entry that declares a small size and writes a large one is caught by the written-bytes ceiling;
- a symlink entry is refused;
- an archive with a single top-level directory and no root manifest is descended into;
- a non-HTTPS URL is refused, and so is an HTTPS URL that redirects to HTTP;
- the update rule: equal or narrower capabilities keep the plugin enabled, a new capability disables
  it.

**TypeScript:** the capability difference between manifest and catalogue entry; when a row offers an
update; the provenance labels.

**By hand, and only by a person:** installing the example plugin from B end to end in the running
app. This doubles as the proof `docs/PLUGIN_ROADMAP.md` §3 records as never having been run — that
WebView2 serves `alethe-plugin://` the way the CSP expects, so a local plugin's `entry` actually
loads. Until someone does this, that remains read, not executed.

## 10. i18n, changelog, house rules

Every visible string goes through `t()` and is registered in both `en.ts` and `pt-BR.ts`; the build
fails otherwise. Styling stays on CSS Modules and theme tokens. `docs/CHANGELOG.md` gains an
`[Unreleased]` entry describing, in the person's terms, that plugins can now be installed from
inside Alethe. `docs/PLUGINS.md` and `docs/PLUGIN_ROADMAP.md` both describe the old rule that
nothing is downloaded, and both are corrected in the same task — including the module comment at
`plugin_catalog.rs:4-6` that states it outright.

## 11. Alternatives rejected

- **Trusting `downloadUrl` as it stands, with no hash.** The shortest path, and it would mean the
  app runs whatever is at that URL at the moment of download, with nothing tying it to what was
  reviewed when the entry was accepted.
- **A repository tarball pinned to a commit** instead of a release asset. It needs no release from
  the author and a pinned commit is already immutable, but it ties distribution to GitHub and ships
  a whole repository where a built plugin was wanted.
- **Resolving a pasted repository URL to its latest release.** Friendlier, and it depends on the
  GitHub API, its rate limits, and a guess about which asset is the right one when there are
  several — a guess that will be wrong somewhere, in a way the person cannot diagnose.
- **Refusing an install when the manifest asks for more than the entry advertised.** A stronger
  guarantee that only what was reviewed and announced can run, paid for by the person, who cannot
  fix a stale index.
- **Dropping every update back to disabled.** The simplest rule to explain and the most honest about
  the fact that different code is about to run — and it turns each of an author's bug fixes into a
  plugin the person has to notice and switch back on.
- **A host allowlist for artifacts.** Nothing for integrity, since the hash already settles it, and
  it would make the catalogue a gatekeeper of where plugins may be hosted.
