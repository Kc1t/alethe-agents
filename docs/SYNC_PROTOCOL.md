# Alethe Cloud sync protocol

The contract between the Alethe apps (Windows/Linux in this repo, macOS in Swift) and the Alethe Cloud
server. The server is hosted and closed source; everything a client needs is here. Payload changes are
`contract` entries in [`MAC_PORT.md`](MAC_PORT.md).

Reference implementation: `src/lib/sync/` (engine and scopes), `src/lib/projectSync.ts` (project
identity, machines and paths), `src-tauri/src/cloud_sync.rs` (transport, keyring, sync state,
machine id).

## Server

- Release builds: `https://cloud.kc1t.com`. Debug builds: `http://127.0.0.1:8790` (`wrangler dev`).
- `ALETHE_SYNC_SERVER` overrides the URL at runtime; `ALETHE_SYNC_SERVER_URL` at compile time.
- JSON everywhere. Errors are `{ "error": "<code>" }` with the HTTP status below.

## Sign-in and devices

1. GitHub device flow with the Alethe OAuth App (`client_id` `Ov23liE8HEZvJ3LGIbIp`), no scopes.
2. `POST /v1/auth/github` with
   `{ "access_token": "<github token>", "device": { "name", "platform", "appVersion" } }`.
   The response is `{ token, deviceId, user: { login, name, avatarUrl }, plan }`. Discard the GitHub
   token; keep `token` in the OS keyring, never in a file.
3. Send `Authorization: Bearer <token>` on every other call. Tokens last 30 days; `GET /v1/me` returns a
   fresh `token` during the last 7 days, which replaces the stored one.
4. `401` means the token expired or the device was revoked: drop the token, the cached account and the
   sync state.
5. Sign out with `DELETE /v1/devices/self`. `GET /v1/devices` lists devices, `DELETE /v1/devices/:id`
   revokes another one.

`GET /v1/me` → `{ user, deviceId, plan: "free" | "supporter", entitlement, limits }`.

## Documents

Data is split into scopes, each one JSON document with an integer `version`.

| Scope | Plan | Contents |
|---|---|---|
| `settings` | free | include-listed preferences and plugin enable state |
| `projects` | free | project settings keyed by project id, with the folder each machine uses |
| `tooling` | free | the account's MCP servers and skills, without secret values |
| `workspace`, `stats`, `vault` | supporter | reserved, not written by clients yet |

- `GET /v1/sync` → `{ profile, scopes: { <scope>: { version, updatedAt, updatedBy: { id, name } } } }`.
  One cheap call that tells which scopes changed.
- `GET /v1/sync/:scope` → `{ payload, version, updatedAt, updatedBy }`, or `404` if never written.
- `PUT /v1/sync/:scope` with header `If-Match: <version the write is based on>` (`0` to create) and
  body `{ "payload": ... }` → `{ version, updatedAt }`.
- `GET /v1/sync/:scope/revisions` and `/revisions/:version` return earlier versions. Restoring is a
  normal `PUT` of the old payload.
- Every call accepts `?profile=<slug>`; clients currently always use the default profile.

| Status | Code | Meaning |
|---|---|---|
| `409` | `conflict` | `If-Match` is stale. The body carries the current `payload` and `version` (`0` and `null` if the scope is gone). Merge and retry. |
| `402` | `plan_required`, `profile_limit` | The plan does not include the scope or another profile. |
| `413` | `payload_too_large` | Over the plan's size per scope (256 KB free, 1 MB supporter). |
| `428` | `if_match_required` | `PUT` without `If-Match`. |
| `429` | `rate_limited` | Over the plan's writes per hour (30 free, 600 supporter); see `Retry-After`. |

## Payloads (format 3)

Every payload has `"format": 3`. A client that reads a higher format must stop and ask the user to
update (`client_outdated`); it must never write over it.

```jsonc
// settings
{ "format": 3,
  "preferences": { "uiTheme": "dark", "language": "en", ... },   // include-list in scopes/settings.ts
  "plugins": { "alethe.todos": true, "some.plugin": false } }

// projects: key = project id, machines keyed by machine id
{ "format": 3,
  "projects": { "p1": { "id": "p1", "name": "Alethe",
                        "githubUrl": "https://github.com/Kc1t/alethe", "color": "...", ...,
                        "machines": {
                          "V1StGXR8_Z5jdHi6B-myT": { "name": "DESKTOP-1", "path": "~/code/alethe" },
                          "Uakgb_J5m9g-0JDMbcJqL": { "name": "MacBook", "path": "~/src/alethe",
                                                     "custom": ["tooling"] } } } } }

// tooling: key = "<agent>::<name>"
{ "format": 3, "capturedAt": 1760000000000,
  "mcpServers": { "claude::github": { ToolingMcpServer } },
  "skills": { "codex::review": { "agent": "codex", "name": "review", "bundled": true } } }
```

- Preferences are an include-list: secrets (`router9`, Spotify), machine-local choices and runtime
  state never travel. A key a client does not know is kept, not dropped. Plugin records under
  `plugin-data/`, such as the Jev plugin's voice settings and key, are never part of the payload.
- Plugins: a client applies the flag only to plugins installed locally and keeps the others.
- Project fields: the include-list in `projectSync.ts`. No terminals, layout, PTY or session ids.
  Inline icons over 32 KB are left out.
- MCP servers carry env and header key names only; values are entered again on each machine.

### Machines

Projects belong to the account; folders belong to machines. Each machine decides which account
projects it has and where they live.

- The machine id is a random id stored in `machine-id` at the root of the app-data directory, shared
  by the profiles of one installation. A non-default profile uses `<machineId>:<profileId>` so two
  local profiles on one computer never share a project list. The name is the host name, plus
  ` · <profile name>` for a non-default profile.
- `machines[<machineId>]` exists only while that machine has the project. `path` is the project
  folder relative to the home folder (`~/code/app`), with `/` separators; paths outside home stay
  absolute (`D:/work/app`, `//wsl.localhost/Ubuntu/home/me/app`). `custom` lists the setting groups
  that machine keeps local (see below).
- A machine writes only its own entry and keeps the others as it last saw them. It never writes the
  folder of another machine and a pull never changes a local folder.
- A project another machine added is not created locally. Clients list it as available and add it
  when the user asks, with the first folder from `machines` that exists locally, a folder the user
  picks, or no folder (`pendingRelocation`, so the user can locate or clone it later).
- Removing a project locally removes this machine's entry. When no machine is left, the project is
  removed from the document.
- A project this machine still has is never removed by a merge: if the remote document dropped it,
  the machine adds it back with its own entry.
- Forgetting a machine (for a computer no longer in use) is recorded in the sync state as
  `forgetMachines` and applied on the next sync by removing that machine's entries; a machine never
  forgets itself. A forgotten machine that syncs again adds itself back.

### Per-machine settings

`Project.localOverrides` (local only) lists setting groups this machine keeps out of sync:

| Group | Fields |
|---|---|
| `agents` | `worktreeMode`, `validationCommands`, `healthCheckCommand`, `healthCheckPath`, `gsdWatcherEnabled`, `conflictAgentProvider`, `conflictAgentModel`, `reviewAgentProvider`, `reviewAgentModel`, `graphifyEnabled`, `autoWorktree`, `mergePostAction` |
| `tooling` | `toolingManifest` |

For a listed group the machine writes the shared values it last synced instead of its own, and a
pull does not change its local values. The group is published in its `machines` entry as `custom`.
When the user turns a group off, the client either copies the shared values into the project (use
the shared version) or just clears the flag so the local values sync (share this version).

### Project identity

Projects are keyed by id. A local project with no counterpart by id is linked to an unclaimed remote
project with the same normalized Git remote (ssh, https and scp forms are equal, credentials removed)
or a folder hint equal to one in its `machines`. The link is a local alias `remoteId → localId` kept in
the sync state, so local ids never change.

## Merge

Clients merge; the server only stores and versions documents. For each scope a client keeps the last
document it synced (`base`).

1. Read the manifest. If the scope's version equals the stored one, the remote document is the base.
   If the scope is missing on the server, merge with no base (nothing gets deleted).
2. Three-way merge `base`, `local`, `remote`:
   - Fields and preference keys: a side that changed wins. If both changed, the local value wins. With
     no base, the remote value wins (a new machine adopts the account's settings).
   - Keyed entries (projects, plugins, MCP servers, skills): added on either side is kept. Removed on
     one side and unchanged on the other is removed. Removed on one side and edited on the other is
     kept. Entries on both sides merge field by field. A project's `machines` map merges as keyed
     entries of its own, so two machines changing their folders never collide.
   - Projects then follow the machine rules above: this machine's entry comes from local data, a
     project it has is kept, and a project with no machine left is dropped.
   - For preferences and plugins, a missing key means no opinion, not a removal.
3. Apply the result locally, then `PUT` it with `If-Match: <remote version>` unless it equals the
   remote document. On `409`, use the document you merged against as the new base, the returned one
   as the new remote, and merge again (up to 3 times).
4. Store the merged document and its new version as the base.

The sync state lives in `<profile>/sync-state.json`:
`{ version: 1, lastSyncAt, scopes: { <scope>: { version, base } }, aliases: { projects: { remoteId: localId } }, forgetMachines: [] }`.
It is device-bound: excluded from backups, cleared on sign-out, and reset when a backup is imported.

## Settings file

Sync → File exports the same scopes as `{ "kind": "alethe-bundle", "format": 3, "exportedAt",
"scopes": { "settings", "projects", "tooling" } }` with the `.alethe` extension. Import is a merge with
no base (the file wins conflicts, nothing is deleted) and shows a preview first. Unlike a cloud sync,
an import creates the file's projects that are missing locally, in the first folder from their
`machines` that exists here or with `pendingRelocation`.

## Billing

`POST /v1/billing/checkout` with `{ "interval": "month" | "year" }` → `{ url }` (Polar checkout, open
in the browser). `POST /v1/billing/portal` → `{ url }` (`404 no_customer` before the first purchase).
`POST /v1/billing/refresh` re-reads the subscription and returns `{ plan, entitlement }`; call it when
the app regains focus after checkout. `503 billing_unavailable` when the server has billing turned off.

## Account

`GET /v1/export` returns everything stored for the account. `DELETE /v1/account` deletes it and
cancels an active subscription; the client then clears its token and sync state.
