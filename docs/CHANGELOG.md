# Changelog

Notable user-facing changes to **Alethe** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Dates use UTC.

> **Rule:** every feature addition, change, or removal must be recorded under
> `[Unreleased]` in the same task. During a release, `[Unreleased]` becomes the new
> dated version and a new empty `[Unreleased]` section is added at the top.

## [Não lançado]

### Added

- Tasks now has vertical per-project tabs instead of always showing only the currently active project's tasks, tasks can be assigned to one or more collaborators (chips shown per task, editable inline), and a completed task can be reopened again — the backend already supported reopening but had no command, Web route, client, or button wired up.
- Invitations can now block specific project subfolders from being shared, instead of always sharing the whole project; the sidebar lists the project's top-level folders and lets the issuer mark any of them as blocked before sending the invite.
- A new "Conexão & Sincronização" area now takes over the main workspace panel (where agent terminals normally sit) whenever that sidebar tab is active, instead of leaving the previous Home/terminal view visible underneath; it currently hosts working Chat and Tasks tabs, with a Vault & Folders tab still a placeholder.
- Collaboration tasks can now be created, listed, completed, and commented on from the app (previously the feature only existed as an untested backend contract with no UI). Added the missing `sync_update_task`/`sync_assign_task`/`sync_delete_task` commands and Web routes for existing, previously unreachable core functions.
- Project chat is now usable end to end from the app: send/receive text, code blocks, terminal-command blocks (rendered inert, never executed), test results, bug reports, and encrypted file attachments, all in a WhatsApp-style message view. Added the missing send/list-decrypted/edit/delete-message and upload/download-attachment Tauri commands and Web routes, backed by new automated tests.
- Chat message type (code block, terminal command, test result, bug report) is now picked with a `/` slash command in the composer, with a filtered suggestion menu (arrow keys / Enter / Tab to pick, Escape to cancel), replacing the previous `<select>` dropdown; the active type shows as a clearable pill next to the input.
- Project Collaboration preferences now offer a guided Cloudflare deploy: Alethe runs `npm`/Wrangler on the user's own machine to publish a personal rendezvous worker to their own free Cloudflare account (Wrangler's own browser-based OAuth login keeps its token on that device — Alethe never stores a Cloudflare credential), with a live step indicator and log, and an automatic Node.js install prompt (reusing the existing agent-install flow) when Node is missing.
- Chat now actually delivers messages between two different devices, closing a real gap where the chat and P2P systems existed side by side but were never connected: a persistent P2P session (previously the connection handshake succeeded and was immediately discarded) now stays open in the background and carries live message frames, automatically signaled through the user's personal Cloudflare rendezvous worker (deterministic session ID derived from both accounts — no manual pairing code needed for already-trusted collaborators); when a direct P2P path can't be established (e.g. symmetric NAT), messages fall back to encrypted delivery through the same Cloudflare relay instead of staying local-only. The chat header badge now reflects the real connection state (local only / connecting / P2P direct / via Cloudflare) instead of a static "encrypted" label. Attachments still require a direct P2P connection — the relay's envelope size limit (16KB) only fits text/code messages.
- Invitations and P2P connection candidates can now actually be delivered to a different physical device over the existing Cloudflare rendezvous relay, closing a real gap: the invitation-bridge crypto existed and was tested, but `redeem_invitation` required an `InvitationRecord` that only ever existed on the issuer's own document, so a genuinely remote redemption always failed with `invitation_unavailable`. Added `redeem_remote_invitation_at` (materializes the delivered invitation before redeeming) and a cross-device consume command, plus a one-time "pairing code" (device id + public keys, shared out of band) so two different Google accounts with no automated cross-account discovery can bootstrap trust.
- The collaboration sidebar now has a Cloudflare connection card, right below the Google account one: shows whether your personal Worker is set up, online, connecting, or disconnected, with a one-click "Connect"/"Disconnect" action once it's deployed (jumps to the guided Cloudflare setup in Preferences if it isn't deployed yet).
- The chat panel now shows a real conversation list (project channel + one row per chat contact, each with name and avatar), the project channel's title now shows the actual project name instead of a generic label, every message shows the sender's name and avatar (not just the first message in a run), and own messages use your real profile name/avatar instead of a raw device ID.
- Adding a chat contact is now a single, automatic mutual exchange instead of two separate manual code pastes: the exported pairing code embeds a single-use invite token that is invalidated the moment it's used (or as soon as you export a new one), and confirming a pasted code now sends an encrypted acknowledgment back to the issuer over the rendezvous relay, so their device adds you back automatically — neither side has to paste a second code, and a captured/forwarded code can't be replayed to add unlimited people.
- Removed the "P2P connection test with a friend" panel from Project Collaboration preferences — the real chat-contact pairing flow above now covers what it existed to manually validate.
- Chat can now reach people you haven't shared a project with: a new, fully separate "chat contact" record (never a project grant, never touched by any project-authorization code) lets two accounts pair for P2P/relay chat without granting either side any project access; a real `Direct` conversation (find-or-create, never duplicated) is created between two chat contacts, callable from both Desktop and Web.
- A project collaborator can now *suggest* inviting someone else into a project they're on, without ever being able to grant access themselves: the suggestion is sealed end-to-end for the actual project owner (never the collaborator's own device) and delivered over the same Cloudflare rendezvous relay used for chat and invitations; only the owner, deciding to run the normal "Invite" flow from scratch (choosing permissions and folder scope themselves), can turn a suggestion into real access — a suggestion alone never creates a grant or invitation.
- Direct P2P connections between two devices now have a first real implementation: STUN-based public address discovery, UDP hole punching, and a minimal reliable stream wrapping it, feeding the existing (untouched) Phase-4 transport handshake. A new "P2P connection test with a friend" panel in Project Collaboration preferences walks through pairing, sending a test invitation, exchanging connection candidates, and attempting the direct connection, with a live log at every step. Symmetric NAT (common on mobile/carrier networks) still requires falling back to the relay, same as any STUN-only P2P system.

### Changed

- Removed the "Alethe service" (shared operator-managed rendezvous) option from Project Collaboration preferences — it was never actually deployed (it showed "this build has no official endpoint configured" if selected) and contradicted the personal-Cloudflare-Worker architecture already implemented; the only online mode is now your own Cloudflare Worker, guided end to end from the same screen. See ADR-0002's amendment for the full reasoning.
- The Cloudflare Worker's server address field in Preferences now only shows as an editable box before a Worker is deployed; once deployed it shows as a read-only line with an "Edit manually" escape hatch, instead of always presenting a raw URL input regardless of state.
- The guided Cloudflare deploy's log now strips ANSI escape codes and collapses carriage-return progress-bar redraws before displaying, instead of dumping raw terminal control sequences as garbled text; falls back to the raw log if the processed version is ever blank, and has a "copy log" button. Also auto-answers any other Wrangler `(y/n)` prompt (not just the known "install skills" one) by typing into the live PTY, fixed a stuck `wrangler login` state after a piped prompt answer, and surfaces a specific, actionable message (with a dashboard link) when Cloudflare's own "you need a workers.dev subdomain" first-deploy error occurs — confirmed working end to end against a real Cloudflare account (`npm install` → login → secret → deploy → live `*.workers.dev` URL).
- The chat panel and its header/composer now have their own distinct background instead of blending into the app's base background, making the panel read as a separate surface.
- Tasks now show as a Kanban-style board with one column per category (drag a card to another column to change its category) instead of a single vertical list with filter buttons; each column header can rename or delete its category (deleting a column removes the category and clears it from any task that had it), and "+ Adicionar categoria" creates new columns.
- Chat no longer requires an active project to be usable — the "Conexão & Sincronização" chat tab used to show a "no project" empty state whenever no project was selected, even though chatting with a contact never needed a project in the first place. Tasks and Vault still require an active project (they're inherently project-scoped).
- Adding a chat contact now automatically configures the rendezvous endpoint needed to actually reach them, closing a real gap: previously, delivering a message to a new contact silently failed forever (stuck showing "local only") unless both people happened to already be connected to the exact same Cloudflare Worker URL — there was no way to discover it otherwise, since there's no central directory by design. The pairing code now optionally carries the issuer's own validated Worker URL; if the person adding the contact doesn't already have their own endpoint configured, theirs is adopted automatically (never overrides an existing setup).
- Chat contacts can now be removed (trash icon next to each one in the conversation list) — message history is kept, only future auto-connect/trust for that contact is revoked.
- Fixed a `chat_contact_not_found` failure (chat stuck showing "could not load or send messages") that happened whenever the currently-open direct conversation's contact became stale — e.g. it was removed and the app never re-checked whether the selected conversation still pointed at a real contact. The chat list now falls back automatically the moment a stale selection is detected. Also stopped every chat failure from being silently swallowed — the real underlying error is now logged to the console instead of only a generic "failed" flag, which is what actually surfaced this bug.
- Fixed the automatic mutual chat-contact add-back silently failing whenever the issuer had reopened their own "add contact" screen after already sharing their code: exporting a pairing code unconditionally generated (and invalidated) a brand new single-use token every time, even just to re-view/copy the same code — so a token already in flight to someone else would die before they ever got to use it. Exporting now reuses the still-valid current token instead, and only an explicit "new code" action invalidates it.
- Adding a chat contact now pre-fills their name from their own profile automatically (detected from the pairing code they exported), instead of always starting from their raw device id — still fully editable before saving.
- Chat contacts can now be renamed at any time (pencil icon next to each one), not just once when first adding them.
- **Fixed messages arriving at the server (and even firing a notification) but never actually showing up in the chat**: `ChatTab.tsx`'s chat-contact-ack listener and `ChatPanel.tsx`'s chat-message listener each independently polled the same shared, drain-once server event queue — whichever of the two happened to call first in a given tick "stole" every event that tick, including kinds it didn't care about, and silently discarded them. Reproduced live: a message that visibly triggered a "you were mentioned" notification (fired earlier in the pipeline, before this race) never appeared in the conversation. Event draining is now centralized in one place (`rendezvousEventBus.ts`) that fans every event out to every interested listener, so nothing can be stolen out from under another.
- Fixed the rendezvous connection getting permanently stuck on "connecting" (reproduced live, consistently, even on a fresh manual reconnect on a LAN, with the Worker itself confirmed healthy over plain HTTPS): the actual WebSocket connect step had no timeout at all, unlike every read after it — if that specific handshake silently hangs (some firewalls/antivirus drop WS-upgrade packets without a clean refusal), the connection attempt never fails, so the retry loop below it never got a chance to run. It's now bounded by the same 15s timeout as the rest of the connection sequence.
- The rendezvous connection now sends a heartbeat (a native WebSocket ping plus a refreshed presence frame) every 20 seconds, so a silently-dead connection — a real case observed live, on the same LAN — is detected and reconnected within seconds instead of waiting on an OS-level timeout that can take minutes.
- Chat messages are now always displayed in true chronological order (by sequence, then timestamp), not arrival order — cross-device delivery can land messages slightly out of sequence, which used to visibly shuffle the thread.
- Added timing/diagnostic logging around message send, relay delivery, and every P2P connection-state transition, to make it possible to tell exactly where a slow or dropped send is actually happening instead of guessing.
- Fixed an infinite "you were mentioned in chat" notification loop: delivered mailbox items were never acknowledged back to the relay, so the server kept redelivering the exact same already-seen item on every future reconnect — each redelivery fired a brand-new notification and access-center record for something that had already arrived. Every delivery is now acknowledged as soon as it's received.
- **Fixed the actual reason a Direct chat message could never decrypt on the receiving device, ever**: each device created its own `Direct` conversation record independently, with a random id and a random encryption key generated locally — meaning the two devices' conversations for "the same" chat were, cryptographically, two completely unrelated conversations. A message encrypted under the sender's random key could never be decrypted with the receiver's own, different, random key, no matter how well everything else (pairing, endpoint discovery, relay delivery) worked. `Direct` conversations now use a deterministic id (computed identically by both sides from the two account routes) and derive their encryption key via a plain ECDH shared secret between the two members' own long-term keys — symmetric by construction, so both devices arrive at the exact same key with nothing to transmit or agree on ahead of time.
- Fixed a chicken-and-egg gap where a device with zero chat contacts yet could never actually receive the automatic mutual add-back ack: the ack-listening loop assumed the relay connection was already established by something else (normally the chat panel of an existing conversation), but with no contacts yet there was nothing else to open that connection — so the very first pairing's auto-add-back could silently never arrive. That loop now connects the relay itself if needed.
- Fixed the rendezvous connection flapping (connect → drop → reconnect, on a loop, never staying up) caused by the previous fix above: `connectRendezvous()` is called from more than one independent place on the frontend, and it used to unconditionally tear down and restart the connection on every single call — so two callers polling at different intervals kept killing a perfectly healthy connection out from under each other before it could ever stay online long enough to actually deliver anything. It's now a no-op whenever a connection attempt is already in progress.
- The rendezvous connection now reconnects itself automatically once a chat conversation is open — previously, once the connection dropped (or never started because it was disabled/restarted), it settled on "no attempt yet" forever with nothing to kick it again, silently blocking delivery until something incidental (like reopening the conversation) happened to reconnect it.
- Chat contacts now have two distinct removal options: "Remove" (unchanged — keeps message history, only revokes future auto-connect/trust) and a new "Delete contact and all history" that also permanently wipes the Direct conversation with them.
- Added much more detailed console logging across the whole chat-contact pairing flow (both the person adding and the person being auto-added-back) and the P2P/relay send-receive pipeline, so a silent delivery failure can actually be diagnosed instead of only showing a generic "failed" state.
- **Fixed the actual root cause of every live P2P-candidate/chat-message/contact-ack delivery failing silently**: the relay's `enqueue` frame requires an `id` field and an internal `authorizationGeneration` field, but every caller in the app sent `messageId` instead of `id` (a field name that was never valid) and never sent `authorizationGeneration` at all — rejected by the sanitizer as `rendezvous_unknown_field` before ever reaching the Worker. This is likely why chat delivery between two different machines had never actually worked end to end despite everything upstream (pairing, endpoint discovery, P2P signaling) being correct. `authorizationGeneration` is now filled in by the backend itself instead of being a caller responsibility, and every call site sends `id`.
- P2P connections between two devices behind the *same* router (e.g. two people testing on the same home/office LAN) now actually work: each side also discovers and exchanges its own LAN-facing address alongside the STUN-derived public one, and tries punching through the local address first. Previously only the public/STUN address was ever tried, which most consumer routers cannot route back into their own LAN (no NAT hairpinning) — so same-network pairs always fell back to the relay, even sitting in the same room. Falls back to the public address exactly as before when the local one doesn't apply (different networks). Added detailed `[p2p]` diagnostic logging (socket bind, STUN resolution, each hole-punch candidate attempt with its specific failure reason, and the Phase-4 handshake) to make the next silent P2P failure diagnosable from the logs instead of guesswork.
- Fixed the local-candidate punch attempt above (first shipped, then diagnosed live) always failing with a "connection reset": the local candidate reused the peer's STUN-mapped *public* port instead of their actual LAN-bound port — the router almost always translates the port too, so the two numbers are different, and nothing was listening on the wrong port on the peer's LAN address. The local candidate now carries its own port end to end.
- Fixed the P2P candidate-exchange step (still diagnosing the same-LAN case live) silently timing out on one side even after the port fix above: `useP2pAutoConnect.ts` was the one remaining caller of `drainRendezvousEvents()` outside the shared event bus (`rendezvousEventBus.ts`, introduced earlier to fix the exact same class of bug for chat messages/contact acks) — its own direct polling loop could race with the bus's polling for the same drain-once server queue and silently steal the peer's candidate delivery before this loop ever saw it, so the device that lost the race waited the full 10s, gave up, and never even attempted a punch. It now subscribes through the shared bus like every other listener.
- **Fixed chat messages sometimes displaying out of chronological order even with both sides live** (reproduced live: a message sent later showed up above one sent earlier): the message list sorted primarily by `sequence`, but `sequence` is a per-device, per-conversation-file counter that each side's own copy of the conversation starts independently from 1 — "my message #1" and "the other person's message #1" are unrelated numbers that happen to collide, not two points on a shared timeline. The list now sorts by the message's actual creation timestamp first, falling back to `sequence` only to break a tie between same-timestamp messages.
- Fixed a message sent immediately after pairing sometimes never arriving at all (reproduced live): relay delivery was a single best-effort attempt that silently gave up if the connection hadn't finished settling yet (common right after adding a contact), and the message stayed saved only locally, visible to no one but the sender, forever. Delivery now retries a few times with backoff and re-confirms the rendezvous connection before each attempt.
- **Fixed the P2P direct connection almost never actually establishing, even between two perfectly reachable devices**: each side only ever attempted P2P signaling once (when the chat was first opened), with just a 10-second window to see the other side's connection candidate — so unless both people happened to open the conversation within about 10 seconds of each other, neither side ever saw the other's candidate in time, and the connection permanently settled on the relay for the rest of the session. P2P signaling now retries automatically in the background every 15 seconds for as long as the chat stays open and hasn't connected directly yet, instead of trying exactly once and giving up.
- Fixed the background P2P retry above (introduced moments earlier, then diagnosed live) letting two of its own attempts overlap: each attempt binds a fresh ephemeral UDP socket, so a second attempt starting before the first one finished (each can take up to ~18s) would abandon the socket a peer might already be punching toward and send them a different one instead — reproduced live as "received packet from unexpected source" and consistent punch timeouts even when the exchanged candidate looked correct at send time. Only one attempt can now be in flight at a time.
- **Fixed P2P candidates going stale between the two sides' independent retries even with everything above already fixed**: every retry discovered a brand-new local port via a fresh STUN socket, but the two sides' 15s retry loops aren't synchronized with each other — reproduced live, confirmed from both devices' logs at once: one side's punch to a candidate genuinely succeeded and got a reply (visible in its own punch log), while the other side had already moved on to a newer port by the time that reply arrived, and reported failure. The local port is now discovered once and kept stable for the whole P2P session with that peer, instead of rotating on every retry, so a candidate the other side received can't go stale before they get to use it.
- Fixed a P2P connection that had switched to direct silently getting stuck claiming to still be direct forever after it actually died (reproduced live: "switches to P2P, then drops"). Nothing was watching for the underlying session dying (e.g. the punched-through path's NAT mapping expiring from inactivity) — a send failure was already falling back to the relay for that one message, but the connection state itself stayed stuck on "P2P" forever, which also silently stopped the background reconnect loop (it only runs while not already claiming to be on P2P). A failed send now drops the state back to "relay" so reconnection attempts resume automatically.

### Fixed

- The guided Cloudflare Worker deploy (and the sidebar's new "Connect Cloudflare account" action) always failed immediately with "PTY ID must contain only ASCII letters, digits, '-' or '_'", because the generated PTY session ID contained a `:` character the backend rejects — nothing could ever actually install, log in, or deploy. Also answers a newer Wrangler CLI prompt ("install Cloudflare skills for AI agents?") non-interactively so `wrangler login` no longer hangs waiting for input that never arrives.
- Google sync sign-in now supports an optional OAuth client secret, required by Google's Desktop client type even when using PKCE, stored via the OS keyring and never logged; the sidebar exposes an "Edit" action to reconfigure the Google OAuth client after it was already set up, and diagnostic logging of the token exchange (status, error body) was added to `spawn.log` without ever recording secrets or tokens.
- The Google account card in the collaboration sidebar and in Preferences → Account now reflects the real connected/disconnected state and offers a working "Disconnect" action, instead of always showing a "Connect" button that silently did nothing once already connected.
- Invitation permission presets and active-grant summaries no longer leak raw, untranslated permission tokens (e.g. `read, write`) into otherwise localized text; they are now translated per locale, and the invite form's `<select>` inputs no longer render at an oversized, unstyled font.
- "This Computer"'s device card no longer displays a truncated cryptographic key fingerprint as if it were the device's name; the display name and the fingerprint are now shown as clearly separate, labeled fields, with a colored trust-state badge.
- The "This Computer" device name (e.g. "Dispositivo não registrado") no longer overflows outside its card on long text; it now truncates with an ellipsis like the rest of the device list.
- The Project Collaboration preferences panel now explains what each rendezvous option actually does in plain language, marks the "Alethe service" option as recommended, and adds a note clarifying that enabling collaboration only starts a connection attempt and nothing is sent while it is disabled.
- The "Conexão & Sincronização" sidebar button now actually opens the new collaboration workspace panel in both sidebar visual styles ("Normal" and "Clean"); previously only the "Clean" style's button was wired to the new panel, so most users saw no change when clicking it.
- The Google account "Disconnect" button and the collaboration folder-scope/permission summaries no longer render with a missing gap between icon and label.
- Legacy mesh metadata no longer claims that P2P is enabled, metadata-only checkpoints are documented honestly, and their `sha256` field now contains a real SHA-256 digest instead of a non-cryptographic process-local hash.
- Shared Core route parity is now enforced by a repository contract test; missing Web handlers were added for filesystem rename/delete, CLI discovery, Claude titles, and Remote Control, while Desktop-only data reset operations now fail explicitly instead of calling nonexistent routes and browser Remote Control status no longer returns fabricated data.
- Web startup now has bounded, localized connecting/starting/unavailable/incompatible states and an explicit retry action; an initial Core failure can no longer release an empty workspace as if hydration had succeeded, while reconnect failures still preserve the last valid document.
- `npm run web` now probes and verifies an existing Desktop Core before starting Rust, attaches immediately when the service/API/application/storage identity is compatible, rejects incompatible listeners, and stops only a standalone Core owned by its launcher.
- Repeated terminal resizes now keep the configured font scale unchanged, rebuild the canvas atlas at the acknowledged PTY grid, and wait for OpenTUI's Linux `SIGWINCH` reflow before requesting a full repaint, preventing compressed or single-line OpenCode layouts after consecutive resizes.
- Linux agent panes now keep a stable logical PTY grid for the lifetime of the session and use a horizontal viewport when compressed, eliminating crash-prone `SIGWINCH` and local alternate-screen reflow sequences while preserving the original font scale and any number of adjacent terminal panes.
- Linux/Wayland terminal divider drags now claim the local xterm grid from the drag itself instead of relying on transient document focus, preventing stale wide grids from being clipped inside compressed OpenCode and agent panes.
- Web terminal startup now retries temporary Core/HTTP failures and only shows an agent as not installed after a successful resolver response confirms that the CLI is absent.
- Experimental project synchronization can no longer report a fabricated account, device ID, encrypted channel, immutable backup, or successful browser operation; unavailable identity, invitations, vault, and transfer actions now fail closed and are labeled as prototypes.
- Linux windows and bundles now use high-resolution application icons for task switching, and native notification delivery is awaited with a visible fallback when the desktop service rejects it.
- Terminal and sub-tab dialogs now use one tested creation-state controller and one runtime-profile field, preventing their reset, permission, and runtime behavior from drifting apart.
- Group create/edit dialogs now share one token-based field implementation, while terminal and sub-tab creation share the same tested agent, permission, and launch-argument contract.
- Clean and Normal sidebar variants now share project state derivation and group-tree rendering, including cycle-safe descendant traversal for malformed persisted group data.
- Consolidated native/Web transport APIs, sidebar state/actions/drag behavior, terminal-node rendering, Remote Control polling/mutations, and HTTP route response/query helpers so Desktop, Web, and visual variants share tested behavior instead of maintaining parallel implementations.
- Restored desktop startup by completing the backup-vault purge IPC contract and the Google account preference imports that previously stopped the frontend from mounting.

### Adicionado

- **Optional Cloudflare rendezvous adapter and collaboration settings (Phase 10B):** added an isolated Worker with SQLite Durable Objects, hibernatable authenticated WebSockets, public-device discovery, encrypted bounded mailboxes, presence, acknowledgements, expiry, independent abuse limits, and a provider-neutral Rust client with TLS/protocol validation, Ed25519 challenge authentication, X25519 binding proof, bounded queues, reconnect/backoff, and Desktop/Web route parity. Local smoke coverage proves encrypted-envelope routing between different opaque account routes. Added local-only, managed-service, and custom-provider UI with explicit metadata disclosure; ordinary users never provide Cloudflare credentials, and builds without an injected official endpoint fail closed while local Alethe remains available. Production deployment and cross-PC invitation-domain consumption remain gated.
- **Collaboration access-center foundation (Phase 11):** added a bounded atomic profile-local store for security/collaboration events, categorized settings controls, deduplicated opaque action handles with stale-state revalidation, unread/dismiss/defer behavior, generic localized native notifications, and an in-app fallback that never includes paths, secrets, project/task/chat content, or ciphertext.
- **Device key rotation, account data export, and batch project-access deletion (Phase 12 of project collaboration):** a trusted device can now rotate its Ed25519 identity and X25519 agreement keys together (old key material is overwritten in the OS keyring, never left retrievable alongside the new keys); a redacted, JSON-serializable export of the local account's collaboration state (device fingerprints, invitation summaries, grants — never raw public keys, bearer tokens, or token hashes) is available for a user to review or archive; and revoking every active grant and pending invitation for one project now happens in a single call instead of one at a time, correctly leaving already-redeemed invitations in their historical state rather than retroactively marking them revoked. All three are exposed as Tauri commands and equivalent authenticated Web routes. Key rotation updates local state only — it does not yet notify other devices that cached the old public key, since no live peer-notification channel exists (deferred alongside every other live cross-device wiring gap in this project).
- **Access-center domain publishers and full localization (Phase 11 of project collaboration, now complete):** device approval requests, local invitation redemption, synchronization conflicts, task assignment, chat mentions, and terminal staging-transfer failures now each publish a bounded, privacy-preserving record to the same access-center projection that already received remote rendezvous events. A staging failure is published only when it is genuinely terminal (a missing/corrupt chunk requiring the recipient to re-request the transfer), not for self-healing publish-step interruptions that already recover automatically. Publishing is always best-effort and never blocks or fails the primary operation it accompanies. Added English and Portuguese translations for all six new event kinds, both in the categorized access-center list (already present in Collaboration settings) and in native OS notification text, replacing the previous generic fallback text those kinds would otherwise have shown.
- **Remote invitation delivery bridge with verified device discovery (Phase 10B follow-up of project collaboration):** an already-issued local invitation can now be encrypted for a specific recipient device's X25519 public key and routed through the rendezvous mailbox, and a delivered envelope can be decrypted and redeemed back into a project grant — closing the previously-documented gap where the service could route ciphertext but nothing converted a remote delivery into an accepted grant. A discovered device's advertised key is now cryptographically verified (Ed25519 signature binding) before it is ever used to encrypt anything, so a compromised or malicious rendezvous service can never substitute its own key for a real device's key. Added a reusable single-shot sealed-envelope encryption primitive (ECIES-style: ephemeral X25519 key agreement, HKDF-SHA256, ChaCha20Poly1305) and a device agreement-key reader from the OS keyring. The bearer token is included only inside the encrypted payload, never in any unencrypted field. Exposed as Tauri commands and equivalent authenticated Web routes, plus TypeScript wrappers; still pending: the UI flow that calls discovery and lets a user pick a recipient device, and real two-machine staging evidence.
- **Optional collaboration service activation and provider configuration (Phase 10A of project collaboration):** added a local-only-by-default settings model with three modes — local only, the operator-managed Alethe endpoint, and an advanced custom endpoint. The settings now have a real TLS/protocol validator and user-facing configuration; only non-secret preferences persist, and connection state comes from the live provider runtime rather than configuration alone.
- **Programmer-focused chat with per-epoch encrypted groups (Phase 9 of project collaboration):** added direct conversations, project channels, and private groups with end-to-end encrypted messages. Each conversation has a monotonically increasing epoch, each epoch has an independently random symmetric key wrapped separately for every current member via X25519 key agreement (`ADR-0006`); adding or removing a member always rotates the epoch, and a removed member receives no key wrap for any epoch created afterward, so there is nothing for them to decrypt — proven directly by test, not merely assumed. Messages support text, code blocks, test results, bug reports, and a "command" type that is stored and transmitted but never auto-executed by any code path in this module. Added editing, tombstone deletion, reactions, per-member read cursors, and idempotent duplicate-delivery handling for retried/offline message sends. Attachments use their own independently generated and wrapped key, never derived from a conversation's message key. Exposed as Tauri commands and equivalent authenticated Web routes for conversation/membership/message-listing/reaction/read-cursor operations; message send/edit/delete and attachment upload remain Core-only this phase, since exposing them as commands would require either transmitting raw key material over IPC or wiring live OS-keyring key retrieval into the command surface — deferred alongside all other live cross-device wiring. No new UI yet.
- **Shared collaboration tasks (Phase 8 of project collaboration):** added a project-scoped task domain, deliberately kept entirely separate from the local agent-work scheduler (distinct `ctask_`-prefixed IDs and persistence). Tasks support public and explicitly restricted visibility; a restricted task's existence never leaks to a non-member — it is simply absent from listings, and looking it up directly by ID returns the identical "not found" result as a genuinely nonexistent ID. Every read and mutation rechecks device trust fresh, not a cached value. Operations (create/update/assign/complete/reopen/comment/delete/restore) use an expected base revision; a stale one is rejected as a deterministic conflict rather than silently overwritten, so concurrent offline edits never produce silent data loss. Tasks synchronize independently from project-file transfer and continuous sync — a paused file transfer cannot corrupt or block task state. Exposed as Tauri commands and equivalent authenticated Web routes; no new UI yet, since nothing wires a real remote collaborator's task changes into this module.
- **Continuous synchronization and conflict handling (Phase 7 of project collaboration):** added a revisioned operation model (create/update/rename/delete/metadata) with per-path revisions used to detect divergence between local and remote history, instead of relying on modification timestamps. When a remote change's assumed parent revision no longer matches local state, an explicit conflict record is created — preserving both sides — instead of silently overwriting either one; conflicts resolve to keep-local, keep-remote, or keep-both (which preserves the remote content under a renamed sibling file). Every operation rechecks device trust fresh against the current security state immediately before applying, so a revoked device is rejected on its very next attempt. Added filesystem-watcher event coalescing with bounded-overflow detection, pause/resume controls, a rescan flag, and single-generation rollback reusing Phase 6's retained backup. Exposed as Tauri commands and equivalent authenticated Web routes; no new UI, live filesystem watcher, or live peer wiring yet.
- **Manifests, chunking, staging, and atomic publication (Phase 6 of project collaboration):** added a deterministic, signed project manifest format with a default-deny exclusion policy (secrets, `.git`, dependency/build directories excluded by default) and bounded, content-addressed file chunking (streaming SHA-256, constant memory regardless of file size). Added a durable staging journal that verifies every chunk's hash before writing it, reassembles and re-verifies each file's complete hash before it is ever considered part of the transfer, and publishes atomically via a crash-recoverable two-step directory swap that always retains exactly one recoverable prior version. Corrupt, substituted, missing, or oversized chunks are rejected before anything reaches the live destination. Exposed as Tauri commands and equivalent authenticated Web routes; no new UI or live transfer wiring yet — this phase proves the mechanism against local test fixtures, since nothing yet connects a real remote sender to it.
- **Recipient-controlled project subscription (Phase 5 of project collaboration):** added a versioned per-device subscription record and full state machine (`offered → configuring → awaiting_confirmation → staging → verifying → active`, plus `deferred`/`declined`/`paused`/`revoked`/`error`/`removing`) so accepting a project grant never implies downloading anything. The recipient must explicitly choose and confirm a destination and a synchronization mode before any filesystem write happens; destination validation rejects path traversal, symlink escapes, collisions with another subscription, and an existing non-empty directory. The only filesystem write in this phase is creating an empty destination folder after explicit confirmation — no project content is transferred, because that begins in a later phase. Exposed as Tauri commands and equivalent authenticated Web routes on the same core implementation; no new UI is added yet, since there is nothing real for a confirmation screen to show until project transfer exists.
- **Encrypted provider-independent peer transport (Phase 4 of project collaboration):** two devices that already trust each other (Phase 1) and hold a signed key-agreement binding (Phase 3/`ADR-0003`) can now establish an authenticated, end-to-end encrypted session over TCP — loopback, a manually supplied address, or an opt-in LAN candidate (`ADR-0005`). The handshake performs mutual Ed25519 challenge-response authentication before deriving forward-secret session keys; every encrypted frame is bound to protocol version, session, stream, sender/recipient device, and project/grant context, with strict replay/reorder rejection, an oversize ceiling enforced before allocation, and application-level backpressure. Revoking a session blocks new streams; a safe, non-secret resume ticket lets a caller validate reconnection continuity. No Cloudflare or other rendezvous/relay provider is used anywhere in this phase — every test runs against real TCP loopback sockets only. This is a Core transport module with no product-facing surface yet; no new UI or command is added.
- **Security readiness gate and provider-independent protocol (Phase 3 of project collaboration):** Google sign-in now verifies the cryptographically signed ID token (issuer, audience, expiry, nonce, issued-at skew, email verification) against Google's published keys, instead of trusting the UserInfo endpoint alone. Every device now also generates a separate X25519 key-agreement keypair signed by its existing device identity (`ADR-0003`), ready for encrypted peer sessions in a later phase. Added a canonical signed control-envelope format with strict size limits, replay protection, and cross-language (Rust/TypeScript) test vectors, plus a deterministic, privacy-preserving account-routing identifier that never transmits any Google credential (`ADR-0004`). Added a real backend capability resolver, exposed via Tauri and an authenticated Web route, replacing implicit frontend assumptions about what collaboration features are actually available. No new user-facing surface is exposed by this phase; it is a security/protocol foundation for the phases that follow.
- **Project collaboration implementation blueprint:** documented the intended Core modules, state machines, persistence, failure behavior, test evidence, and delivery gates for Phases 3–13. The main status document now records the owner-confirmed operating model for ordinary users, optional capability activation, one control WebSocket per enabled device, P2P data flow, direct-first reconnection, invitation delivery, quota expectations, and provider outage/migration behavior. Cloudflare Workers with SQLite-backed Durable Objects remains the optional reference control-plane adapter, deliberately deferred to Phase 10; ordinary users do not own or configure Cloudflare accounts.
- **Invitation and grant lifecycle (Phase 2 of project collaboration):** added backend operations to issue, revoke, and redeem project invitations and to revoke active grants, exposed as Tauri commands and equivalent authenticated Web routes on the same core implementation. Invitations are represented as an `alethe-invite://` link shown once at issuance. The synchronization sidebar now has a working (local-only) invite flow with permission presets, expanded permission display, stronger confirmation for sensitive permissions (write/delete/invite/admin), an outgoing-invitations and active-grants list with revoke actions, and a redeem field. Cross-device delivery of invitations is not implemented yet — today issuing and redeeming both operate on the same local device's security document.
- **Device trust lifecycle (Phase 1 of project collaboration):** the first device registered for an account is now trusted automatically, while every additional device starts `Pending` and requires explicit approval from an already-trusted device. Added backend approve/reject/rename/revoke/remove operations (Tauri commands and equivalent authenticated Web routes on the same core implementation), with revocation invalidating the device's outstanding grants and pending invitations. The synchronization sidebar now shows the local device with a rename control and lists other known devices with approve/reject/revoke/remove actions.
- Google identity now uses the system browser and a random loopback callback with Authorization Code + PKCE S256, strict callback state validation, backend-only token exchange and UserInfo verification, credential-store token persistence, and automatic device-key registration. The flow remains visibly unconfigured until `ALETHE_GOOGLE_CLIENT_ID` is supplied.
- **Project sync security contracts:** Added the threat model, transport/authentication architecture decision, typed identity/device/invitation/grant contracts, explicit permission implications, recipient-controlled transfer consent, and a fail-closed capability parser for the future Desktop/Web synchronization protocol.
- **Árvore Interativa de Pastas com Filtros Checkbox & Presets (`ProjectFolderTreeModal.tsx`, `ProjectFolderTreeModal.module.css`)**: Modal dedicado para escaneamento de diretórios do projeto com seleção cirúrgica de pastas para sincronização P2P, pré-desmarcando pastas pesadas (`node_modules`, `target`, `dist`, `.env`) e exibindo avisos de isolamento de diretório raiz.
- **Motor de Sincronização e Isolamento Anti-Corrupção em Rust (`sync_mesh.rs`)**: Implementada a inicialização segura do projeto com encapsulamento obrigatório em subpasta (`[path]/[project_name]/`), criação da pasta `.alethe/` com o atributo `FILE_ATTRIBUTE_HIDDEN` aplicado nativamente no Windows Explorer, e cofre de backups periódicos definitivos (WORM) com bloqueio de exclusão protegido por digitação de confirmação.
- **5º Botão Oficial de Conexão & Malha P2P na Barra Lateral Esquerda (`ProjectSidebar/MeshSidebarView.tsx`, `NormalProjectSidebar.tsx`, `index.tsx`)**: Adicionada a 5ª aba oficial com ícone `Globe` na barra superior esquerda, integrando o painel de gerenciamento de dispositivos P2P, visualização de Device ID, autenticação realista (Modo Local/Opcional), sincronização de projetos e cofre de segurança imutável.
- **Visibilidade contextual da Central de Merges (`ProjectSidebar/index.tsx`)**: O painel `SidebarMergePanel` agora é exibido estritamente na aba Projetos da barra lateral (`sidebarTab === 'projects'`), ficando oculto em abas como Arquivos e Git.
- **Blindagem Contra Corrupção de Terminal e Parser ANSI (`terminalWrite.ts`, `useXtermSession.ts`)**: Implementada a função `findSafeChunkBoundary` para evitar a divisão de sequências de escape ANSI (`CSI`, `OSC`, `DCS`, `ST`) e pares substitutos UTF-16 durante a drenagem fracionada do frame budget (`16KB`). Adicionado teto de segurança (`MAX_PENDING_WRITE_BYTES = 2MB`) com ressincronização automática para prevenir estouro do buffer do xterm.js quando janelas permanecem inativas ou em background por longos períodos.
- **Visualizador Rico de Alterações com Métricas de Linhas (+X / -Y) e Auto-Execução de App (`BranchTestingModal.tsx`, `SidebarMergePanel.tsx`, `git_control.rs`)**: O modal de testes de branch agora computa e exibe a contagem exata de linhas adicionadas em verde (`+X`) e linhas removidas em vermelho (`-Y`) por arquivo via `git diff --numstat`. O botão "Iniciar App nesta Branch" detecta a stack (Node, Go, Rust, Python) e sobe o app real.
- **Proteção contra Limpezas Abruptas de RAM e MemReduct (`useXtermSession.ts`)**: Adicionado listener de recuperação determinística (`alethe:memory-pressure-recover`) que limpa e recria o texture atlas do canvas do xterm.js quando utilitários externos ou o SO realizam purgas de memória, prevenindo corrupção visual e caracteres perdidos na tela.
- **Ferramentas Avançadas de Planejamento com Diagramas Mermaid e Edição Cirúrgica (`planning.rs`, `server_main/misc_routes.rs`)**: Implementadas as APIs `patch_project_plan` (substituição precisa de trechos e linhas sem reescrever o arquivo) e `append_plan_diagram` (injeção de fluxogramas e diagramas de arquitetura Mermaid).
- **Integração de Planos do Projeto na Aba de Markdown (`RightSidebar/index.tsx`, `planning.rs`, `server_main/misc_routes.rs`)**: Os planos salvos em `.alethe/plans/` agora são listados e integrados diretamente na aba existente de Markdown (`FileText`), permitindo alternar entre abas de arquivos e planos do projeto sem poluir a barra de ferramentas.
- **Resiliência e Recuperação de Pânico no Alethe Server (`server_main/mod.rs`)**: Adicionado `CatchPanicLayer` customizado no roteador Axum do `alethe-server` para interceptar panics internos, registrá-los e retornar respostas HTTP 500 estruturadas sem derrubar o servidor ou travar o processo principal.
- **Suporte e formatação limpa de imagens coladas em terminais (`XTermView/useXtermSession.ts`)**: Ao colar imagens nos terminais (Antigravity CLI, Claude Code, Codex, etc.), o arquivo temporário real é salvo em background e o input é formatado de forma limpa como `[image 1]`, `[image 2]`, preservando o fluxo nativo do OpenCode.
- **Paridade Web para leitura e escrita de arquivos Markdown (`lib/tauri/filesystem.ts`)**: Funções de leitura/escrita de arquivos agora contam com fallback transparente via `webApiFetch` (`/api/fs/*`) quando executadas no modo Web.
- **Comprehensive App Testing Skill (`testing-app`) in `.agents/skills/` and `.claude/skills/`**: Cross-runtime skill providing end-to-end guidance for testing the entire Alethe application across all layers: TypeScript/i18n contract validation (`npm run build`), frontend unit/store tests (`npm test` via Vitest), backend Rust unit and contract tests (`npm run test:rust`), WebdriverIO desktop UI E2E automation (`npm run test:e2e`), and sync server multi-client verification (`npm run test:e2e:sync`). Includes golden rules for E2E isolation, native dialog gotchas, and test tooling references (`uiKit`, `projectUi`, `procedures`).
- **Central de Merges e Suíte de Validação E2E com Agentes Reais (`MergeCenterModal`, `e2e/specs/git-pipeline.spec.ts`, `e2e/specs/web-sync.spec.ts`)**: Pipeline completo de validação e integração Git com isolamento em worktrees, resolução assistida de conflitos determinísticos, continuidade contextual sem repetição de prompt com OpenCode real, e sincronização bidirecional de redimensionamento e buffers de terminal entre o cliente Desktop (Tauri) e o Core HTTP (`alethe-server`).
- **Shared local terminal authority:** Active PTYs now use one process registry and a fan-out sink for Desktop events and authenticated browser WebSockets, so both clients attach to the same terminal instead of creating disconnected copies.
- **Navegador Universal de Arquivos e Pastas (`FsBrowserModal`)**: Modal responsivo no design system do Alethe, navegação por drives/unidades (`C:\`, `D:\`, `/`), busca animada em tempo real com revelação em cascata (staggered cascade reveal), destaque neon nos termos buscados e atalhos por teclado (`↑`, `↓`, `Enter`, `Backspace`).
- **Canonical data-root identity:** Desktop and standalone modes resolve one explicit platform data root from the app identifier, with optional absolute overrides through `ALETHE_APP_DATA_DIR`; project-relative configuration and folder-existence guessing are no longer used.
- **Single Alethe Core endpoint:** The embedded Desktop server and `alethe-server` use the same loopback endpoint, runtime identity handshake, profile/project repositories, and PTY registry contract.
- **Cross-platform storage and PTY core:** Platform data directories and portable PTYs remain independent of the Linux compositor, preserving the same storage contract on Windows, macOS, Linux X11, and Linux Wayland.
- **Reactive profile synchronization:** Browser and Desktop clients now share one authenticated event stream for profile catalog, active-profile, and project-revision updates, including changes that keep the same active profile ID.

- **Sincronização instantânea e sem saltos de redimensionamento entre Desktop e Web (`useXtermSession.ts`)**: Corrigido o descompasso onde ajustar o tamanho do terminal fazia o conteúdo saltar para cima ou deixar espaços pretos vazios. Eliminado o `terminal.clear()` em commits de resize que apagava o buffer do ConPTY, reduzida a latência de debounce para 50ms para acomodação imediata, blindada a sincronização de layout para que janelas em segundo plano não roubem a titularidade da grade, e adicionada reancoragem automática de foco para que a janela ativa ocupe 100% da largura e altura do painel.
- **Correção do travamento de reinicialização de terminais (`TerminalPane/index.tsx`, `useXtermSession.ts`, `agentPtyRestart.ts`)**: Corrigido o problema onde clicar em "Reiniciar" mantinha o overlay "Processo encerrado" congelado na tela tanto no Desktop quanto no Web. O painel agora força o remount limpo do terminal via `resumeNonce`, preserva a resolução de colunas/linhas reais em vez de forçar 80x24, e trata eventos de exit com motivo `restarted` disparando reconexão e reset de buffer sem marcar o processo como finalizado por engano.
- Profile and project persistence now uses an explicit profile namespace, a transactional bootstrap, atomic writes, and backend revisions so the Web and Desktop clients cannot silently redirect or overwrite each other's data during a profile switch.
- Unsaved terminal and workspace changes are flushed before profile operations and page suspension, while rejected concurrent writes are preserved as recovery copies instead of being discarded.
- Browser terminal streams now reconnect with bounded backoff and rebuild from an atomic scrollback cursor after a disconnect or broadcast gap, avoiding duplicated or missing output during reloads.
- Every PTY operation now carries an explicit profile owner across HTTP, WebSocket, and Tauri IPC, preventing a reused terminal ID or delayed request from crossing profile boundaries.
- Standalone-core shutdown now drains registered PTYs on Ctrl+C and Unix SIGTERM, with Unix process-group termination complementing the existing Windows kill-on-close guard.
- Legacy root-level data is backed up before profile migration and cleaned up only after the typed registry commits, preserving a recovery copy when an existing profile contains conflicting files.
- The local core now binds to loopback only, validates Host and Origin headers, and rotates the ephemeral bearer or WebSocket subprotocol session used by privileged routes after identity revalidation.
- The Tauri client no longer silently splits write authority between HTTP and IPC: once the shared core is confirmed reachable, a later transient probe failure surfaces as a retryable error instead of quietly rerouting requests back to IPC.
- The profile/project sync stream now self-heals instead of going silently stale: a failed re-sync no longer wipes an already-loaded document to empty, an invalid initial snapshot closes the connection with a retryable code, and the stream resends a full authoritative snapshot on every keepalive tick in addition to the existing gap recovery.
- The sync event stream now discards duplicate or out-of-order events per connection and re-baselines correctly on reconnect (including after the core restarts), and concurrent publishes on the core can no longer broadcast out of sequence order.
- `npm run web`'s Vite dev server now fails to start instead of silently picking a port outside the core's Host/Origin allowlist.
- Legacy pre-multi-profile data left at the data root now migrates even when a profile registry already exists (e.g. from an older Web backend that never ran migration); a real conflict with existing profile data keeps both copies on disk instead of deleting the original.
- A retried project save with an unchanged payload no longer returns a false revision conflict when an external todo sidecar is present, by comparing canonicalized document content instead of raw byte/key order.
- Memory-pressure notifications no longer repeat every few seconds while usage hovers near a threshold under real process churn — a level change now needs to hold for a short dwell period before it's surfaced, and a duplicate toast within a few seconds is dropped as a defensive backstop.
- Resizing a terminal from one client (Desktop or the browser) now resizes the same PTY's view on every other attached client too, instead of only the initiating client — a cross-client resize used to leave the other side rendering a redrawn TUI into a stale-sized buffer, corrupting multi-pane agent views (e.g. OpenCode next to another agent). The OpenCode-only forced-redraw workaround is now a per-provider capability flag instead of a hardcoded check, so it can be enabled for other agent CLIs without another round of changes if they turn out to need it.
- A terminal opened on both Desktop and the browser at the same time no longer renders at the wrong scale on one of them — squeezed into a narrow column with wrapped text, or tiny with a large empty area around it. The two clients now share one character grid and each adapts its own font size to fit that grid in its own panel, so both show the same layout proportionally scaled to their window, in either direction. The client that attaches to an already-running session adopts the existing grid instead of fighting for it, and reclaims it as soon as its own window or panel is actually resized. Sizing is measured live from the real panel, so it works at any resolution, aspect ratio, or zoom/DPI level.
- The divider between terminal panels is now shared between Desktop and the browser, and survives a reload — it used to be independent per client and reset every time. The position is stored as a proportion rather than pixels so it makes sense across differently sized windows, and it syncs when the divider is released rather than during the drag.
- The right sidebar ("Tarefas") panel now tracks a drag of the divider between it and the terminal area in real time — a broken CSS selector meant the panel's width was always animated/lagging instead of following the pointer.
- Claude/Codex/Antigravity usage pills in the title bar now appear in the Web client too, matching Desktop — they were silently failing because the cache layer still called the Tauri-only IPC path instead of the existing HTTP fallback.
- Claude/Codex/Antigravity usage pills in the title bar's Web client no longer stay permanently blank when the browser window doesn't hold OS-level focus at load time — the polling loop that pauses in the background only listened for tab visibility changes, not window focus/blur, so a browser window sitting behind the Desktop window never sent a single usage request.
- The RAM pill in the Web client no longer gets stuck showing "0 MB" (and a false "critical"/red state) for the rest of the session after a single transient network hiccup — the memory-telemetry fallback used for an old Desktop backend instance surviving hot-reload was also being applied on Web, where it's a zeroed stub instead of a real fallback; Web now keeps retrying the real memory snapshot instead of latching onto the stub.
- **Correção da renderização e travamentos de tela nos terminais PTY (`useXtermSession.ts`)**: Reordenado o carregamento do `CanvasAddon` para antes da montagem do `terminal.open(container)` com auto-recuperação de dimensões de viewport via `requestAnimationFrame`, eliminando textos distorcidos ("d u f fi . s f CLI") e telas pretas no OpenCode, Antigravity e Claude.
- **Isolamento de medição de memória por instância**: Corrigida a dupla contagem de memória RAM quando o App Desktop e o Servidor Web rodavam em paralelo, restaurando a medição exata do workspace (~1.8 GB - 2.6 GB) sem inflar a leitura global.
- **Fallback para diálogos de arquivos no modo Web (`dialog.ts`)**: Adicionada verificação `isTauriEnv()` para evitar exceções `TypeError: Cannot read properties of undefined (reading 'invoke')` ao clicar em "Configure path..." no navegador.
- The Merge Center's validation gate no longer reports success when a project has no validation commands configured — it used to run zero commands and still claim "all validations passed," which fed both the green "ready" badge on merge cards and the automatic merge of conflict-free branches. It now surfaces an honest "not verified" state (amber badge, distinct toast) instead of silently pretending a check happened; a project with real, failing validation commands still blocks the merge exactly as before.
- Editing a project now suggests validation commands automatically (build/test commands detected from the project's stack) when none are configured yet, instead of leaving the field permanently empty — a manually typed value is never overwritten.
- The Merge Center can now actually boot a project and confirm it works before Test/Merge, via an optional health check command in the project's Multi-Agent & MCP settings — it starts the app in an isolated environment, polls a real HTTP endpoint, and (for Alethe-like projects specifically) opens a real terminal and confirms a write/read round-trip actually works, not just that a process exists a moment after spawning. Shown as its own "Server Health" section in the Test Briefing, and as a toast after an automatic merge. This is a warning layer — it never blocks a merge by itself.
- The "Analyze" step in the project's Merge tab no longer implies the merge is good to go when it says "no conflicts" — that step only checks for git-level merge conflicts, not whether the code actually works, and the wording now says so explicitly (validation and the health check, if configured, still run when you actually click Merge).

### Testes (novo)

- The Mesh sidebar now renders the real sanitized security snapshot for account, device trust, pending invitations, and active grants across Desktop and Web while keeping unfinished login, invitation, and transfer actions disabled.
- Desktop and Web now share one authenticated read-only sync-security snapshot route; invitation bearer hashes and throttling internals are deliberately omitted from the public response.
- The backend security vault now owns invitation issuance and redemption: 256-bit bearer secrets are persisted only as SHA-256 hashes, grants are bound to an exact project/account/device, repeated failures are throttled with generic responses, and redemption is atomic and single-use.
- The Rust sync-security vault now persists only versioned account/device metadata through an fsynced atomic replacement, generates per-device Ed25519 keys, stores private key bytes exclusively in the operating-system credential store, and records bounded content-free audit events.
- Project authorization now has executable deny-by-default decisions for project/account/device identity, expiry, revocation, explicit operations, path traversal, and deny-first path scopes, plus hashed single-use invitation tokens and tested replay/audience enforcement.
- Identity groundwork now includes short-lived Google OAuth PKCE attempts with loopback-only callbacks, strict state/route/expiry/replay validation, and terminal device-revocation state transitions.
- Web startup now records content-free browser performance marks for bundle evaluation, bootstrap request, verified Core identity, and usable UI, with executable budgets for warm attach and compiled standalone startup.
- The shared-Core E2E now drives a real Tauri Desktop client and a separate headless Firefox Web client concurrently, creates projects through real UI actions in both directions, and verifies that stable project identities converge without action hooks.
- Nova suíte e2e `test:e2e:git-pipeline` que exercita o pipeline de git da Central de Merges de ponta a ponta contra um projeto-fixture criado do zero a cada execução (sem `.git`): detecção de "não é repo", `git init`, provisionamento de worktree, um agente OpenCode real mantendo contexto entre dois prompts (1 terminal e depois 2 simultâneos), um conflito de merge determinístico, resolução + integração, e uma verificação **independente** (via `git log`/`git show` crus, fora de qualquer API do Alethe) de que o commit realmente chegou na branch alvo — em vez de confiar no que a UI relata. Também confirma que um terminal novo sobe limpo depois da integração.
- Nova suíte e2e `test:e2e:sync` que sobe o app desktop e o `alethe-server` compartilhando o mesmo data root e confirma que os dois clientes convergem pro mesmo grid de terminal (`cols`/`rows`) depois de um resize disparado de qualquer um dos lados — cobre como regressão explícita a classe de bug de reajuste de terminal desktop↔web mais reportada.

- **Codex App Server (`codex_app_server`) com WebSockets no Alethe Web**: Criada a abstração `CodexAppServerSink` desacoplando o processo `codex app-server --stdio` do runtime do Tauri, e adicionadas as rotas REST/WebSocket `/api/codex_app_server/*` no `alethe-server` para execução e streaming bidirecional de mensagens no navegador.
- **Suporte ao Controle Remoto LAN (`/api/remote/set_enabled`) no Alethe Web**: Refatoradas as funções do módulo `remote.rs` para desacoplar a leitura do `projects.json` da `AppHandle`, liberando a ativação e sincronização do servidor de controle remoto LAN diretamente do `alethe-server`.
- **Generic PTY sink and WebSocket transport:** `PtyOutputSink` now publishes the same terminal lifecycle to native events and authenticated WebSocket subscribers.
- **Local Alethe Web mode (`npm run web`):** The browser client uses REST and WebSockets through the loopback Alethe Core. LAN access remains a separate, explicit Remote Control capability instead of exposing the full local API.
- **Roteamento Multi-Páginas Web**: Suporte a URLs reais navegáveis no browser (`/workspace`, `/agents`, `/git`, `/sessions`, `/settings`) via HTML5 History API, permitindo deep-linking, navegação por botão Voltar/Avançar e abertura de múltiplas abas independentes no navegador.
- **Sistema de Logs Estruturado**: Logging centralizado no frontend (`src/lib/logger.ts`) e no backend Rust (`alethe-server`), capturando eventos de transporte REST/WS, spawn de PTY e exceções com visualização em tempo real.
- **Axum route coverage now uses real shared core operations:** Unsupported calls return an explicit `501` instead of a generic success response, while profiles, projects, PTYs, Codex App Server, Git/worktrees, sessions, backup, GitHub Sync, Remote Control, filesystem, usage, and diagnostics use concrete handlers.
- **Colar conteúdo do portapapeles via clique direito no terminal (`XTermView`).** Clicar com o botão direito sobre o painel do terminal sem texto selecionado cola o conteúdo do portapapeles (texto, imagens e arquivos). Caso haja texto selecionado no terminal, o clique direito copia a seleção para o portapapeles e limpa o destaque.
- **A aba "Controle de versão" agora existe de verdade na Sidebar direita, sempre, ao lado de Todo/Markdown/GSD Sync** — antes ela só aparecia ali como uma troca de lugar com a Sidebar esquerda (decidida pela preferência de posição do Git), então na prática nunca aparecia na direita pra maioria dos usuários. Agora aparece sempre que o recurso de Git estiver ligado, independente de onde o painel também estiver configurado pra aparecer.
- **Gráfico de commits no painel de Controle de Versão**, estilo VSCode (Source Control Graph): nós e linhas mostrando o histórico real de commits/branches — raias coloridas, bifurcações de merge visíveis (curvas, não mais linhas retas), autor e tempo relativo em cada linha, badges de branch/tag quando aplicável, e a largura das raias calculada por linha (não mais um espaço global fixo, que deixava sobrando bastante espaço vazio em linhas simples). Aparece logo abaixo da lista de alterações, nos dois lugares onde o painel existe (Sidebar esquerda e direita).
- **Ações por commit no gráfico**: clique num commit expande a lista de arquivos alterados nele; botão direito abre um menu de contexto com copiar hash, criar branch a partir do commit, cherry-pick, revert e reset (soft/mixed/hard — o hard pede confirmação, por ser destrutivo).
- **Grupo "Alterações a receber / enviar" (Incoming/Outgoing)** no painel de Controle de Versão: mostra, separadamente, quais arquivos um `pull` traria e quais um `push` enviaria, quando a branch está adiantada/atrasada em relação ao upstream.

### Alterado

- Google login can now be configured from the synchronization sidebar without editing environment files or restarting the application; only validated public desktop client IDs are persisted.
- The Google account control in Preferences now uses the same configuration and OAuth flow as the synchronization sidebar instead of remaining permanently disabled.

- Added a live Remote Control device counter to the topbar, with direct access to the connection panel.
- **A borda arco-íris agora é o indicador de foco de qualquer container da workspace, não só um efeito de cor de projeto.** Antes, só containers com a cor "arco-íris" escolhida no projeto mostravam o anel animado, sempre visível independente de foco. Agora qualquer container mostra a borda arco-íris enquanto estiver em foco (um terminal dele com o cursor/digitação ativa); sem foco, volta à borda normal por cor de projeto.
- **Editar Projeto virou uma central de configurações com navegação vertical** (mesmo estilo da Central de Preferências), no lugar das abas horizontais antigas — Foco/Agentes/Worktrees/Merge agora são categorias numa barra lateral. O item de menu que abre esse modal foi renomeado de "Editar (nome e cor)…" pra "Configurações…", já que agora cobre bem mais que nome e cor.
- **A seção "GSD Sync" (barra Tarefas) ganhou aba própria**, separada do Todo — antes ficava misturada no topo da lista de tarefas.

### Adicionado

- **Nova opção "Criar nova branch e manter sessão" na Central de Merges**, junto da já existente "manter chat ativo" — a diferença agora também é explicada na própria tela. "Manter chat" reabre o painel do agente na worktree nova com uma conversa zerada; "manter sessão" tenta retomar de verdade a MESMA conversa lá (sujeito às mesmas ressalvas de segurança já existentes pra retomada entre pastas — nem todo agente/CLI suporta, cai numa conversa nova sem travar quando não suporta).
- **Exportar/Importar configuração de projeto**: novos itens no menu do projeto (⋯) pra salvar a configuração completa (agentes, cor, worktree, GSD, terminais) num arquivo `.json` e trazer de volta como um projeto novo — útil pra backup pontual de um projeto só ou pra levar a configuração pra outra máquina.
- **Espelho automático `.alethe/project.json`**: o Alethe agora mantém, dentro da própria pasta de cada projeto, uma cópia sempre atualizada da configuração dele. Ao criar um projeto novo apontando pra uma pasta que já tem esse arquivo (reaberta depois de removida do app, ou copiada de outra máquina), o formulário detecta e oferece restaurar a configuração em vez de começar do zero.

### Corrigido

- **Terminal ficava com texto visualmente corrompido (letras/palavras faltando na tela) depois do app ficar minimizado por muito tempo — e "Reiniciar" o terminal não resolvia.** Confirmado ao vivo pelo dono com print real. Três causas reais, cada uma contribuindo pro sintoma:
  1. **Causa principal (explica por que "Reiniciar" não resolvia)**: o atlas de glifos do renderer Canvas (`CanvasAddon`) é compartilhado a nível de módulo entre painéis e nunca era limpo — quando o WebView2 descarta o backing store do canvas de páginas ocultas (minimizada por muito tempo), o cache interno do addon continua achando que os glifos estão lá, desenhando lixo/vazio. Como "Reiniciar" só reconecta a PTY sem recriar a instância do terminal, a corrupção sobrevivia ao restart. Corrigido chamando `clearTextureAtlas()` sempre que a janela volta a ficar visível.
  2. O replay do scrollback (usado tanto ao reconectar quanto ao reiniciar) cortava o conteúdo só por contagem de bytes alinhados a UTF-8, nunca por fronteira de sequência ANSI — pra uma TUI em alternate-buffer (ex. OpenCode, que só reescreve células alteradas), começar o replay "do meio" de um repaint parcial produzia exatamente letras soltas e palavras cortadas. Corrigido buscando pra trás, numa janela limitada, a última sequência de reset visual completo (`\x1b[2J`, `\x1b[3J`, `\x1b[?1049h`, RIS) e cortando logo depois dela.
  3. Enquanto minimizado, a fila de escrita do terminal crescia sem teto (o `requestAnimationFrame` que a esvazia não roda com a janela oculta) — se estourasse o limite interno do próprio xterm.js, a escrita falhava e o erro era engolido silenciosamente, descartando até 16KiB no meio do stream pra sempre e desalinhando o parser dali em diante. Corrigido: em vez de engolir o erro, descarta o backlog acumulado (não dá pra confiar no alinhamento dele) e dispara uma ressincronização real, visível no log.
- **"Integrar" na Central de Merges podia dizer "Merge concluído" sem integrar nada de verdade — `main` nunca avançava, e a ação pós-merge configurada era ignorada.** Confirmado ao vivo com um agente OpenCode real: quando a branch do agente não tinha nenhuma mudança em relação ao alvo (nada foi commitado), o backend (`merge_finalize_inner`) seguia até o fim do pipeline e devolvia `merged: true` mesmo assim — `git merge --ff-only` respondia "Already up to date" (sucesso, sem mover nada) e nada detectava essa diferença. A UI mostrava o toast de sucesso normalmente. Corrigido comparando o commit da branch efêmera de merge com o commit atual do alvo antes de integrar: se forem idênticos, a integração para com um resultado honesto ("Nada para integrar") em vez de fingir sucesso. Também corrigido, no mesmo fluxo: a opção "Ação pós-merge do agente" ("Criar nova branch e manter chat ativo"/"...manter sessão") existia pronta e testada mas nunca era chamada — depois de um merge bem-sucedido o terminal do agente sempre era simplesmente fechado, ignorando a configuração; e uma falha ao remover a worktree do agente após integrar virava só um aviso no console, sem nenhum sinal pro usuário, deixando pastas presas em disco sem explicação.
- **Botão "Inicializar repositório Git" (painel Controle de Versão da sidebar) ficava completamente ilegível — texto branco sobre fundo branco/cinza-claro em vários temas.** `GitControl.tsx` fixava a cor do texto em `#fff` direto no código, em vez de usar o token de tema correto — `--accent` (a cor de fundo desse botão) é literalmente branco/quase-branco em pelo menos 4 temas (`#f3f4f6`, `#fafafa`, `#e8e8e8`, além de `#ffff50` num quinto, onde branco também fica com contraste ruim). Confirmado ao vivo pelo dono, testando manualmente. Corrigido usando `var(--accent-on)` — o mesmo token que todo outro botão "primário" do app já usa corretamente (`.btnPrimary` em `controls.module.css`) — em vez da cor fixa.
- **Opções de menus dropdown (ex. "Local do Controle Git" em Preferências → Aparência) eram completamente impossíveis de clicar — mesmo, confirmado ao vivo pelo dono, tentando manualmente.** O menu (`Dropdown.tsx`, `position: fixed`, portal próprio em `document.body`, fora da árvore do `Dialog.Content`) aparecia visualmente correto na tela, mas todo clique nele passava direto pro elemento por trás (ex. o título da seção seguinte), sem erro nenhum visível. Causa raiz confirmada via `getComputedStyle` em runtime: o menu herdava `pointer-events: none` do `<body>` — o Radix Dialog trava interação de fundo enquanto um modal está aberto e libera a exceção (`pointer-events: auto`) só pro próprio `Dialog.Content`; como esse menu é um portal separado, nunca recebia essa liberação. Corrigido declarando `pointer-events: auto` explicitamente no menu. (Aproveitado também: a posição do menu agora usa `window.visualViewport` em vez de `window.innerWidth`/`innerHeight`, mais robusto a zoom/DPI — não era a causa deste bug específico, mas é a medida tecnicamente correta.)
- **Card do agente sumia da Central de Merges enquanto uma sessão de "Revisar" ou "Testar" estava aberta.** Os dois botões criam um terminal utilitário descartável apontando pra mesma pasta da worktree do agente — mas, sem nenhum marcador (`worktreeAgentId`/`gsdSyncViewer`), esse terminal passava despercebido pela heurística que decide qual terminal representa "a raiz pura do repositório" (`getProjectRepoRoot`), que o escolhia por engano como referência. Isso contaminava o cálculo com o caminho da própria worktree em vez da raiz real, fazendo o terminal original do agente parar de bater a condição que gera o card — ele sumia da lista até a sessão de revisão/teste ser fechada. Mesma classe de bug já corrigida antes só para o viewer do GSD Sync; agora terminais utilitários (`ephemeralUtility`) e o agente efêmero de conflito (`ephemeralConflictAgent`, que tinha a mesma vulnerabilidade latente sem nunca ter sido reportada) também são excluídos dessa heurística.
- **Criar um terminal novo (via "Novo Terminal") não navegava pra tela do terminal — ficava travado na Home.** O terminal era criado de verdade (aparecia na sidebar e em "Projetos recentes"), mas `NewTerminalModal.tsx`'s `submit()` nunca atualizava a view ativa nem focava o terminal recém-criado, deixando o usuário parado na Home sem nenhum aviso. Confirmado ao vivo por um teste e2e que verifica a presença real do terminal (`.xterm`) na tela, não só o fechamento do modal. Corrigido chamando a mesma sequência de navegação/foco já usada corretamente pelo prompt rápido da Home (`setActiveProjectOnly`, `focusWorkspaceTerminal`, `setActiveTerminal`, `requestPaneFocus`, `setActiveView('workspace')`).
- **Grafo de commits do Git renderizava pontas flutuantes e hastes sobressalentes (`GitGraph.tsx`)**: O cálculo de linhas SVG agora trunca com precisão o segmento vertical (`y1` e `y2`) quando uma raia começa ou encerra em um nó de commit, garantindo que curvas de merge e linhas verticais terminem exatamente nos pontos de interseção sem sobras visuais.
- **Grafo de commits: busca quebrava a continuidade das linhas, e a cor de uma raia podia mudar no meio do histórico (`GitGraph.tsx`, `GitGraphList.tsx`)**: o cálculo de raias rodava sobre a lista já filtrada pela busca — um pai que ficasse fora do filtro simplesmente deixava de existir pro cálculo, e a linha "parava no nada". Agora o cálculo sempre roda sobre o histórico completo; a busca só esmaece (nunca remove) os commits que não batem, preservando o grafo inteiro e contínuo. A cor de cada raia também era só por índice de coluna — como colunas são recicladas ao longo do histórico, a mesma branch podia trocar de cor sem motivo. Agora a raia principal (main) usa sempre a mesma cor fixa do início ao fim, e as demais raias derivam a cor da identidade de origem (nome da branch, com fallback estável pro hash do commit) — uma branch nunca troca de cor no meio do grafo. A lista de commits também passou a ser virtualizada (só renderiza as linhas visíveis), corrigindo a lentidão em repositórios com histórico grande.
- **Grafo de commits: clicar num commit agora abre uma tela de detalhe (mensagem completa + arquivos alterados) dentro do próprio painel (`GitGraphCommitDetail.tsx`)**, no lugar da antiga expansão inline por linha — que quebrava a altura fixa da linha e simulava raias de passagem via CSS pra "atravessar" o painel expandido. A tela de detalhe busca a mensagem completa do commit (novo comando `git_show_commit_message`, já que o gráfico só trazia o subject) e reaproveita a busca de arquivos já existente; um botão "Voltar" retorna pra lista na mesma posição de scroll.
- **Grafo de commits: a raia de uma branch nunca se juntava de volta na raia principal no ponto real de origem — a linha simplesmente sumia no meio do ar (`GitGraphList.tsx`)**. Quando duas raias convergiam pro mesmo commit (ex.: o commit em que uma branch nasceu, que também é destino da raia principal), o cálculo já sabia disparar essa convergência, mas a metade superior de cada linha do grafo só sabia desenhar reto — reta até o ponto (raia principal) ou reta de passagem (qualquer outra raia) — sem nenhuma curva para o caso de fusão. Confirmado ao vivo via screenshot e2e automatizado sobre um histórico com branch+merge conhecido. Agora essa convergência desenha a mesma curva usada na divergência (estilo GitLens/GitKraken), fundindo a raia secundária visualmente no ponto de commit certo.
- **Painel de Controle Git (status + gráfico de commits) parecia ser "coberto" pela Central de Merges quando as duas seções disputavam a altura fixa da sidebar (`GitControl.module.css`)**: o `.panel` que envolve os grupos de status e o gráfico usava `overflow: hidden` sem nenhum scroll próprio — quando o conteúdo era mais alto que o espaço sobrando (ex.: Central de Merges expandida ocupando sua parte), o final do gráfico era cortado sem nenhuma indicação visual, bem na fronteira com o painel seguinte, dando a impressão de sobreposição. Trocado por `overflow-y: auto`, deixando o corte explícito (barra de rolagem) em vez de um clip invisível.
- **Feed de atividade do GSD Sync não deixava claro o que era fala do agente e o que era instrução enviada a ele** — as duas apareciam como o mesmo bloco de texto plano, só com um label pequeno diferenciando. Agora mensagens do agente ganham trilho colorido e sempre ficam expandidas (é o conteúdo principal do feed); instruções enviadas ficam recolhidas por padrão num bloco de trilho neutro tracejado, expansível com um clique quando precisar conferir o texto completo.
- **Sessão-filha do GSD Sync (gaveta "GSD Sync") nunca era de fato somente-leitura, e nem dava pra rolar o histórico.** A visualização usava um terminal PTY real (`opencode --session <id>`) com `disableStdin` pra impedir digitação — mas `disableStdin` no xterm.js bloqueia TODO byte de saída pro PTY, inclusive o mouse-tracking/scroll que um TUI em alternate-screen-buffer (o modo que o próprio OpenCode roda) precisa pra rolar a própria tela; como não existe scrollback do lado do host nesse modo, o resultado era um painel completamente travado (sem rolar, sem PageUp/PageDown, sem nenhum atalho de navegação). Também abria dentro do chrome de um container normal de projeto em vez de tela cheia de verdade. Reescrito do zero: a sessão-filha agora é lida direto via `opencode export <id>` (comando dedicado do próprio CLI que exporta o histórico estruturado — mensagens, chamadas de ferramenta, patches de arquivo) e renderizada num feed de atividade HTML somente-leitura, sem terminal PTY nenhum no caminho — rola livre, atualiza sozinho enquanto a sessão-filha trabalha, e nunca teve (nem precisa mais fingir não ter) nenhuma caixa de entrada. Como bônus, o terminal "viewer" fantasma que existia só pra sustentar essa visualização quebrada deixou de ser criado — elimina uma classe inteira de bugs de limpeza (terminal órfão, card fantasma na Central de Merges) relacionados a ele.
- **Agente de resolução de conflito (Central de Merges) nunca recebia o prompt de instruções quando o provider configurado era o OpenCode.** Quatro causas em sequência, cada uma só visível depois de corrigir a anterior: (1) o prompt era passado como argumento posicional solto (`extraArgs`) igual a Claude/Codex — mas o OpenCode trata um argumento posicional sem flag como PASTA a abrir, não como prompt inicial, e tentava `cd` pro texto do prompt inteiro concatenado ao cwd real ("Failed to change directory"); corrigido passando o prompt via `initialInput` (digitado no terminal depois do boot), o mesmo mecanismo já usado corretamente pelo prompt rápido da Home e pelo Revisor de Branch. (2) Com isso corrigido, o envio ainda "funcionava" sem erro nenhum mas o texto nunca aparecia na tela — o envio embrulhava o texto em marcadores de bracketed paste (DECSET 2004) incondicionalmente, sem checar se o processo já tinha ligado esse modo; corrigido pra usar o estado real do terminal (`terminal.modes.bracketedPasteMode`), mesmo critério já usado pela colagem normal via clipboard. (3) Digitar manualmente no mesmo terminal sempre funcionava, mas o envio automático nunca focava o painel antes de escrever — se o OpenCode já tinha ligado o modo de "focus reporting" (DECSET 1004) depois do único `focus()` automático do mount, ele nunca recebia o sinal de foco de novo (só clique/pointerdown real disparavam isso), e simplesmente ignorava a entrada; corrigido focando o painel de novo bem antes de cada escrita. (4) Causa raiz de verdade, confirmada ao vivo: mesmo com foco e digitação simulada tecla-por-tecla, a confirmação de que o texto realmente chegou na tela lia o stream cru de bytes da PTY, onde código de escape ANSI intercalado com o texto quebrava qualquer correspondência — trocado por ler o buffer JÁ RENDERIZADO pelo próprio xterm.js (texto puro, sem código de escape nenhum), removendo também qualquer caractere que não seja letra/dígito (não só espaço em branco) na comparação, já que a borda decorativa da caixa de entrada do OpenCode também entrava no meio do texto lido. O reenvio de digitação só acontece se a caixa ainda estiver visivelmente vazia (nunca redigita em cima de texto que já chegou — antes causava cópias duplicadas do prompt inteiro empilhadas na tela); o Enter final é reenviado só enquanto a tela ficar idêntica entre tentativas (nada aconteceu), parando na hora que qualquer coisa mudar (enviou, ou o agente já começou a responder). Por fim, uma falha de escrita durante essa janela de envio do prompt inicial disparava sem querer a recuperação automática de "reiniciar terminal travado" — matando a sessão recém-nascida no meio do envio, sem chance de retomada; agora essa recuperação fica suprimida enquanto o envio do prompt inicial estiver em andamento.
- **Botão "Abortar" da Central de Merges às vezes não fazia nada, sem nenhum aviso.** O poll de fundo que checa automaticamente se o conflito já foi resolvido (a cada 7s) chama a mesma rotina de finalização usada pelo botão — se o clique em "Abortar" caísse bem no meio dessa checagem silenciosa, a guarda contra clique duplo ignorava o clique sem dar retorno nenhum (confirmado ao vivo: funcionava normalmente no segundo clique, sem explicação). Agora mostra um aviso pedindo pra tentar de novo em instantes, em vez de ficar mudo.
- **O gatilho automático de 3 camadas da Central de Merges (marcador `ALETHE_RESOLVED`, saída do processo do agente, poll de 7s) integrava um conflito resolvido sem NENHUMA confirmação humana** — assim que o agente sinalizava "terminei", o Alethe validava, commitava e integrava no branch alvo sozinho, mesmo quando a resolução do agente não fazia sentido (confirmado ao vivo: um agente juntou conteúdo incompatível de duas branches num arquivo só, sem perguntar como o usuário queria prosseguir, e o resultado foi commitado e integrado automaticamente). Agora essas 3 camadas só detectam que o agente terminou e páram (nova fase "Aguardando sua revisão"); validar (rodar a Validation Pipeline) e integrar (commitar + `git merge --ff-only`) viraram dois passos manuais separados na Central de Merges, na ordem "Validar" → "Integrar".
- **"Ação pós-Merge do Agente" (Central de Merges) não fazia nada, nos dois modos.** Ao integrar um merge com sucesso, o terminal do agente era sempre encerrado, não importa se o projeto estava configurado pra "manter chat ativo" ou "encerrar terminal" — a opção de manter o agente vivo nunca tinha sido implementada de verdade, só existia como controle de UI. Corrigido inicialmente relocando o terminal do AGENTE EFÊMERO de resolução de conflito pra uma worktree/branch nova quando configurado pra isso — mas essa correção mirou o terminal errado: o agente efêmero é descartável por design (nasce, resolve, morre) e nunca deveria ganhar uma branch nova pra "continuar conversando"; relocar ele criava inclusive um card fantasma na Central de Merges (ele passava a ter um `worktreeAgentId` de verdade, sendo tratado como se fosse um worktree de agente comum). Revertido: o terminal efêmero do conflito agora sempre encerra ao integrar com sucesso, sem exceção — "manter chat ativo"/"manter sessão" continuam existindo como opção, só que ainda não estão religadas a nenhum terminal (o candidato certo é o agente de trabalho real, não o efêmero de conflito).
- **Merge bem-sucedido podia deixar o terminal do agente de conflito "reiniciado sem sessão nenhuma".** O backend apaga a worktree efêmera (`git worktree remove --force`) na mesma chamada que confirma o merge — se o processo do agente ainda estivesse vivo usando aquela pasta como cwd nesse instante, a pasta sumia debaixo dele (mesma causa-raiz já corrigida em outros fluxos: no Windows, apagar uma pasta que ainda é cwd de um processo vivo falha/corrompe estado). Agora o processo do agente é morto de verdade (`killPtyTree`, que espera a árvore inteira encerrar) ANTES do clique em "Integrar" chamar o backend, nunca depois.
- **Sessão-filha do GSD Sync nascia dentro do agente efêmero de resolução de conflito e ficava órfã pra sempre depois do merge.** O terminal efêmero de conflito é um terminal OpenCode como qualquer outro do ponto de vista do GSD Sync — sem nenhum marcador dizendo "descartável, nunca rastreie" —, então com o monitoramento GSD ligado no projeto o plugin era instalado nele igual a uma worktree normal, gerando uma sessão-filha de verdade. Ao integrar o merge, o terminal efêmero (pai) morria, mas o terminal "viewer" da sessão-filha — uma entidade separada, casada só por `cwd` — nunca era limpo junto (a limpeza existente só disparava pra terminais com `worktreeAgentId`, campo que o agente efêmero nunca tem), ficando pra trás mostrando "Invalid session ID" ou reaparecendo preso na grade principal do projeto em vez de escondido na gaveta GSD Sync. Corrigido em duas frentes: o plugin GSD (e o próprio watcher que descobre sessões-filhas) agora excluem explicitamente o agente efêmero de conflito; e a limpeza de terminal "viewer" ao apagar o pai passou a valer pra qualquer terminal com cwd, não só os com `worktreeAgentId`.
- **Criar um terminal novo (via "Novo Terminal" ou o prompt rápido da Home) podia sugerir de cara uma worktree isolada de agente (`.alethe/worktrees/<id>`) como pasta padrão**, em vez da pasta principal do projeto — acontecia sempre que o terminal mais recentemente usado do projeto era um agente já isolado. Agora os dois pontos preferem a raiz estável do repositório (mesma função já usada pela Central de Merges), caindo pro comportamento antigo só quando o projeto ainda não tem nenhum terminal "puro" pra referenciar. A lista de "Pastas recentes" do mesmo modal tinha o mesmo problema — uma worktree usada há pouco dominava os atalhos e escondia as pastas de projeto de verdade — e agora ignora terminais de agente isolado na mesma lógica.
- **Merge relatado como "concluído" podia não refletir na pasta principal do projeto de verdade.** A Central de Merges usava o cwd do primeiro terminal do projeto como referência pro repositório — se esse terminal fosse uma worktree isolada de agente, o merge (`git merge --ff-only` de verdade) rodava dentro dela, não na pasta que o usuário via no Explorer, mas ainda reportava sucesso. Corrigido para sempre usar a raiz estável do repositório principal do projeto, independente de qual worktree o primeiro terminal aponta.
- **"Integrar" numa worktree com trabalho nunca commitado virava um no-op silencioso.** `git merge` só move commits — um agente que escreveu arquivos na worktree sem nunca rodar `git commit` fazia a branch dele não ter nada de novo em relação ao alvo, e a Central de Merges reportava "concluído" sem mover absolutamente nada pro repo principal. Agora, ao clicar "Integrar" numa worktree com mudanças pendentes, um pop-up mostra os arquivos afetados e pede uma descrição do commit (pré-preenchida com o `goal.md` já escrito pela sessão-filha do GSD Sync, quando existir) antes de commitar e seguir com o merge de verdade. O commit automático (e a lista mostrada no pop-up) ignora a própria infraestrutura do Alethe nessa worktree (`.opencode/`, `.planning/`, `opencode.json`, escritos automaticamente a cada spawn) — confirmado ao vivo que, sem esse filtro, esses arquivos de configuração acabavam mergeados pro repo principal junto com o trabalho de verdade.
- **Widget de uso do Antigravity na topbar mostrava "—" (sem dado) no Linux.** A busca do token OAuth no keyring local usava um target explícito (`gemini:antigravity`) exigido pelo Windows Credential Manager, mas que impedia o Secret Service do Linux (GNOME Keyring / KWallet) de encontrar o registro gravado pelo CLI (`agy`), que não possui atributo de target. A descoberta de credenciais agora suporta os dois padrões e também busca o binário `agy` em caminhos adicionais (`~/.local/bin`, `~/.cargo/bin`) no Linux/macOS.
- **Colar imagem ou arquivos no terminal não fazia nada no Linux, silenciosamente.** `read_clipboard_payload` (que detecta uma imagem/arquivo copiado e cola como caminho, em vez de descartar o conteúdo do clipboard) só tinha implementação no Windows; em qualquer outra plataforma retornava erro na hora, sem feedback nenhum e sem cair pro texto puro (colar texto puro passa por outro caminho de código, por isso passou despercebido). Colar texto sempre funcionou. Implementado um backend Linux/BSD via `wl-paste`/`wl-copy` (Wayland) ou `xclip` (X11): screenshots, imagens copiadas da web (`image/png`) e arquivos copiados num gerenciador de arquivos (`text/uri-list`) agora funcionam igual ao Windows. macOS continua sem implementação.
- **Clonar um repositório do GitHub só funcionava em máquinas com uma pasta `D:\Projetos`.** O destino do clone estava fixo no código, então em qualquer outro disco — e em Linux/macOS — o clone falhava. Agora a pasta escolhida no formulário é usada como destino e, se nenhuma for escolhida, o clone vai para `~/Alethe/<repositório>`; o nome da pasta sai da URL do repositório, como o próprio `git clone` faria.
- Removido o caminho de renderização WebGL dos terminais, que já estava desativado no código mas continuava carregado como dependência. Os terminais seguem no renderizador Canvas 2D, sem mudança de comportamento.
- **Agentes em segundo plano paravam de reportar quando terminavam.** Com a otimização de painéis fora de tela, o backend deixa de transmitir a saída completa de um painel invisível — mas o rastreador de atividade (o que acende o status "trabalhando/terminou" nos terminais que você não está olhando) só escutava esse canal completo. Resultado: justamente o caso que o indicador existe pra cobrir ficava mudo. Agora ele também escuta o sinal leve de segundo plano.
- **Sinal leve de segundo plano descartava saída em vez de só espaçá-la.** O que chegava entre um envio e outro era jogado fora, então a detecção de "o agente começou a responder" (que conta volume de saída) e a recuperação automática de sessão ocupada do Codex podiam nunca disparar num painel fora de tela. Agora a saída é acumulada e enviada inteira no próximo envio.
- **Pedaço de saída perdido ao voltar pra uma aba de agente.** Ao reexibir um painel, o que o agente escrevia enquanto o histórico estava sendo buscado era descartado junto com a fila de desenho, deixando um buraco permanente no texto. Agora esse trecho é reaplicado depois do histórico.
- **Caracteres acentuados sumindo no controle remoto**, pelo mesmo corte de bytes no meio de um caractere UTF-8 já corrigido nos terminais locais.
- **Custo de CPU do controle de visibilidade dos painéis.** O cálculo de "quais painéis estão visíveis" rodava uma vez por painel aberto a cada mudança de estado do app; agora roda uma vez só e é compartilhado.
- **Letras/símbolos se sobrepondo no terminal, pior quanto mais compacto o painel — só no Linux, nunca no Windows (confirmado pelo usuário testando o mesmo projeto nos dois SOs).** Causa raiz real, diferente da corrida de renderer já documentada acima: o terminal pedia a fonte `'Cascadia Mono, Consolas, "Courier New", monospace'`, mas confirmado via `fc-match` que **nenhuma das três fontes nomeadas está instalada neste Linux** — cai pro fallback genérico do sistema (`Liberation Mono`, neste caso). Esse fallback cobre o alfabeto normal, mas não os glyphs estilo Powerline/Nerd Font que TUIs modernas (o `opentui` do OpenCode entre elas) usam pra ícones/separadores decorativos — confirmado com `fc-match -f '%{family}\n' "Liberation Mono:charset=<codepoint>"` pra um glyph Powerline típico (`U+E0B0`): o fontconfig cai pra uma TERCEIRA fonte (`Hack`) só pra esses caracteres específicos, silenciosamente, sem o Alethe nunca saber que houve substituição. Como o renderer Canvas do xterm.js desenha cada célula com um avanço de pixel fixo (medido de uma única fonte de referência), um glyph vindo de uma fonte diferente com métricas diferentes não encaixa na grade — daí a sobreposição, pior em painéis estreitos onde a UI decorativa do OpenCode fica mais densa por linha. No Windows isso nunca acontece porque "Cascadia Mono" está instalada de verdade e tem cobertura Unicode completa (é a fonte oficial do Windows Terminal). Corrigido embutindo a própria fonte no app: **Caskaydia Cove Nerd Font Mono** (variante Nerd Font da Cascadia Code, cobertura de glyph completa, SIL OFL 1.1 — `src/assets/fonts/`, licença em `LICENSE-CascadiaCode.txt`) via `@font-face` em `theme.css`, como primeira opção tanto em `--font-mono` quanto no `fontFamily` do terminal (`useXtermSession.ts`) — garantida em todo SO, sem depender de fonte nenhuma do sistema operacional. A primeira medição de célula do xterm.js agora espera `document.fonts.load(...)` confirmar que a fonte embutida carregou antes de rodar, reforçando a correção de corrida de renderer já existente com uma fonte cuja presença é garantida (não mais uma aposta em fonte de sistema que podia nem existir). **Atualização, confirmada ao vivo**: `document.fonts.load()` de fato funciona e carrega a fonte (confirmado via `document.fonts.check(...)` retornando `true`), mas isso sozinho não bastava — o cache de métricas de célula do xterm.js só é invalidado quando a opção que ele observa muda de VALOR; reatribuir `fontSize` (o truque já usado nesta correção) não é suficiente quando o que mudou foi a disponibilidade da FONTE, não o tamanho. Trocado pra reatribuir `fontFamily` nesse ponto específico, que é a opção cujo valor resolvido de fato mudou (de indisponível pra disponível). Ainda assim, um painel bem estreito (arrastado manualmente) pode continuar mostrando a logo ASCII do OpenCode cortada — investigação ao vivo revelou que, nesse cenário extremo, o `cols` calculado fica instável (oscila entre valores bem diferentes em sequência rápida, sem convergir), uma causa mais profunda e ainda em aberto, distinta da falta de fonte já corrigida aqui.
- **Investigação dedicada da instabilidade de `cols`/`rows` em painel estreito e do crash do runtime Bun no OpenCode, ambos só no Linux — mitigados, causa raiz ainda externa e em aberto.** Sessão de diagnóstico com pesquisa externa verificada (issues reais do `xterm.js`/`oven-sh/bun`/`opentui` checadas uma a uma contra o GitHub, não só citadas de memória) e reprodução scriptada fora do Alethe (PTY isolado via Python, sem a UI no meio). Mudanças aplicadas: (1) patch local do `@xterm/addon-fit` (via `patch-package`, sobrevive a `npm install`) removendo o mesmo "guard" de mesma-dimensão corrigido rio acima no `xtermjs/xterm.js` PR #5777 — real e mergeado, mas só existe em canal beta pós-6.0.0, não em nenhuma release estável; aplicado sozinho não bastou aqui, porque nos logs capturados o `cols` calculado nunca repetia entre leituras consecutivas (oscilando bem, ex. `19→27→79→59→46`), então esse guard específico nunca era o caminho realmente acionado no nosso caso; (2) "settle-check": `resizePty` só é de fato enviado (o que dispara o SIGWINCH real pro processo) quando o MESMO valor de `cols`/`rows` aparece em duas leituras seguidas (~130ms de intervalo), descartando valores "de passagem" durante o arrasto; (3) cooldown mínimo de 350ms entre envios reais, por cima do settle-check, depois de confirmar ao vivo que reajustes pequenos e seguidos (mesmo já "assentados" isoladamente) ainda derrubavam o processo — indício de que ele ainda estava absorvendo o SIGWINCH anterior quando chegava outro; (4) resize real adiado até o usuário soltar o divisor (via `data-resize-handle-active`, o mesmo atributo já usado pelo CSS do projeto), não mais durante o arrasto contínuo; (5) cooldown estendido (900ms) só na janela inicial de um painel que ainda não produziu nenhuma saída real (confirmado por vídeo, frame a frame: um painel ainda na tela de boas-vindas é visivelmente mais frágil a resize — texto compactado, mais propenso a crashar — do que um painel com conversa já renderizada, que resiste bem ao mesmo resize). **Nenhuma dessas mitigações de frequência/timing eliminou o problema de fato** — confirmado ao vivo, repetidamente, depois de cada uma: o crash do Bun ainda acontece (mais em painéis recém-abertos) e o texto ainda compacta/sobrepõe em painéis estreitos, com ou sem conteúdo real na tela. Reprodução scriptada fora do Alethe (PTY isolado, replicando resize+nudge exatamente como o backend manda, inclusive com dois processos e conteúdo real gerado) também não conseguiu reproduzir o crash — sinal de que depende de alguma condição de timing real (jitter de mouse, especificidades do `portable-pty`/WebKitGTK) difícil de isolar fora da UI de verdade. Adicionados dois itens que SÃO uma melhoria real e confirmada, independente da causa raiz: **detecção do próprio texto de crash do Bun** ("Bun has crashed"/"panic(main thread)") no stream de saída, com **auto-restart automático** (até 2 tentativas por painel) preservando a sessão quando existente — o processo ainda crasha, mas o usuário não precisa mais clicar em "Reiniciar" manualmente, confirmado funcionando ao vivo; e `terminal.clear()` local a cada resize assentado, mitigando (não corrigindo) um bug real já confirmado a montante (`anomalyco/opencode#3697`, "Missing main view text when resizing", Linux) onde o redraw do `opentui` após resize não limpa/reposiciona corretamente o conteúdo anterior. Uma tentativa adicional — trocar o `minSize` dos painéis de terminal de porcentagem pra um valor fixo em pixels, pra impedir o usuário de arrastar pra dentro da faixa ultra-estreita onde o `opentui` quebra — foi revertida na hora: um mínimo fixo em pixels não é seguro pra um app que roda em qualquer resolução, porque sempre existe algum tamanho de janela menor que esse valor, travando o resize por completo pra esse usuário (confirmado ao vivo). **Ambos os problemas seguem em aberto**, com causa raiz fora do código do Alethe (opentui/Bun); a via mais provável de resolução definitiva é um fix a montante nesses projetos, não mais ajuste de timing deste lado.
- **`resizePty` podia gerar uma rejeição de Promise sem tratamento quando o processo já tinha morrido** (crash, restart em andamento) entre o cálculo do fit e o envio do resize pro backend — a chamada `void resizePty(...)` não tinha `.catch()`, então um `PTY not found` virava erro solto no handler global em vez de ser ignorado silenciosamente (o próximo fit bem-sucedido já corrige o resize assim que a PTY nova existir).

- **Terminal OpenCode recém-criado (projeto novo, do zero) podia herdar sem querer uma conversa antiga de outro projeto/uso anterior da mesma pasta.** Causa: como o OpenCode não permite escolher o ID de sessão no nascimento, o app reivindica automaticamente "a conversa mais recente ainda não pega" nessa pasta — pensado pra recuperar sessões perdidas depois de reiniciar o app (quando o histórico local se perde), mas sem distinguir isso de "terminal genuinamente novo, nunca aberto antes". Adicionada uma flag por aba (`skipSessionClaim`), `true` só na criação e consumida no primeiro spawn — a partir daí a aba já existe de verdade e a recuperação normal após reiniciar o app volta a valer. Terminais/abas novas nunca mais herdam sessão à toa; a recuperação pós-restart continua funcionando igual antes.

- **Conteúdo do card "Nenhum projeto aberto" deslocava pra direita depois de selecionar uma pasta com caminho longo**, mesmo com a borda/fundo do card permanecendo no lugar — confirmado ao vivo comparando frames de vídeo antes/depois. Causa: o card é um grid sem `grid-template-columns` (uma única coluna implícita, sizing `auto`/min-content por padrão); o texto do caminho da pasta usa `white-space: nowrap`, cujo min-content é a largura TOTAL sem quebra, não a largura truncada visível. `overflow: hidden` no botão que envolve esse texto deveria, por especificação, isolar essa contribuição de tamanho das ancestrais — mas o WebKitGTK não faz essa contenção corretamente nesse caso, deixando a coluna implícita do grid mais larga que a caixa visível e descentralizando o conteúdo (`justify-items: center`) sem mover a borda. Adicionado `min-width: 0` no card e no container do seletor de pasta, forçando as duas camadas a respeitar a largura explícita já definida em vez de crescer com o conteúdo.

- **Terminais de agente às vezes nasciam com o tamanho (cols/rows) errado — texto compactado, sem se encaixar direito no container — e um resize manual não corrigia.** Assimétrico entre painéis abertos ao mesmo tempo (um certo, outro não), o que aponta pra uma corrida de inicialização, não um valor fixo errado. Causa provável identificada via console do navegador: `CanvasAddon.activate()` (do `@xterm/addon-canvas`) adia a própria montagem quando o elemento do terminal ainda não está pronto, e o getter interno `dimensions` do `RenderService` do xterm.js não tem nenhuma proteção contra o renderer ainda não estar anexado nesse meio-tempo — qualquer coisa que dispare `syncScrollArea` (scroll, foco, resize) nessa janela lança uma exceção sem catch, silenciosa (só aparece no console/telemetria), deixando o cálculo de tamanho daquele pane pra trás sem nada que refaça sozinho depois. Adicionados: (1) um fit/refresh extra adiado por um frame logo após montar os addons de renderer, dando tempo do addon assentar de verdade antes da primeira medição real; (2) `terminal.focus()` inicial isolado em try/catch — se essa chamada for o que dispara o mesmo bug internamente, uma exceção sem captura ali abortaria o resto da função de setup, cancelando o registro dos listeners de resize/zoom/ResizeObserver que vêm logo depois, o que sozinho já explicaria um terminal que nunca mais se redimensiona direito. Nível de confiança: causa raiz bem fundamentada em evidência real (mensagem de erro exata do console, código-fonte do addon-canvas e do xterm.js lidos diretamente), mas sem stack trace completo — vale confirmação ao vivo. **Atualização, confirmada por vídeo**: o mesmo problema também acontecia num RESIZE manual (arrastar o divisor entre panes) bem depois do boot, não só na montagem — texto do OpenCode quebrando em colunas bem mais estreitas do que a largura visível permitia, logo ASCII cortada na borda. Reforçado o mesmo truque de remedição forçada (reatribuir `fontSize`) também dentro do `runResize` usado por todo resize (não só o inicial), já que `fitAddon.fit()` sozinho nunca força remedição — só relê o cache, então um cache corrompido em qualquer momento ficava preso pra sempre até essa correção. **Atualização final, causa raiz real encontrada**: o erro continuava reproduzindo mesmo depois das duas tentativas acima, porque a chamada que quebra não vem de código nosso — vem de um listener **interno** do próprio xterm.js (`this._renderService.onDimensionsChange(() => this.viewport.syncScrollArea())`, lido direto do bundle), disparado de forma assíncrona sempre que o `RenderService` troca de renderer (inclusive durante a própria montagem do `CanvasAddon`), fora de qualquer call-stack nosso — por isso nenhum `try/catch` em código nosso (fit, focus, refresh) conseguia interceptar. Correção real: patch defensivo de uma vez por app em `Viewport.prototype.syncScrollArea` (acessado via `terminal._core`, o mesmo acesso que os addons oficiais usam internamente), envolvendo a chamada original num try/catch — se falhar por causa do renderer ainda não anexado, ignora silenciosamente esse frame em vez de deixar a exceção propagar sem tratamento; a resincronização real acontece no próximo disparo, quando o renderer já está pronto.

- **Reiniciar um terminal de agente (menu de contexto ▸ "Reiniciar") ou migrar terminais pra worktree isolada perdia a continuidade da conversa**, principalmente notado no OpenCode. Causa raiz: o loop que descobre e persiste o ID da sessão depois do spawn (necessário pra Codex/Antigravity/OpenCode, que não permitem escolher o ID no nascimento — só o Claude retorna um ID sincronamente) só rodava dentro do efeito de mount do componente de terminal; nem o restart manual nem a migração re-disparavam esse efeito, então esse loop nunca era reagendado nesses dois fluxos. Além disso, o `saveSession` do restart manual esquecia o campo `opencodeSessionId` por completo. Extraída a descoberta de sessão pra um módulo compartilhado (`src/lib/agentSessionDiscovery.ts`) e criado um caminho único de restart (`src/lib/agentPtyRestart.ts`) que qualquer fluxo pode chamar sem precisar remontar nada — usado agora tanto no restart manual quanto na migração. Testado empiricamente (não suposto): o storage de sessão de cada provider já é global por usuário, não por pasta, mas o resume por ID do OpenCode (`--session <id>`) TRAVA indefinidamente quando chamado de um diretório diferente de onde a sessão nasceu — por isso a migração não tenta reaproveitar a sessão antiga do OpenCode por enquanto (mantém sessão nova, como já era, mas agora persiste corretamente a sessão nova na pasta certa pra restaurações futuras funcionarem); Codex/Claude ficam com a mesma cautela até serem testados numa máquina com esses CLIs instalados.
- **Copiar/colar (texto e imagem) não funcionava em nenhum terminal de agente fora do Windows.** Os comandos Tauri de clipboard (`write_clipboard_text`, `read_clipboard_text`, `read_clipboard_payload`) só tinham implementação real via Win32 (`windows_sys`) — em qualquer outra plataforma, sempre retornavam erro na hora, e o único fallback existente (`navigator.clipboard` do browser) cobria só texto, nunca imagem. Adicionado um backend real pra Linux/macOS via `arboard` (usa o clipboard nativo do sistema — X11 e Wayland, com `wayland-data-control` como fallback pra compositores sem XWayland), cobrindo texto e imagem (colada como PNG temporário, igual ao caminho já existente do Windows via CF_DIB). Paths de arquivo (equivalente ao CF_HDROP do Windows) ficam de fora por ora — sem API estável equivalente no arboard.

- **Borda "arco-íris" (tema de cor único de projeto) ficava cortada no meio por uma linha azul**, em vez de envolver o container inteiro de forma contínua. Cinco causas, todas relacionadas a algum indicador de foco azul vazando pra fora do próprio elemento e brigando com a decoração do container/vizinho — corrigidas em sequência: (1) uma mudança anterior desta mesma leva atrelou essa borda ao estado de foco do container (`:focus-within`) por engano — na verdade ela é uma cor de projeto como qualquer outra, sempre visível/animando enquanto essa cor estiver selecionada, independente de foco; revertido. (2) o efeito usava um gradiente **linear** diagonal (135deg) por trás do recorte em anel — um gradiente linear só varia ao longo de um eixo reto, então cantos opostos do container (ex.: superior-esquerdo x inferior-direito) sempre mostravam cores bem diferentes ao mesmo tempo, parecendo uma cor "cortando" o contorno em vez de circular por ele. Trocado para gradiente **cônico** (`conic-gradient`, ângulo animado via `@property`), que varia pelo ângulo a partir do centro do container. (3) o anel do container e o anel de foco de qualquer pane dentro dele (`.pane:focus-within`) empatavam no mesmo `z-index: 2` — no empate, a pane focada (mais funda na árvore, pintada depois na mesma camada) vencia por ordem de DOM, cobrindo o anel arco-íris na região da pane focada. Anel do container subido pra `z-index: 5`. (4) o `box-shadow` de foco do pane tinha um spread `0 0 0 3px` **não-inset**, que sangra 3px pra fora da própria borda — mesmo com o z-index correto, esse sangramento invadia a faixa decorativa vizinha (o anel do container, ou a costura com o header). Trocado por só `inset`, que nunca sai dos limites do próprio pane. (5) causa mais estrutural, aparecia com 2+ panes lado a lado: o `<Separator>` do `react-resizable-panels` nasce com `tabIndex: 0` (foco por teclado pra redimensionar) sem nenhum `outline: none` — o WebKitGTK desenha o contorno azul sólido nativo de foco em cima dele (ex.: ao clicar perto pra arrastar), aparecendo como uma linha azul cortando bem no meio do container, na posição do divisor entre panes. Como esse mesmo padrão (elemento focável sem reset de outline) valia pra qualquer `<button>` do app, a correção foi generalizada: `outline: none` + `:focus-visible` com anel baseado em `--accent` no reset global de `button`, e `outline: none` explícito no separador (que já tem feedback próprio de hover/drag).
- **Fila de spawn sob pressão de memória ainda deixava passar até 2 processos novos direto, sem enfileirar.** `acquireSpawnSlot` calculava o teto sob pressão como `min(2, limite configurado)` e concedia vaga imediata a qualquer chamada nova dentro desse teto, mesmo com o bloqueio de pressão ativo — na prática, um usuário com limite de concorrência baixo (ex.: 1) via um novo agente nascer mesmo com a RAM já no limite crítico, antes do supervisor liberar. Agora, com o bloqueio de pressão ativo, toda solicitação nova sempre entra na fila; o teto reduzido só governa quantos waiters já enfileirados são liberados (ao entrar em pressão, ao liberar um slot, ou pelo mecanismo anti-starvation).
- **Número de versão do plugin GSD (`.opencode/plugins/alethe-gsd-state.ts`) dessincronizado do conteúdo real distribuído** — o conteúdo vendorizado do plugin já estava na v11, mas a constante que decide se um plugin instalado está desatualizado (`CURRENT_PLUGIN_VERSION`) ainda apontava pra v10, o que travava a lógica de atualização automática do plugin em worktrees antigas. Sincronizado.
- **Terminal principal (fora da gaveta GSD Sync) podia assumir a conversa da sessão-filha por engano**, mostrando o histórico interno do GSD (com chamadas de `gsd_record_step`) em vez da conversa real — e sem o modo somente-leitura, dava pra digitar nela também. A exclusão da sessão-filha do pool de sessões reivindicáveis só considerava o estado ATUAL do toggle "Monitoramento GSD" (`gsdWatcherEnabled`) — se o arquivo sentinel da sessão-filha já existia em disco (spawn anterior com o toggle ligado, worktree que herdou o arquivo do commit-base) e o toggle foi desligado depois, um terminal normal sem sessão salva voltava a poder reivindicar a sessão-filha (que é quase sempre a "mais recente", já que é tocada a cada ciclo GSD). Agora a exclusão depende só da existência do sentinel em disco, não do toggle.
- **Sessão-filha do GSD Sync podia ficar presa mostrando "Sincronizando" pra sempre**, mesmo muito depois do ciclo ter terminado de verdade. O marcador em disco que indica "sincronizando" só era limpo pelo mesmo processo que o criou (ao detectar o fim do ciclo) — se esse processo morresse no meio (pane fechado, app reiniciado, modelo travado), o marcador ficava órfão pra sempre, e a UI (que só lê o arquivo) mostrava "Sincronizando" indefinidamente. Agora qualquer instância nova do plugin, ao subir, limpa um marcador pré-existente (nunca pode ser do próprio processo, que acabou de nascer sem nenhum ciclo em andamento).
- **Posição de hover/link dentro do terminal ficava dessincronizada do mouse de verdade após mudar o zoom do app.** O xterm.js guarda em cache o tamanho da célula de caractere e só remede sozinho quando detecta mudança de resolução da tela — mas o WebKitGTK nem sempre dispara esse evento de forma confiável após um zoom do app (`setZoom()`), deixando o cache desatualizado e toda detecção de hover/link/clique dentro do terminal apontando pra célula errada. Corrigido forçando uma remedição do xterm.js no evento de mudança de zoom do app.
- **Ícone genérico (em vez do ícone real do Alethe) na barra de tarefas/Alt+Tab do Linux em modo de desenvolvimento** — causa raiz confirmada (não é mais suposição): não existe protocolo Wayland pra transferir pixels de ícone de janela pro compositor. O KWin (e compositores Wayland em geral) descobrem o ícone pelo `app_id` da janela, usado pra localizar um arquivo `.desktop` instalado (`/usr/share/applications/` ou `~/.local/share/applications/`) e só então ler o campo `Icon=` de lá — sem `.desktop` (o caso do `tauri dev`, que nunca instala um), não tem de onde puxar. Confirmado pelo próprio mantenedor do Tauri numa discussão oficial ("gnome only loads icons from .desktop files in which case tauri dev won't be able to display the icon") e pela ausência documentada desse protocolo no Wayland — `window.set_icon()` (tentativa anterior desta mesma leva) não é o mecanismo certo pra esse caso específico, e nenhuma mudança de código resolve isso em modo dev. Fica mantido de qualquer forma (não atrapalha, e pode ajudar em algum WM X11 via `_NET_WM_ICON`). A garantia real continua sendo um build empacotado (`.deb`/AppImage), onde o bundler do Tauri já gera o `.desktop` certo. Pra quem quiser o ícone certo também em ambiente de dev no KDE/Wayland: existe um workaround manual por máquina (criar um `.desktop` apontando pro binário de dev + regra de janela do KWin fixando "Desktop File Name" via System Settings ▸ Window Management ▸ Window Rules ▸ "Detect Window Properties") — documentado por terceiros, não é peculiaridade do Alethe (o mesmo padrão de bug aparece em outros apps não-empacotados, ex. Bitwarden Desktop).
- **Renderer DMA-BUF do WebKitGTK desligado no Linux**: causa raiz documentada oficialmente pelo Tauri (https://v2.tauri.app/develop/debug/linux-graphics/) por trás de vários sintomas relatados só no Linux — travamento de animações CSS, quebra de layout com escala fracionada do sistema (Wayland) e, possivelmente, comportamento de cursor. `WEBKIT_DISABLE_DMABUF_RENDERER=1` agora é setado antes da webview subir (Linux apenas, sem efeito no Windows/macOS) — troca o caminho de composição por um mais lento, mas sem os bugs conhecidos dessa classe.
- **Animações travadas/não fluidas no Linux** (suaves no Windows) em vários pontos da interface (modal de atualização, cards da Central de Merges, seletor de modelo, abas de modais, botão de fechar do diff pane): trocadas transições de propriedade de layout (`width`) e `transition: all` por propriedades específicas compositáveis (`transform`, `background-color`, `border-color`, `opacity`) — mais leve pro renderizador de software do WebKitGTK. A borda "arco-íris" de cor de projeto também travava/renderizava parcial: removido o `filter: hue-rotate()` da animação (redundante com o próprio gradiente, e a propriedade mais cara das duas), mantendo só o slide do gradiente.
- **Sessão-filha do GSD Sync aceitava digitação como um terminal principal de verdade**, podendo corromper o subagente sem querer — nenhum modo somente-leitura existia. Agora bloqueada em várias camadas (`disableStdin` do xterm.js, `onData`, e os atalhos que escrevem direto na PTY: colar, histórico de prompt, force-kill por Ctrl+C duplo) — a sessão-filha volta a ser só uma visão, igual o nome já dizia.
- **Área principal do OpenCode (logo/tela de boas-vindas/chat) renderizava em branco, mostrando só uns blocos cinza soltos** — causa raiz identificada com um procedimento de diagnóstico dedicado (bytes crus do scrollback + xterm.js real rodando headless, testando cada query de capability isolada): o framework de TUI do OpenCode (`opentui`) manda uma query OSC 66 pra cada glifo, tentando confirmar a largura exata que o terminal vai renderizar — o xterm.js nunca implementou um respondedor pra essa sequência (confirmado isoladamente: responde OSC 10/11/DSR/DA normalmente, mas nada pra OSC 66 nem DECRQSS/XTGETTCAP). A própria documentação do `opentui` descreve isso como causa conhecida de "artefatos estranhos contendo '66'" em terminais sem esse suporte (ex.: GNOME Terminal) — bate exatamente com o sintoma. Setando `OPENTUI_FORCE_EXPLICIT_WIDTH=false` no spawn do OpenCode (variável de ambiente oficialmente documentada pelo próprio `opentui` pra esse cenário), ele nem manda mais a query, evitando os artefatos.
- **Terminais de OpenCode corrompiam (texto e blocos de UI sobrepostos na mesma linha) logo no boot ou ao redimensionar um painel dividido.** Causa raiz confirmada analisando os bytes crus do scrollback com o próprio xterm.js rodando headless: o nudge de redesenho (Ctrl+L) que o backend manda pro OpenCode após spawn/resize podia disparar duas vezes quase juntas (uma vez no boot, outra no resize inicial que normalmente segue um spawn) — o OpenCode fazia dois redesenhos concorrentes que se sobrepunham na tela em vez de um substituir o outro. Agora os dois gatilhos compartilham uma trava (só um nudge por janela de 400ms, não importa qual gatilho chegou primeiro). (Causa raiz separada da área principal em branco — ver item logo acima.)
- **TUIs densas (ex.: OpenCode) renderizavam quase em branco no Linux/macOS.** O xterm.js recebia sempre a opção `windowsPty` (semântica de redesenho do ConPTY do Windows), mesmo rodando sobre um PTY Unix real — isso corrompia o repaint de agentes que não redesenham a tela sozinhos após resize. Agora só é aplicada no Windows de verdade.
- **Caracteres acentuados (`ã`, `ç`, `á`...) sumiam do texto de terminais, virando um retângulo em branco**, principalmente ao voltar pra uma aba em segundo plano com bastante scrollback. O corte do buffer de scrollback pro resync (`attach_pty`) media só bytes, sem checar se caía no meio de uma sequência UTF-8 multibyte — agora ele recua até o próximo caractere válido antes de cortar.
- **Modelo do agente de resolução de conflitos escolhido na busca podia não persistir mesmo clicando em "Salvar".** O formulário de edição de projeto reidratava seu estado local a cada mutação de fundo do projeto (ex.: atividade de agente enquanto o modal estava aberto), sobrescrevendo em silêncio qualquer edição pendente antes do clique em Salvar. Agora essa reidratação só acontece uma vez por abertura do modal.
- **Selecionar uma pasta na tela "Nenhum projeto aberto" e depois trocar pra "Usar formulário de projeto" perdia a pasta já escolhida**, obrigando a selecionar de novo. O formulário completo agora herda a pasta. Também: paths longos truncados nessa tela agora mostram o caminho completo ao passar o mouse.
- **Botões "Inicializar repositório Git"/"Atualizar repositório" (painel Git da Sidebar, pasta sem Git) apareciam com larguras bem diferentes**, quebrando de forma desalinhada em sidebars estreitas. Agora empilham como coluna, com a mesma largura.
- **Nada na aba Agentes do editor de projeto avisava que a pasta ainda não é um repositório Git** — só um toast reativo ao clicar em "Migrar terminais existentes", enquanto Salvar, o agente de conflito e o GSD/`.planning` continuavam habilitados mesmo sem Git funcionar de verdade por baixo. Agora um aviso inline aparece na aba, com botão pra inicializar o repositório sem sair do modal.
- **Processos órfãos (`opencode.exe`, `node.exe`) sobrevivendo a crash/fechamento forçado do app**: a rede de segurança (Windows Job Object) que já existia agora registra no log quando falha em vez de falhar 100% em silêncio, e ganhou uma segunda camada — no próximo boot após uma saída suja, o app varre os processos raiz que a sessão anterior tinha registrado e mata qualquer árvore ainda viva (com checagem de identidade do processo, pra nunca matar algo que reaproveitou o PID por coincidência). A tela de diagnóstico de memória agora mostra se a proteção está ativa e quantos processos foram limpos na inicialização, quando aplicável.
- **Central de Merges bloqueando merge com "não há alterações de código" mesmo com trabalho real na worktree, e "Briefing de Testes" mostrando "Nenhuma alteração detectada" no mesmo caso**: o comparador de diff (`git_diff_summary`) só olhava commits entre branches — um arquivo criado/editado e nunca commitado na worktree não aparecia em nenhum dos dois. Agora ele também considera o estado não commitado da própria worktree.
- **Seção "GSD Sync" nunca aparecendo na barra "Tarefas" para terminais OpenCode sem isolamento de worktree**: o filtro que descobre sessões pra mostrar na UI exigia isolamento de worktree, mas o plugin que efetivamente cria a sessão não tem essa exigência — um terminal OpenCode com o monitoramento ligado, mas sem worktree isolada, tinha a sessão criada em disco e nunca aparecia em lugar nenhum. Os dois critérios agora usam a mesma condição.
- **Procedimento de teste do "Briefing de Testes" podia perder passos de trabalho já commitado**: o plugin GSD só considerava arquivos ainda não commitados (`git status`) ao decidir o que documentar a cada ciclo, então um arquivo de uma tarefa anterior que já tinha sido commitado (merge, commit manual) desaparecia do escopo do próximo ciclo — o passo de validação dele era perdido de verdade. Agora o escopo também inclui o que já foi commitado nesta worktree desde que ela divergiu de `main`/`master`.
- **Seletor de modelos de agentes (`ModelSearchablePicker`) contaminando cache e perdendo modelos na troca rápida de provedores**: corrigida a corrida assíncrona na busca de modelos via CLI no `EditProjectModal`. Antes, ao alternar rapidamente entre provedores (ex.: Claude → OpenCode → Claude → OpenCode), a resposta da busca assíncrona do Claude resolvia quando o estado ativo já era OpenCode, gravando os modelos do Claude na chave do OpenCode no cache global (`globalModelsCache`). Além disso, o seletor agora lembra do modelo escolhido individualmente por provedor (`providerModelsMap`), permite selecionar modelos pesquisados customizados com `Enter` e preserva a seleção ativa sem resetar para a primeira opção da lista.
- **Terminais de agentes fora de tela (aba de grupo inativa ou painel colapsado) pararam de pesar na responsividade do app.** Antes, todo terminal ativo desenhava sua saída em tempo real mesmo invisível — com vários agentes trabalhando em paralelo em projetos/abas diferentes, isso podia deixar o app "não respondendo". Agora o backend só transmite a saída completa (pra desenho na tela) de painéis realmente visíveis; painéis em segundo plano recebem só um sinal leve e espaçado, suficiente pra continuar detectando quando o agente termina e notificar — o agente em si **nunca pausa nem perde velocidade** por estar fora de tela, só a atualização da tela é que é adiada até você voltar pra aquela aba (com sincronização instantânea do que foi perdido). Também: os terminais agora renderizam com o addon Canvas (2D) em vez de WebGL — bem mais rápido que o renderizador DOM puro sob saída pesada, sem o risco de crash de perda de contexto que o WebGL podia disparar em telas com muitos terminais.
- **Carregamento/recarregamento de terminais (principalmente OpenCode, com TUI densa) travava o frontend por alguns segundos.** Painéis que abrem fora de tela (workspace restaurado com vários agentes de uma vez) agora não buscam nem desenham o histórico de scrollback até você realmente olhar pra eles — o backend já mantinha esse histórico de qualquer forma, só a exibição era adiada. Além disso, o pedaço de texto escrito no terminal por frame caiu de 64 KB para 16 KB: telas cheias de TUI (cor/movimento pesados) custam bem mais tempo de desenho por byte do que texto simples, então um pedaço grande demais já travava o quadro sozinho.
- **"Migrar terminais existentes" (Editar Projeto ▸ Agentes) dizia "concluído" mas o terminal não saía da pasta antiga.** O terminal recebia a worktree nova no armazenamento interno, mas o painel já aberto continuava mostrando a sessão antiga sem perceber a mudança. Agora cada aba com processo vivo é reiniciada diretamente na pasta nova, sem precisar fechar e reabrir o painel.
- **Migração de terminal pra worktree isolada não instalava o monitoramento de planejamento (GSD), mesmo com a opção ligada.** Dois problemas: o monitoramento não era reinstalado na pasta nova durante a migração, e o botão de migrar podia usar uma versão desatualizada da configuração se a opção tivesse acabado de ser marcada na tela sem clicar em "Salvar" antes. Os dois corrigidos.
- **Ligar o monitoramento de planejamento (GSD) num projeto sem nenhum ciclo de planejamento ainda rodado falhava em silêncio**, sem avisar nada — a pasta `.planning/` esperada ainda não existia. Agora a pasta é criada normalmente ao ligar o monitoramento.
- **Botão "Abrir pasta como projeto" (tela inicial, sem nenhum projeto aberto) ficava sem cor de texto visível**, dependendo do tema. Corrigida a variável de cor usada.
- **Seletor de modelo do OpenCode travava em "Carregando modelos do CLI..." mesmo já tendo modelos em cache.** A busca de modelos via CLI não tinha nenhum cache no backend — toda reabertura do modal reexecutava o subprocesso `opencode models` (lento, cold-start de Node/Bun) do zero, e a UI mostrava "carregando" mesmo quando já havia opções cacheadas pra exibir na hora. Agora a busca fica em cache por alguns minutos, o OpenCode ganhou uma lista de modelos de fallback (como os outros agentes já tinham), e o indicador de carregamento só aparece quando não há nenhuma opção ainda pra mostrar.
- **Um terminal novo podia "roubar" a conversa de outro terminal já existente** apontando pra mesma pasta (mesmo projeto, outro projeto, ou depois de reiniciar o app) — a checagem de sessões já reivindicadas só vivia em memória durante a execução do app, sem consultar o que já estava salvo em disco. Agora a checagem também exclui qualquer sessão já associada a outro terminal salvo, então nunca reivindica uma conversa que já pertence a outra aba.
- **Migrar um terminal pra worktree isolada descartava o ID da sessão de conversa antiga sem tentar preservá-la**, reiniciando sempre do zero. Agora o ID antigo é passado como tentativa de retomar a conversa na pasta nova, em vez de simplesmente ser jogado fora.
- **Processos órfãos (ex.: subprocessos de MCP que o OpenCode cria sozinho) podiam sobreviver a um fechar/reiniciar terminal, mesmo com o Alethe continuando aberto.** A varredura de limpeza de árvore de processos tirava um retrato único dos processos antes de matá-los — qualquer processo criado bem nessa janela (entre o retrato e o fim da matança) escapava e ficava órfão, solto no Gerenciador de Tarefas. Agora há uma segunda varredura logo em seguida, específica pra pegar esses retardatários.
- **"Criar nova branch e manter sessão" (Ação pós-merge do agente) marcada como Beta e travada — não dá mais pra selecionar.** Essa opção já era, na prática, um no-op disfarçado: o guard interno que decide se um resume entre pastas é seguro (`CROSS_CWD_RESUME_OK`) nunca teve nenhum agente liberado, então escolher "manter sessão" sempre caía silenciosamente numa conversa nova — igual a "manter chat ativo", só que sem avisar. Ver investigação completa logo abaixo (seção "Investigado"); a opção continua visível (documentando a intenção futura) mas desabilitada, com aviso inline explicando o motivo, até existir uma correção upstream confiável.

### Investigado (ainda em aberto)

- **Retomar uma sessão do OpenCode a partir de um diretório diferente do original trava indefinidamente — investigação completa, incluindo teste real de um plugin da comunidade, confirma que não existe correção possível do lado do Alethe hoje.** Motivada por um travamento ao vivo ("Failed to send prompt — Unexpected server error" na própria TUI do OpenCode) depois que um merge removeu a worktree onde a sessão tinha nascido. Rastreado via `~/.local/share/opencode/log/opencode.log` (`--print-logs --log-level DEBUG`) até um retry-loop interno de rastreamento de snapshot (`Snapshot.track()` → `FileSystem.realPath` contra o diretório original, já deletado), repetindo a cada ~15-20s sem nunca desistir nem responder. Causa raiz mais profunda, confirmada lendo o próprio código-fonte do OpenCode (via o relatório técnico que o autor de um plugin de terceiros escreveu pros maintainers) e por reprodução direta fora do Alethe (`opencode run`/`opencode serve` isolados, com/sem a pasta original existindo, com/sem `{"snapshot": false}` — testado e não resolve): `Instance.directory` é fixado uma única vez no boot do processo via `AsyncLocalStorage` e nunca muda depois, mesmo quando a sessão é resumida em outro lugar.
  - **Teste real do plugin de terceiros `opencode-dir`** (github.com/adiled/opencode-dir): clonado e instalado localmente via `.opencode/plugins/` (carrega direto do sistema de arquivos, sem precisar publicar no npm — útil como referência caso a Alethe queira empacotar algo assim no futuro). Confirmado via `opencode serve` real + chamadas diretas na API HTTP (`POST /session/{id}/command`, o mesmo caminho que a própria TUI usa pro comando `/mv`) que o plugin resolve mais do que a própria documentação do autor promete: forçando o modelo a passar `filePath` como string literal sem nenhum prefixo (`"prova3.txt"`), a ferramenta `write` gravou no diretório novo corretamente — o autor documenta isso como impossível de corrigir via plugin (`read`/`write`/`edit` resolvem contra `Instance.directory` antes de qualquer hook rodar), então ou a versão instalada (1.18.18) já mudou esse comportamento por fora, ou a limitação documentada ficou desatualizada.
  - **Mesmo assim, o teste decisivo reproduziu o travamento de qualquer jeito**: com o plugin ativo, o override de diretório aplicado (`/mv` confirmado no log do plugin: `storing override`) e a pasta original **deletada de verdade** (não só teórica — simulando exatamente o que acontece depois de um merge remover a worktree), uma mensagem nova pra essa sessão ficou sem nenhuma resposta por mais de 60s (mesmo padrão de silêncio total do travamento original, incluindo um gap de 65s só no bootstrap da instância). O plugin resolve a camada de "ferramentas resolvendo o caminho errado", mas não alcança a camada mais funda (bootstrap/rastreamento interno da instância) onde o travamento de verdade acontece — isso está fora do alcance de qualquer hook de plugin, exigindo uma mudança no próprio OpenCode (o autor do `opencode-dir` já propôs isso formalmente aos maintainers, ainda sem resposta).
  - **Decisão**: manter o guard `CROSS_CWD_RESUME_OK` como está (nenhum agente liberado) e desabilitar/marcar como Beta a opção "manter sessão" na UI (ver "Corrigido" acima), em vez de construir uma versão própria desse plugin — construiria a mesma solução parcial já testada e confirmada insuficiente pro cenário real que importa (worktree removida após merge). Reavaliar se/quando a mudança proposta pelo autor do plugin (ou equivalente) for aceita a montante no OpenCode.
- **Fechar o Alethe à força (Task Manager "Finalizar tarefa", crash, queda de energia) pode deixar terminais/agentes vivos**, mesmo com a rede de segurança do Job Object (`KILL_ON_JOB_CLOSE`) ativa — reproduzido ao vivo de forma consistente, inclusive num script isolado fora do Alethe (sem nenhum código do app envolvido, mesma falha reproduzida com `CreateProcess`/`AssignProcessToJobObject` puro). Hipótese inicial (PowerShell 7 da Microsoft Store/MSIX escapando do job) **descartada por teste comparativo direto** — o `powershell.exe` clássico não-MSIX falha exatamente igual. Causa raiz real ainda incerta; hipótese em aberto mais promissora (não confirmada): o `conhost.exe` interno que o `CreatePseudoConsole` do ConPTY cria pode não herdar o Job Object do processo chamador. **O fechar normal do app (clicando em "Fechar o Alethe" na confirmação) não é afetado** — testado 3 vezes ao vivo, mata a árvore inteira de processos corretamente todas as vezes, já que usa `kill_pty_tree` (PID real) em vez de depender do Job Object.

## [1.5.0] — 2026-08-09

- Fixed onboarding hanging forever on "Detecting installed CLIs…": CLI detection is now time-boxed per agent, so a slow or unreachable PATH entry can no longer freeze the flow.
- Fixed creating a new account/profile getting stuck on a long, broken loading state — the fresh profile now reaches its onboarding cleanly, and parking the previous profile's terminals no longer blocks the switch.
- The default profile picture now uses the current dark app icon.
- Archived the Agent Sandbox project mode behind a build flag: its entry points (New Project mode picker and the main menu shortcut) are hidden, so no new sandbox projects can be created.
- Reworked the startup loading screen to share the Home view's background and ASCII art treatment for a consistent look.
- Added an "Erase all data (fresh install)" menu action that wipes every profile, account, project, scrollback, setting and log so the app restarts like a brand-new install — intended to be used after exporting a backup.
- Account/profile export now archives the entire profile — Todos, history, activity metrics, preferences, tokens, scrollback, and any other stored data — instead of a fixed short list, so nothing the user owns is lost when exporting or migrating a profile.
- Fixed switching accounts hanging with "Could not safely switch accounts: PTY reader flush barrier timed out" by closing each parked terminal's pseudoconsole before waiting for its final scrollback flush.
- Fixed profile switching without restarting the app and refreshed terminal chats correctly when resuming parked sessions.
- Refined the Accounts modal layout with clearer hierarchy, spacing, and profile creation controls.
- Replaced the Todo project selector with a viewport-safe dropdown that keeps long project paths contained during use and recording.
- Added an independent native desktop icon theme preference, defaulting to Dark and supporting all Alethe themes plus the Blue/Pink Gradient variants.
- Prevented concurrent terminals from resuming the same Codex conversation, avoiding the active-writer crash during session restore.
- Made the Codex active-writer recovery robust to bootstrap errors split across multiple PTY output chunks.
- Set the generated desktop and installer icons to the Dark Alethe icon by default.
- Updated the root README branding to use the Dark Alethe app icon.
- Standardized all project dropdowns on the Todo List's portal-based behavior, with viewport-safe positioning, truncation, keyboard escape handling, and consistent styling.

### Added

- Added four UI themes built from the Elite Dev artwork — Elite Original, Elite Pure Black,
  Elite Indigo and Elite Blush — each with a full token set, listed first under Preferences,
  Appearance.
- Added matching app-icon themes for the same four palettes, shown as a preview grid instead
  of a dropdown.
- Added an app-icon picker to the onboarding theme step, so the icon can be chosen on first run
  instead of only from Preferences afterwards.
- Added branded header and sidebar artwork to the Windows NSIS installer.

### Removed

- Removed the previous app-icon themes; the icon picker now offers only the four Elite
  marks. Preferences still pointing at a removed icon are migrated to Elite Original on
  load. The UI themes they shared a name with are untouched.

### Changed

- Elite Indigo is now the default UI theme and the default app icon for new installations. The
  application icon, the installer icon and the installer artwork all use the same Indigo mark.
- Replaced the home and loading backdrop artwork with the same monochrome portrait, so the
  backdrop and the installer icon come from one mark.
- Added an Animated/Reduced motion preference and lowered the home ASCII background's CPU cost by
  caching image processing and pausing it while hidden, while preserving the creator's original 8px
  ASCII design and 30 FPS animated cadence.
- Hardened the production renderer with a defense-in-depth Content Security Policy and replaced its
  broad core/plugin defaults with the audited permissions used by the main webview. Privileged custom
  commands still depend on their own authorization and input-validation boundaries.

### Fixed

- The embedded browser pane no longer escapes its cell on scaled displays. Its webview was
  positioned with CSS-pixel coordinates while the window places child webviews in physical
  pixels, so the two only lined up at a device pixel ratio of 1 — on a HiDPI screen the
  browser was drawn oversized and offset, covering the rest of the layout.
- Changing the terminal palette now repaints the rows already on screen. Only the option was
  being swapped, so existing output kept the previous colours until the next redraw.
- Terminal text no longer disappears on light themes. xterm's built-in ANSI palette assumes a
  dark background, so anything an agent painted as white or bright white rendered white on a
  light surface. Light themes now carry an ANSI palette that keeps every hue — so agent
  branding survives — and re-points only the neutrals that would otherwise vanish.
- Light-theme detection is now derived from each theme's own background luminance instead of
  a hardcoded pair of theme names. The OpenCode icon and the Markdown pane were picking their
  dark-theme variants on any light theme outside that pair, rendering a pale icon and dark
  syntax highlighting on a light surface.
- The terminal no longer falls back to the dark palette when the selected theme has no
  terminal colours of its own. Orca had been silently rendering a dark terminal since it was
  added, and every light theme showed the same mismatch. The resolver is now an exhaustive
  map, so a theme without terminal colours fails the build instead of shipping wrong.
- Windows updates no longer close the app without coming back. The update manifest pointed Windows
  at the MSI, but the installer nearly everyone actually has is the NSIS `setup.exe` the download
  page serves. An MSI applied over an NSIS install neither upgrades it nor restarts the app, so the
  updater downloaded, closed Alethe, and left the old version behind. The generic Windows entry now
  points at the NSIS installer; the `-msi` and `-nsis` entries are still published for anyone
  pinning one deliberately. Existing installs that ended up with both an MSI and an NSIS entry
  registered will settle onto NSIS after this update.
- The **Continue in Claude Code** button in the agent handoff dialog was unreadable. It painted its
  label with a colour token that does not exist anywhere in the app, so the text fell back to the
  inherited foreground and sat light-on-accent.

## [1.6.0] — 2026-08-17

### Added

- Added Normal and Clean application-wide visual styles. Normal preserves the production UI with
  colored borders and rounded surfaces, while Clean uses the new compact project tree, flat right
  sidebar, square terminal containers, restrained hover states, and single-row profile footer.
- Added shared Clean visual tokens for row and control heights, spacing, radii, borders, hover
  surfaces, and transition behavior so the minimal language can be extended consistently.
- The onboarding now asks which interface style to use (Normal or Clean) with a live preview of each
  one, right after the theme step.
- Claude Code and Codex conversations can now be continued in the other agent from the terminal
  toolbar or Recent chats — so hitting a usage limit on one agent no longer ends the conversation,
  you carry it into the other and keep working. Alethe builds an editable context packet, redacts
  anything that looks like a secret, token, password, API key or credential before it leaves the
  machine, opens the target agent in a new pane, keeps the source conversation available, and
  removes the temporary packet after the first target turn or when its pane is closed.
- The right sidebar now keeps a cumulative, per-profile history of up to 12 recently opened
  Markdown files as switchable tabs, persisted across app launches. Markdown files can be sent
  there from the Explorer or dropped from the desktop, history tabs can be closed individually,
  and they remain available while visiting the Todos, Git, or MCP sidebar modes.
- GitHub Copilot CLI is now available as an agent throughout onboarding, installation, quick launch,
  terminal creation, sub-tabs, CLI path overrides and unrestricted mode.
- New **Golden Premium** theme, with its own terminal palette.
- New **MCP** tab in the right sidebar: a single place to see every MCP server configured on the
  machine, grouped by server name and showing which agents have it. It reads Claude Code
  (`~/.claude.json`, `.mcp.json`), Codex (`~/.codex/config.toml`), OpenCode (`opencode.json`) and
  Antigravity (`~/.gemini/config/mcp_config.json`), with a Global/Project switch — so a server
  present in Claude but missing in Codex is visible at a glance. At project scope it also reads the
  servers `claude mcp add` writes by default, which Claude keeps inside `~/.claude.json` under the
  project's entry rather than in the repo, and labels each row with the file it came from. Environment values are masked and
  only leave the backend one key at a time, on an explicit click. A config that cannot be parsed is
  reported as read-only and is never written to. Servers can be added, removed and enabled/disabled;
  every write is preceded by a backup, validated by re-parsing the result and checking that no other
  server changed, and committed atomically. A server can be **copied from one agent to another** in
  one click, and adding a new one takes a form, a pasted JSON block in any of the shapes the agents'
  own docs use, or a search of the official MCP registry — which turns a published package into a
  ready-to-run command and pre-fills the variables it expects, marking the secret ones empty. The
  last successful search of each term is kept on disk so the list still opens when the registry is
  unreachable, labelled with the date it was captured. Alethe translates a server to each target's
  format and refuses, rather than silently dropping, a field the target cannot express. A per-agent
  **Check** button asks the agent itself whether it can actually reach each server — the one thing no
  config file can answer. The first time the app opens with the feature on, a card shows what was
  found and offers to align the agents in one click; it can be reopened at any time from
  Preferences → Features, where the whole feature can also be turned off.
- The MCP tab splits into **Servers** and **Skills**, each with its own search and an **Add more**
  button that opens the manager straight on the registry search. Every row shows the icon of each
  agent that has the entry, greyed out for the ones missing it, and a row of agent buttons filters
  the list down to a single agent. A server or a skill can be removed from every agent at once
  instead of one row at a time, and the add flow asks which agents get it before writing anything.
  The registry search filters by whether a server runs locally or remotely.
- A **Skills** tab in the same manager lists every skill installed for each agent, reading
  `~/.claude/skills`, `~/.codex/skills` and the shared `~/.agents/skills` store. It resolves links
  (including Windows junctions) so a skill shared between agents is shown once with its real
  location, renders the SKILL.md frontmatter, folder structure and body, and surfaces where the
  skill was installed from. Skills that ship with the agent are locked and cannot be deleted;
  removing a linked skill unlinks it from that agent only and keeps the shared copy the other
  agents point at.
- Grid layouts are now edited directly on the grid. Every pane and every project container carries
  resize edges: dragging against a neighbour resizes the tracks as before, but dragging towards an
  empty cell stretches the pane over it, cell by cell. Double-clicking an edge — or the expand button
  that appears on a pane with empty space next to it — makes that pane swallow all the free space
  around it, so a lone pane on the bottom row can finally take the whole row without opening a
  dialog. Empty cells also became drop targets: dragging a pane or a container onto one moves it
  there instead of swapping with a neighbour.
- The project container header has a **+** button that creates a new terminal in that project.
- Agents that are not installed can now be installed from inside Alethe. The onboarding agent step
  and the "not found" overlay of a terminal both offer an **Install** button that runs the official
  installer in a real shell and streams its output, then confirms the CLI is reachable before
  reporting success. Alethe probes the machine for Node, npm, WinGet, Scoop and Chocolatey and only
  offers the methods that work there, preferring each vendor's official installer — which needs no
  Node — and listing the alternatives under **Other ways**.
- A **Recent chats** button on the terminal toolbar, next to Open in VS Code, lists the Claude and
  Codex conversations of that pane's working directory and resumes any of them, either in a new pane
  on the current grid or in the pane it was opened from. The panel opens on the tab matching the
  pane's agent, and unrestricted mode is a checkbox applied to the resumed session.
- **Ctrl+B** toggles the left sidebar open and closed. The topbar button now shows the shortcut in
  its tooltip.
- When an agent can only be installed through npm and Node.js is missing, its install dialog now says
  so instead of dead-ending on "no automatic installer". It offers a one-click Node.js install
  through WinGet, Scoop or Chocolatey when one of them is available, and a **Download Node.js**
  button otherwise. Once Node lands, the agent's own installer appears without reopening the card.
- Freebuff and Mimo can now be installed from inside Alethe like the other agents, with their
  documentation links — until now they were the only agents with no installer at all.
- Installed agents can be **uninstalled** from the onboarding agent step. Confirmation happens in a
  dialog that shows the exact command about to run, and the agent is only reported as removed once
  its CLI can no longer be found. Only one agent can be installed, updated or uninstalled at a time —
  package managers share a single global directory and corrupt each other when run in parallel.
  Agents whose only installer is a vendor script offer no uninstall, since none of them documents
  one and guessing what to delete
  would be worse than doing nothing.
- Agents with a newer release published on npm can be updated in place from that table.
- Right-clicking a terminal pane pastes the clipboard (text, images and files) when nothing is
  selected; with a selection, the right click copies it and clears the highlight.
- A URL printed in a terminal can now be opened as a browser pane in the grid, next to the existing
  "open in app" and "open in browser" actions — the same one-click **Open in grid** that Markdown and
  video links already had.
- The Files sidebar now supports quick previews, adding or dragging files into the workspace grid,
  revealing entries in File Explorer, renaming, and confirmed deletion. Git file rows can also open
  the working file in the grid or reveal it alongside the existing stage, discard, commit, and sync actions.
- Browser panes now offer app-first, balanced, and keep-alive resource modes. App-first is the default,
  and every mode releases hidden native webviews when Alethe detects memory pressure.
- The layout organizer now includes adaptive presets and keeps the eight most recently saved layouts
  separately for each project, group, and workspace.
- New **Ember** interface theme: cool charcoal surfaces, hairline dividers and a single ember-orange
  accent for live state, with a matching terminal palette. Selectable in Preferences → Appearance and
  as the terminal theme; it does not ship a native app icon variant.
- Remote control now pairs through a **short-lived pairing window**. The QR code is valid for two
  minutes and stops working as soon as one device pairs; a paired device receives its own session
  token and can be revoked individually. Preferences → Remote control can reopen or close the window
  at any time.
- A message sent from a paired phone now raises a desktop notification naming the device and showing
  what it sent, so remote input is never silently typed into a terminal.
- Individual terminals can now be hidden from remote devices from the sidebar context menu. A hidden
  terminal disappears from the phone's list and its output and input are refused server-side.
- Remote control gained a **read-only mode** (on by default) and a separate switch that decides
  whether plain shell terminals accept remote input. With both at their defaults a paired phone can
  watch terminals but cannot type into them.
- Session scans that take longer than 250 ms are now recorded in `logs/app-events.log`.
- Restored browser panes in the workspace grid. **Add browser** is available from the app menu
  and each project's three-dot menu, opens a dedicated URL and settings dialog, and runs every
  page in a native incognito webview whose cookies, cache, autofill, and site storage are discarded
  when the pane closes.
- Added a live Remote Control device counter to the top bar with direct access to the connection
  panel.
- The project editor now warns when its folder is not a Git repository and offers initialization
  without leaving the dialog.

### Changed

- The sidebar's **Organization** block is back to the 1.5.0 layout: the label with the four layout
  modes, plus the workspace grid button — the reworked panel with stacked icon rows and a scope
  switch in its header was reverted.
- The right sidebar no longer depends on the Todos feature being enabled — it now appears whenever
  Todos, MCP, or Git-on-the-right is active.
- Installing an agent now happens in a dialog. It lists every method that works on this machine —
  the vendor's own installer, npm, WinGet, Scoop, Chocolatey — with the exact command each one runs,
  and you pick which to use instead of being given one button and a hidden "other ways" list.
- The onboarding agent step was rebuilt as a table. Every agent is one row with its icon, the
  resolved path of its CLI, the installed version, a status tag, and its actions — install, update
  or uninstall — so all rows line up regardless of what each agent offers. Above it there is a
  counter strip (enabled, up to date, with updates, installable), a search field that matches on name
  or path, and All / Detected / Installable filters. A **Scan again** link re-runs detection without
  leaving the step, for when an agent was installed outside Alethe.
- GitHub Copilot is drawn with its official mark instead of the generic robot placeholder, so every
  agent in the app now carries its own logo.
- Setting MCP up is no longer a step of first-run onboarding. It is offered once as its own card
  after the app opens, and stays available in Preferences → Features — onboarding goes back to five
  steps.
- The layout designer dialog now uses the same drag-and-drop engine as the rest of the app. Cards
  follow the cursor without lag, only the cell under the pointer lights up, a plain click still just
  selects, and cards are resized with the same edge handles as the real grid.
- Switching workspace tabs no longer reloads them. Every tab in the tab bar — the same ones Ctrl+Tab
  cycles through — stays mounted in the background instead of being torn down, so its terminals keep
  their scrollback, their PTY attachment and their scroll position. Coming back to a tab no longer
  shows a boot spinner and never restarts anything, however many projects you move between. The two
  most recently used background tabs also keep receiving output, so returning to them costs nothing
  at all; the rest pause their stream while hidden and redraw on return. None of them are suspended
  for being idle while they stay mounted. A tab that produced no output while it was away skips the
  redraw entirely and comes back untouched.
- The terminal boot overlay uses the same dot-matrix loader as the sidebar instead of its own
  spinner.
- Terminals start faster. Resolving an agent's launcher scanned every directory in PATH on every
  boot; successful lookups are now remembered and revalidated against the file itself, so installing
  or removing a CLI is still picked up immediately.
- Critical Windows memory pressure now suspends one eligible hidden idle runtime at a time, preserving
  session scrollback while preventing system-wide stalls that can make even Alt+Tab stop responding.
- High-volume terminal output now coalesces runtime activity timestamps, avoiding repeated global
  state updates and skips remote-control serialization when no remote device is connected, without
  delaying terminal rendering or process I/O.
- Spotify playback widgets now share connection and track requests instead of polling the backend
  independently.
- The title bar now uses a lightweight connected-device count and pauses remote-control polling while
  the app is inactive, avoiding repeated QR-code generation for a badge update.
- Native browser panes now share one overlay observer instead of each watching the entire application
  DOM independently.
- Remote-control polling now reuses the pairing QR code until its URL or token changes.
- GSD session watching now reads child state in one background command instead of launching three Git
  root-resolution processes per watched item every five seconds.
- Layout editing now provides a smoother drag preview, a clearer preset/history library, and reduced-
  motion support. Sidebar activity indicators now share the trailing action slot with the three-dot
  menu, while Todo edit and delete actions no longer reserve empty space before hover or keyboard focus.
- Repository instructions now explicitly require English for source comments, JSDoc, internal logs,
  documentation, changelog entries, and default user-facing strings.
- Windows installers now include the official WebView2 bootstrapper and automatically install the
  Evergreen Runtime when it is missing, instead of downloading the bootstrapper separately.
- App icon choices now update the running native window and taskbar icon immediately.
- Memory monitoring no longer parks runtimes, closes tabs, or blocks new sessions automatically.
  Memory Analytics now bases its health alert on available Windows memory and keeps session closure
  under explicit user control.
- Resource health is recorded periodically in `logs/resource.log`, and failed `projects.json` saves
  are logged and retried instead of being silently discarded.
- Everything inside a group now sits indented under a barely-there rail that picks up the group's
  color on hover, so a grouped project is distinguishable from a loose one without adding noise.
- Groups and projects now expand and collapse with a short height-and-fade animation, and the
  disclosure chevron rotates instead of swapping icons. Both respect reduced-motion.
- Group headers now read as section labels — quiet 11px text and a rule line, with no folder mark —
  so they are no longer mistaken for project rows, and project and session rows were tightened to a
  28px scale so the group no longer competes with them.
- Reworked both sidebar styles into a flat three-level list. Groups are now section dividers (label,
  rule, add and collapse actions) instead of a tree level, every project renders as a single folder
  row with its sessions underneath, and the boxed active-project card, its primary badge and its
  separate new-terminal button are gone — the row's + creates a session and clicking a group header
  only expands or collapses it.
- Row actions (+ and the three-dot menu) now appear on hover, and the selected session is marked
  only by a solid background.
- Hidden and paused agents are now signalled only by a desaturated agent logo and a softer name —
  the strikethrough and the italic "disabled" styling are gone.
- The agent logo is now the leading element of every terminal row; the running indicator and the
  response-ready badge moved to the right end of the row.
- Standardized the entire changelog in English and made English the explicit default language for
  versioned repository content and commit messages.
- Simplified Clean sidebar selection with subtle background feedback and no side markers, preserved
  animated running-state indicators, removed the Ungrouped heading and Primary badge, increased tree
  spacing, and added a direct new-terminal action to every project.
- The Clean sidebar footer now keeps the latest known Spotify track visible when playback is
  inactive and stays hidden when no real track is available, without an empty connection prompt.
- Clean mode now presents a dedicated New Agent action, folder-based project rows, one focused row at
  a time, dimmed inactive agent icons, and matching flat selection feedback in the top bar.
- Extended Clean styling across dialogs, dropdowns, context menus, workspace panes, browser/video/
  Markdown surfaces, sub-tabs, Home cards, empty states, and floating inspectors with neutral focus,
  flat hover feedback, reduced motion, and no heavy elevation shadows.
- Tightened the Clean sidebar tree: New Agent moved below the toolbar and reads as a quiet row,
  project rows dropped the branch label, agent counter and standalone AI icon, every project now
  expands by default with its own chevron, and group, project and terminal rows were reduced in
  height with clearer indentation between the three levels.
- Removed finished-agent badges from Clean sidebar items while preserving the aligned state gutter
  and animated working indicator for agents that are actively running.
- Removed the workspace's animated gradient focus frame in both visual styles, increased the Clean
  sidebar's separation between groups and projects, and added group logo selection to both group
  creation and editing with a folder fallback.
- Removed the space-consuming terminal header bar in both visual styles and kept its controls
  available in a compact hover overlay that does not reduce terminal content height. The overlay
  now also shows the active conversation's agent logo and name on the left.
- Spotify now refreshes existing connections automatically and falls back to the most recently
  played track when nothing is currently active, while connection prompts no longer appear in the
  sidebar or Home dock.
- Increased inactive Clean top-bar tab and logo contrast, aligned Spotify and profile footer rows to
  the same proportions, and restyled the profile menu with the shared compact Clean popover metrics.
- Matched the Clean right sidebar to the left sidebar's flat toolbar, controls, spacing, and list
  treatment, and standardized every Clean menu and dropdown on the profile menu's smooth entrance
  motion, including model, project, agent-usage, context, Home, and terminal-link selectors.
- Project and group rows now prefer their configured logo over the folder fallback in Clean mode,
  and the right sidebar mirrors the left toolbar's button sizing, spacing, utilities, and active states.
- Claude rows in both sidebar styles now show the live conversation title, falling back to the first
  user prompt and then the agent name, with long titles truncated without disturbing row actions.
- Groups are always ordered above loose projects at every sidebar level, orphaned subgroups remain
  visible at the root, and configurable group logos replace the folder fallback in both styles.
- The Clean Organization layout strip now matches the 40 px footer rhythm with compact, flat controls.
- Extended Clean mode to the remaining top-bar controls: flat icon buttons without scale-on-hover,
  borderless usage, RAM, profile and sync pills, and a lighter usage popover.
- Visible-pane calculations now run once per state update and are shared instead of running once per
  open pane.
- Off-screen terminal history loading is deferred until the pane becomes visible, and heavy TUI
  writes are processed in 16 KB chunks instead of 64 KB chunks.

### Removed

- The Merge Center is **out of this version and will return in a later one**. Out for now: its
  sidebar panel, the **Merge** tab of the project editor, the branch testing dialog, the merge store,
  and the `merge_analyze` / `merge_prepare` / `merge_finalize` / `merge_abort` /
  `merge_preflight_abort` / `merge_rebase_onto_target` / `merge_force_cleanup` backend commands,
  along with the `merge_analyzer` and `conflict_resolution` modules behind them. Projects do not
  carry a post-merge action setting in this version. Worktrees, the conflict-resolution agent
  settings and GSD Sync are untouched — they only shared the `merge.` prefix.
- Removed the optional GitHub repository clone field from the new-project dialog.
- Removed the Infinite Rainbow project-color option, its animated styles, and its workspace focus
  treatment. Existing invalid or retired accent values now fall back to a stable solid color.
- Removed the unused WebGL terminal rendering path and dependency. Terminals continue to use the
  Canvas 2D renderer without a behavior change.

### Fixed

- Panes running in a worktree now resume their conversation. A pane created with worktree isolation
  came back as a fresh agent every time the app reopened, with its history gone and its sidebar title
  never filled in, while panes in the repository root were unaffected. Claude folds a dot into a
  hyphen when it names a project's session directory, and worktrees live under
  `<repo>/.alethe/worktrees/<id>` — so the computed directory never existed, the pane never learned
  its real session id, and each reopen saved an empty session over the pointer to the real one.
- The left and right sidebars no longer come back collapsed. A collapsible panel closes itself
  whenever the layout squeezes it under its minimum width — which is what minimizing the window, or
  restoring it narrow, does to both sidebars at once — and nothing ever reopened them, so they stayed
  shut even though the saved preference still said they were open. They are now reopened whenever the
  window has room for them again.
- The left and right sidebars no longer close on their own. Closing the app tears the window down and
  the panel group reports one last zero-width layout on the way out, which was saved as if both
  sidebars had been collapsed by hand — so the next launch opened with both closed. Layout changes
  that arrive while the window is hidden are now ignored. Separately, dragging a separator until the
  sidebar collapsed left its "the user is resizing" flag stuck on, because a collapsed separator
  stops receiving pointer events and never saw its own release.
- Picking a server in the MCP manager's list now switches the detail panel. Opening the manager from
  a server row in the sidebar pinned the selection to that server: every click re-ran the effect that
  applies the requested server and snapped the list straight back.
- Continuing a Claude conversation in Codex no longer launches Codex with `--add-dir`, a Claude Code
  flag that Codex rejects on startup.
- A Codex pane that was not visible when it started now recovers from a busy session on its own. The
  bootstrap error is written and the process exits before the stream listeners exist, and a hidden
  pane never read the buffered output, so the retry that opens a fresh session never ran.
- Home now adapts to the width of the pane it is in, not the width of the window. Its layout was
  driven by window breakpoints, so opening Home in a narrow pane of a wide window kept the wide
  layout: the shortcut pills spilled outside the "new terminal / new project / new group" cards and
  the message count in the activity card ran over the word next to it. The sections now collapse on
  the space they actually have, long labels truncate instead of overflowing, and the big activity
  number scales with its card.
- Two paths inside the same parentheses are no longer underlined as one link. A path opened right
  after a bracket ran straight to the closing bracket, ignoring every space in between, so
  `(/pt-br/vitrine-dupla/projetos e /en/double-showcase/projects)` came back as a single link. The
  bracket now only caps the link instead of defining it, and each path is detected on its own.
- An extensionless path in terminal output no longer swallows the rest of the sentence as a link:
  `/pt-br/vitrine-dupla/trajetoria — 5 variações` used to underline the whole line. A space now ends
  the link unless a file extension is waiting on the other side, which is what a path with spaces
  actually looks like.
- Invalid CLI overrides are rejected instead of being saved and launched. Existing invalid overrides
  are cleared automatically, preventing the Antigravity desktop application from opening when Alethe
  expects the `agy` command-line executable.
- The agent update button in onboarding no longer fails silently. It decided success purely by
  checking whether the CLI binary was still on PATH, which is true even when the update itself
  failed (network error, permission denied, ...), since the previous binary is still there. The
  installer's real exit code is now checked first, and a failed update shows a toast instead of
  quietly leaving the CLI on its old version. It also now catches the case where the installer
  genuinely succeeds but a second, unmanaged install of the same CLI earlier on PATH shadows the
  one that was just updated: if the resolved binary's version hasn't moved, the update is reported
  as failed and the toast names the shadowing binary's path instead of reporting a false success.
- Antigravity no longer shows "Version unknown" forever in onboarding. Latest-version lookup only
  ever checked the npm registry, and Antigravity ships through a native installer instead of npm,
  so it never had a package to look up. It now falls back to the latest tag on its public GitHub
  releases when an agent has no npm package.
- A terminal that accepted keystrokes but rendered nothing — recoverable only by restarting it — now
  recovers on its own. Output is gated per PTY by a visibility flag, and the call that switches it
  back on was silently ignored whenever it landed while the session was spawning or restarting,
  leaving the stream off with nothing to turn it back on. The resource sampler now re-asserts
  visibility for every PTY on each pass, so a stuck stream clears within one sample instead of
  lasting until the terminal is restarted.
- An agent pane no longer loses the conversation it was resuming when you leave and come back to it
  quickly. The saved session was being read destructively at launch, so a pane torn down mid-launch —
  switching workspace tabs with Ctrl+Tab, for example — erased the only record of its conversation and
  came back on a different chat. The record now survives until a new session actually replaces it.
- The terminal "command not found" overlay was written in English regardless of the selected
  language; its text now goes through the translation system like the rest of the app.
- A pane no longer starts an empty chat when you come back to it after a long time away. The session
  claim that prevents two panes from writing to the same conversation was tied to the PTY id, so a
  PTY that ended on its own — parked by memory control, suspended, or killed — left the conversation
  permanently marked as taken and the pane silently dropped its own session id.
- Reopening a pane no longer replays its history line by line. The stored scrollback was fed to the
  terminal in 16 KB slices, one rendered frame each, so a large buffer visibly scrolled from the top
  down to the prompt and took seconds; it is now written in a single pass straight to the bottom.
- Switching conversation from inside the CLI with `/new` or `/resume` now sticks. Alethe pinned the
  session id given at launch and sent the old one back on the next restart, dragging the pane to the
  previous chat.
- Ctrl+Tab did nothing after coming back to the app from another window. Returning left the webview
  with no focused element, and WebView2 then kept the key for its own focus traversal instead of
  handing it to the app. Focus is now parked on the app shell whenever nothing else holds it, so
  every shortcut keeps working. Ctrl+Tab also focuses the first terminal of the tab it switches to,
  instead of switching with the keyboard pointed at nothing.
- Agent CLIs installed through Homebrew were invisible on macOS. An `.app` launched from Finder does
  not run as a login shell, so it inherits the minimal Launch Services PATH without `.zshrc` /
  `.zprofile`. Launcher discovery and the PATH rebuilt for terminals now include the default Homebrew
  prefixes (`/opt/homebrew/bin` and `sbin` on Apple Silicon, `/usr/local/bin` and `sbin` on Intel) as
  a fixed fallback.
- The Antigravity usage widget showed "—" on Linux. The OAuth token lookup used an explicit keyring
  target required by the Windows Credential Manager, which prevented the Linux Secret Service (GNOME
  Keyring / KWallet) from finding the entry written by the `agy` CLI. Credential discovery now
  supports both layouts and also looks for the `agy` binary in `~/.local/bin` and `~/.cargo/bin` on
  Linux and macOS.
- Pasting an image or files into a terminal did nothing on Linux, silently. `read_clipboard_payload`
  was implemented on Windows only and errored out everywhere else without falling back. A Linux/BSD
  backend using `wl-paste` / `wl-copy` (Wayland) or `xclip` (X11) now handles screenshots, images
  copied from the web (`image/png`) and files copied in a file manager (`text/uri-list`). macOS is
  still unimplemented.
- **Remote control is now off by default and stays off until you turn it on.** Alethe used to open a
  LAN listener on every launch, and the on/off switch was lost when the app restarted. The setting is
  now saved with your preferences and the listener only starts while it is enabled.
- The remote pairing address and QR code are only shown while a pairing window is open, and the
  address the phone uses is no longer carried in the page URL after pairing.
- Remote control session lifetime, the device limit, and per-device revocation now apply to the whole
  remote surface. They previously only guarded the live WebSocket, so an expired or revoked device
  could still read terminal output and send messages over HTTP.
- A paired phone now only receives output from the terminal it is watching. Every terminal's output
  was previously broadcast to every connected device.
- The remote workspace listing now sends only the fields the phone renders, instead of copying raw
  workspace records.
- Remote requests split across network packets are no longer truncated, oversized requests are
  rejected, and a failed request always gets a response instead of leaving the phone waiting.
- Remote connections now time out, are capped in number, must authenticate within ten seconds, and
  repeated bad tokens temporarily block the offending address — a device on the same network can no
  longer exhaust the app's connections.
- Remote control now re-reads the machine's network address every time it is enabled, so the pairing
  QR code stays valid after switching Wi-Fi networks.
- The **App icon** setting in Preferences → Appearance now actually changes the taskbar and window
  icon. It previously sent the bundled asset URL to the native window, which silently failed, so the
  icon never left the default variant. Each icon now ships at 32, 48, and 64 pixels and the variant
  matching the display scaling is used, so the taskbar no longer shows a blurry downscale.
- Submitting `/new` in an agent terminal now clears both the visible conversation and its persisted
  terminal scrollback, so the fresh session no longer inherits the previous conversation on screen.
- Terminals now recover automatically when a native PTY write stalls instead of blocking every
  later keystroke until a manual refresh, and use the stable xterm DOM renderer to avoid a renderer
  transition race that could leave the terminal unable to accept input.
- Large terminal pastes now use bounded high-throughput IPC chunks, preserve Unicode boundaries, share
  the normal input queue, skip synchronous per-character prompt-history work, and always close
  bracketed-paste mode after partial failures. This prevents Claude Code and Codex pastes from freezing
  the app, interleaving with typing, or stopping halfway.
- Native browser panes now remain hidden for the full lifetime of modal and menu overlays, including
  closing animations, preventing them from flashing above or interfering with dialogs.
- Opening a terminal's tabs lane now moves only its left floating identity to the right, while the
  existing right-side actions remain anchored in place. The pane drag handle moves into the lane,
  directly above its tab items, so it no longer covers terminal content.
- Fixed the freezes and runaway memory growth introduced with the new sidebar. The conversation
  title shown on each session row was rescanning and fully parsing every Claude session file of the
  project — up to hundreds of MB — every 12 seconds, on the thread that serves the whole UI. Rows
  now read only their own session file, off the main thread, and stop once the title is known.
- Session scans no longer load a whole record into memory, so a single oversized message can no
  longer abort the app with an out-of-memory error and take every open terminal down with it.
- Closing the app no longer crashes or becomes unresponsive mid-shutdown. Process-tree cleanup now
  runs outside the native event loop, while a frontend deadline destroys the window if the native
  quit request does not settle, so slow Windows process termination cannot hold the interface open.
- The corrected Windows installer now identifies itself as 1.5.1 so it reliably upgrades existing
  1.5.0 installations instead of entering same-version maintenance mode.
- Sidebar visibility and widths now change only after explicit user input, so startup and automatic
  layout adjustments cannot close a sidebar or overwrite its saved size; pending workspace changes
  are also flushed before the native window closes.
- Prevented private browser panes from failing to start when development-mode effect remounts
  briefly overlap while a previous native webview is closing.
- Fixed the Git initialization button contrast across accent colors by using the theme's matching
  foreground token.
- Fixed project-name overflow so long paths use a clean ellipsis without colliding with status
  badges in either visual style.
- Fixed backup imports by excluding locked WebView runtime caches, ignoring those entries in legacy
  archives, validating the archive before deleting local data, and closing active terminals before
  restoration.
- Clean sidebar group headers now only expand or collapse the tree instead of also adding every
  project in the group to the workspace.
- GitHub repository cloning no longer depends on a hardcoded `D:\Projects` directory. The selected
  destination is now respected, with `~/Alethe/<repository>` as the cross-platform fallback.
- Background agents now report completion through the lightweight off-screen activity channel.
- Lightweight background output is accumulated between updates instead of being discarded, so
  activity detection and Codex busy-session recovery remain reliable off screen.
- Output written while an agent pane restores its history is replayed after the restore instead of
  leaving a permanent gap.
- Remote Control no longer drops accented characters when a UTF-8 sequence crosses a buffer cut.
- Memory-pressure spawn blocking now queues every new request. The reduced concurrency ceiling only
  controls how many existing waiters may be released.
- Synchronized the bundled GSD plugin version with its actual v11 content so older worktrees receive
  automatic updates.
- Main terminals can no longer claim a GSD child conversation merely because GSD monitoring was
  disabled after its sentinel file had been created.
- New GSD plugin instances clear stale synchronization markers left by crashed or closed processes.
- Terminal hover and click coordinates are remeasured after app zoom changes, keeping xterm.js link
  detection aligned with the pointer.
- Development builds on Linux now also apply the Alethe icon at runtime. Packaged builds remain the
  reliable icon source for compositors that prefer desktop-file lookup.
- Linux now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before creating the webview, avoiding the known
  WebKitGTK DMA-BUF animation and fractional-scaling issues documented by Tauri.
- Linux animations now prefer compositable properties and avoid `transition: all` and animated width.
- GSD child sessions are read-only across xterm input, paste, prompt history, and force-kill shortcuts.
- OpenCode no longer emits unsupported OSC 66 width queries in xterm.js because spawns set the
  documented `OPENTUI_FORCE_EXPLICIT_WIDTH=false` compatibility flag.
- OpenCode redraw nudges after spawn and resize now share a 400 ms lock, preventing overlapping TUI
  redraws.
- The `windowsPty` xterm.js option is now enabled only on Windows, fixing dense TUI redraws on Linux
  and macOS.
- Scrollback resynchronization now cuts only at valid UTF-8 character boundaries.
- Conflict-resolution model selections are no longer overwritten by background project updates while
  the edit dialog is open.
- The full project form now inherits a folder selected on the empty-workspace screen, and truncated
  paths expose their complete value on hover.
- Git initialization and refresh actions use consistent full-width stacking in narrow sidebars.
- Windows orphan-process cleanup now logs Job Object failures, records root processes, and cleans
  verified leftovers after an unclean shutdown.
- Merge diff summaries and test briefings now include uncommitted worktree changes, not only commits
  between branches.
- GSD Sync sessions now appear in Tasks for OpenCode terminals even when worktree isolation is off.
- GSD test procedures include files committed on the current worktree since it diverged from
  `main` or `master`.
- Provider model search no longer pollutes another provider's cache during rapid switching, preserves
  one selection per provider, and accepts custom searched models with Enter.
- Off-screen agent terminals no longer render full output continuously. They receive lightweight
  activity updates and restore complete scrollback immediately when shown, without pausing agents.
- Migrating existing terminals now restarts each live pane in its new worktree instead of leaving the
  visible process in the old directory.
- Worktree migration now reinstalls GSD monitoring and uses the latest unsaved project configuration.
- Enabling GSD monitoring creates a missing `.planning/` directory instead of failing silently.
- The **Open folder as project** button now uses a visible text color in every theme.
- Terminal hover links now support mixed-case protocols such as `Https://` and bare deployment
  domains such as `example.vercel.app`, while excluding file names and email addresses.
- Workspace panel sizes now persist per profile and workspace screen for outer project containers and
  nested terminal splits in Auto, Spotlight, and Sidebar layouts.
- Sidebar drag-and-drop now keeps list geometry stable, separates reordering from group nesting, and
  uses theme-native insertion lines and subtle neutral targets.
- The topbar widgets no longer jump sideways when you hover them. The pencil button that opens the
  widget settings used to expand from zero width on hover, pushing every pill 26px to the left —
  enough for the pill you were reaching for to slide out from under the cursor, which dropped the
  hover, collapsed the button and shifted everything back, flickering in place. Its slot is now
  reserved at all times and only the button itself fades in.

## [1.5.0] — 2026-08-09

### Added

- Added authenticated LAN Remote Control for browsing agent chats, watching live output, and sending
  one message at a time from a mobile browser.
- Added Remote Control enable and disable controls, device limits, token regeneration, named devices,
  session metadata, one-hour default expiry, and individual revocation.
- Added Agent Sandbox job and thread identifiers, structured spawn acknowledgements, persistent Codex
  app-server threads, parent-to-worker relationships, and reply relay back to the Claude planner.
- Added persistent Agent Sandbox projects with project folders, live session restoration, project
  switching, on-demand workers, and regular project terminal synchronization.
- Added regular shell workers to Agent Sandbox so long-running development servers remain visible as
  plain terminal panes.
- Added development and installer icon themes independent from the interface theme.
- Added **Erase all data (fresh install)** after backup export for a complete local reset.

### Changed

- CLI detection during onboarding is time-boxed per provider so slow PATH entries cannot freeze setup.
- New profiles reach onboarding cleanly, and parking terminals no longer blocks account switching.
- The default profile image and generated app icons now use the dark Alethe artwork.
- Agent Sandbox project creation entry points are hidden behind a build flag while the feature is
  archived.
- The startup screen now shares the Home background and ASCII-art treatment.
- Profile export now includes the complete profile, including Todos, history, metrics, preferences,
  tokens, scrollback, and all other stored data.
- Account switching closes each pseudoconsole before waiting for its final scrollback flush and can
  resume parked sessions without restarting the app.
- The Accounts modal has clearer hierarchy, spacing, and profile creation controls.
- Project dropdowns use the Todo List's viewport-safe portal behavior, path containment, truncation,
  Escape handling, and consistent styling.
- Concurrent panes cannot resume the same Codex conversation, and active-writer errors split across
  output chunks recover reliably.
- Agent Sandbox workers run unrestricted and non-interactively by default. Claude uses
  `--dangerously-skip-permissions`; Codex uses unrestricted approvals.
- Sandbox workers use readiness-aware prompt delivery, delayed bracketed paste, separate submission,
  settle detection, deadline fallback, and supported prompt arguments.
- Automated Claude and Codex workers default to Haiku where applicable, preserve their own working
  directories, skip Codex trust checks for the selected Sandbox folder, and report structured errors
  without exposing task text.
- Automated workers move from Working to Done or Error based on streamed output, while submitted
  prompts are cleared to prevent duplicate execution after HMR.
- Sandbox stop and project-switch operations invalidate in-flight spawns, and startup failures release
  the retry guard.
- Windows Sandbox path comparison is case-insensitive and ignores trailing separators.
- Agent Sandbox panes use the same terminal headers, dimensions, backgrounds, and xterm surface as
  regular workspace terminals, with resize and Focus mode support.
- The real planner-to-worker proof of concept replaces mocked communication: Claude plans, Codex works,
  and `/spawn` creates a visible terminal in the session.
- Development-only Welcome, Theme Picker, and Redo Onboarding actions are hidden in production.
- New users receive the default purple avatar when they do not select a custom image.
- Todo items now animate on entry, hover, drag, and reorder targeting.
- Markdown viewer comments and their shortcut are temporarily disabled while the feature is repaired.
- Empty-workspace defaults, disabled-button contrast, sidebar drag previews, and sidebar transitions
  received clearer visual feedback.
- Agent Sandbox evolved from a temporary draggable PTY demonstration into a full-screen, compact,
  design-system-aligned terminal canvas with real providers and messaging.
- Sidebar drop targets now exist only during an active DnD-kit drag.
- Top bar controls, tabs, status pills, and window actions now share consistent spacing, height, and
  radius values; the customization control no longer reserves space while hidden.
- Remote WebSocket clients authenticate before counting toward limits, bind to the selected LAN
  address, strip control characters, and receive restrictive security headers.
- Remote addresses remain hidden behind a generic placeholder until QR pairing completes.
- Form dropdowns now use the compact 32 px system-wide standard.
- Remote security policy, session lifetime, LAN status, and device revocation moved to a dedicated
  Preferences category, leaving the QR dialog focused on quick access.

## [1.4.1] — 2026-08-07

### Fixed

- Corrected release notes in the **What's New** dialog and GitHub release so they use this repository's
  `CHANGELOG.md` instead of a stale external copy.

## [1.4.0] — 2026-08-07

Graphify became optional, the `alethe` command gained direct project opening, and this release delivered
a broad stability and security pass across AgentCanvas networking, image paste, session restoration,
memory controls, and Linux/macOS parity for Antigravity and OpenCode.

### Added

- Added an optional Graphify preference without rewriting agent MCP configuration.
- Added the `alethe` terminal command to open the current or selected directory in the existing app
  window, creating a project only when necessary.
- Added documented code standards and ESLint/Prettier commands.
- Added double-click file opening from File Explorer and monospaced diff panes from Git Control.
- Added **About & Updates** with installed-version details, update checks, download progress, visible
  errors, and a sidebar version shortcut.
- Added real Merge Center review: project validation commands, dedicated reviewer agents, direct
  feedback delivery, heuristic API-contract checks, stack detection, and isolated live health probes.
- Added in-app Git repository initialization with a safe initial commit for features that require Git.
- Added a GSD Planning Completion Gate that always leaves accept, review, and reject decisions available
  to the user and exposes real validation failures.
- Added automatic OpenCode GSD state maintenance for `task.md`, `status.md`, and `progress.md`, plus an
  isolated child session for `goal.md`, `plan.md`, and structured test procedures.
- Added double-click Focus mode for every pane title.
- Added configurable GSD Sync model fallback chains based first on the model that just succeeded in the
  parent conversation.
- Added a project-scoped, read-only GSD Sync viewer with passive completion indication; it was later
  moved into the Tasks sidebar.
- Added code-aware GSD validation planning based on the real changed-file list and structured
  preparation, action, and verification steps in `.planning/procedure.json`.
- Added broader GSD activity triggers so edits and shell work synchronize even without a native task
  list update.
- Added a pre-spawn system-memory headroom check with a 45-second upper bound.
- Added prominent Git initialization to the sidebar and project editor, including empty-repository
  commits and transparent initialization before isolated-agent worktree creation.

### Changed

- GSD Sync sessions moved from a separate right-side drawer into the existing Tasks sidebar.
- Internal quality work moved project persistence off Tokio's blocking path, reduced Ghostty polling,
  consolidated provider session and usage helpers, and standardized the Claude Code label.
- Terminal themes moved from the Terminal settings page to Preferences → Appearance.

### Fixed

- Secured the AgentCanvas local HTTP listener with a per-launch `X-Alethe-Token` and limited request
  bodies to 1 MB.
- Closed sidebars no longer reserve width in the main content area; only top-bar control space remains.
- Stabilized the pane-area Zustand fallback to prevent React #185 during project hydration.
- Disabled unstable xterm.js WebGL rendering in the Windows WebView to avoid teardown races.
- Sidebar resize persistence no longer rebuilds `defaultSize` during the resize event.
- GSD test briefings are scoped to the files changed in the current session and exclude Alethe-generated
  `.opencode/`, `opencode.json`, and `.planning/` infrastructure.
- Graphify and GSD setup commands now run on blocking worker threads instead of freezing Tauri IPC when
  spawning agents.
- PTY write, resize, suspend, kill, and process-tree termination no longer block the Tauri dispatcher or
  hold the global session lock during slow work; process kills have a three-second timeout.
- GSD planning gates skip unsupported providers, install monitoring retroactively for existing OpenCode
  worktrees, and replay task updates queued during an active synchronization cycle.
- Multi-Agent telemetry continues after receiver lag and displays real load failures.
- Onboarding agent detection no longer gets stuck under React StrictMode, and CLI/model discovery runs
  on blocking workers with a six-second per-agent safety limit.
- The Multi-Agent & Telemetry page now reads real `.planning/task.md` data, removes the non-functional
  plugin manager, and routes all visible text through localization.
- The Merge Center has its own maximum height and scroll area so multiple cards cannot push the project
  list out of view.
- Rejecting or accepting worktrees now stops agent processes before deletion, runs Git operations on
  blocking workers, and tracks cleanup failures as recoverable orphaned worktrees.
- Concurrent GSD Sync polling merges only entries resolved by each poll instead of replacing shared
  state, preventing child sessions from flickering or disappearing.
- PTY spawn and scrollback attachment now run on blocking workers so one slow terminal cannot freeze all
  app IPC.
- Deleting a worktree agent also deletes its hidden GSD viewer terminal and PTY.
- Repository-root discovery excludes GSD viewer panes and can resolve the shared Git root from any
  existing worktree.
- GSD viewer panes trust Alethe-tracked child session IDs that OpenCode intentionally omits from normal
  session listings.
- Merge Center **Accept** now performs the real analyze, prepare, resolve, validate, and fast-forward
  merge flow; **Reject** removes the worktree while preserving its branch.
- Automatic worktree isolation applies only to new agents. Existing terminal migration is explicit,
  suspends the PTY, checks uncommitted changes, and reports complete, partial, or failed results.
- Existing-terminal migration validates that the folder is a Git repository before doing any work and
  shows the localized isolation warning instead of a raw Rust error.
- Git initialization seeds a `.gitignore` for common generated and secret directories before staging,
  preventing `node_modules` and similar trees from freezing the app.
- Windows verbatim `\\?\` prefixes are removed from worktree and merge paths before they reach shells,
  session matching, or PTY spawn.
- Session detection for isolated OpenCode, Codex, and Antigravity agents keeps retrying while the
  terminal remains open instead of expiring after 30 seconds.
- New Terminal and Home quick-launch paths once again provision worktrees when automatic isolation is
  enabled and surface provisioning failures in a toast.
- New isolated worktrees always derive from the real repository root instead of nesting under the most
  recently used worktree.
- Test Briefing now shows the real branch file diff and actual validation command results.
- The default Merge Center badge now says **Awaiting action** instead of claiming review readiness.
- Image paste works again for OpenCode, Claude Code, and Codex from screenshots, web images, and Explorer
  files by sending a file path to the PTY.
- Antigravity CLI detection now checks the real `agy` binary on Linux and macOS.
- Closing or restarting terminals now kills complete process trees on Linux and macOS as well as
  Windows.
- Working-directory comparison is centralized and only normalizes case and separators for Windows
  paths.
- Keyboard shortcut labels follow the active platform consistently across Home and the sidebar.
- OpenCode panes claim, persist, and resume their own session IDs instead of falling back to another
  pane's most recent conversation.
- Antigravity sessions use each conversation's timestamp and compare directory boundaries correctly.
- OpenCode directory matching remains case-sensitive on Linux and macOS.
- Enabled `@xterm/addon-unicode11` so emoji and symbol widths match terminal applications.
- **Resume last session** restarts agents through the normal spawn queue and memory supervisor, with
  confirmation when multiple panes will restart.
- The implemented Antigravity usage card now appears in AI Usage Details.
- Antigravity credentials are read from the exact `gemini:antigravity` Windows Credential Manager target
  as UTF-8, allowing real quota display.
- Protected xterm.js renderer changes, writes, and scrolling against disposed-renderer races after
  graphics context loss; PTY suspension now removes the session only after shutdown confirmation.
- Merge Center cards now truncate long status, branch, and action text correctly in narrow sidebars.
- Missing OpenCode sessions with a server-assigned `parent_id` are treated as inconclusive instead of
  being discarded as orphaned.
- Rainbow container borders now draw inside the box with the correct radius, showing the full edge
  animation instead of only the corners.
- Closing Tasks no longer collapses the left Merge Center sidebar after removal of the old GSD drawer.
- A broad silent-failure audit moved Git/session/agent/backup operations off the Tauri dispatcher,
  preserves corrupted metrics instead of overwriting them, exposes restart and hook failures, and keeps
  GSD polling alive when one session fails.

## [1.3.0] — 2026-07-27

This release integrates multi-provider Graphify and macOS contributions, redesigns Home, loading, and
the sidebar, and adds Antigravity support.

### Added

- Added multi-provider Graphify as an MCP server for Claude, Codex, and OpenCode, with a per-project
  graph viewer, project configuration, non-destructive config merging, and graph snapshots.
- Added an opt-in native Ghostty terminal backend on macOS through an NSView layered over the WebView.
- Added AppKit-level rounded window corners on macOS.
- Added Antigravity (`agy`) CLI detection, spawn and resume by conversation, session discovery, and a
  dedicated usage widget.
- Added experimental window opacity control.

### Changed

- Strengthened merge and worktree state with monotonic `projects.json` writes, Git-lock classification,
  backoff, orphan tracking and cleanup, and an auto-finalizing merge state machine.
- Added macOS Keychain discovery for Claude tokens and prevented `EDITOR=vi` from leaking from npm into
  development shells.
- Redesigned Home with interactive ASCII artwork, smooth dashboard transitions, a mini-terminal quick
  launcher, a compact Spotify dock, clearer usage and focus panels, and real streak/activity data.
- Rebuilt the loading screen with animated Alethe ASCII branding and dot-matrix progress.
- Reorganized the Projects sidebar around a fixed active-project card, a flat project list, colored
  monograms, always-visible menus, activity indicators, and reduced metadata clutter.
- Terminal links now exclude explanatory text, input failures recover the PTY, Codex restart preserves
  the conversation, and input focus recovers after mounting, interaction, or graphics loss.
- Unrestricted mode became a prominent one-click control in the Add AI dialog.
- Memory management now monitors by default; intelligent LRU behavior requires explicit opt-in.
- The new-terminal dialog gained card selection, a prominent folder field, and recent-folder shortcuts.
- Automatic resume removes orphaned Claude, Codex, and Antigravity conversation IDs before spawn.

### Fixed

- Windows paths are escaped correctly as TOML strings in `graphify_codex_config_write`.
- The merge finalization fallback stops polling after entering a failed state.

### Removed

- Removed the **Loose/Ungrouped** section label above ungrouped sidebar projects.
- Removed the parked-terminal text notice from the overlay; the resume action remains available.

[Unreleased]: https://github.com/Kc1t/alethe-agents/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Kc1t/alethe-agents/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/Kc1t/alethe-agents/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/Kc1t/alethe-agents/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Kc1t/alethe-agents/releases/tag/v1.3.0
