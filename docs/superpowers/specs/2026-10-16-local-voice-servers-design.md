# Local voice servers for narration — Design

Date: 2026-10-16
Status: approved in conversation (sections 1–3); spec awaiting review.
Related: `2026-10-16-hf-model-search-design.md` (which hides PyTorch-only models such as Chatterbox
and Fish Speech, because the embedded sherpa-onnx engine cannot run them).

## 1. What this is

Narration gains a new provider kind: **local voice servers**. The person runs a text-to-speech
server themselves (Chatterbox, Fish Speech, Kokoro-FastAPI, openedai-speech, LocalAI, …) on this
computer or on another machine in the local network, and Alethe sends it text over HTTP and plays
the audio it returns.

Why: the most natural open models (Chatterbox, Fish Speech, XTTS) need Python and PyTorch, usually a
GPU. Bundling that would add gigabytes, one build per GPU stack, and a large RAM footprint to a
small Rust app. Talking to a server the person already runs keeps Alethe light and lets people with
a GPU get the better voices.

## 2. Decisions

Made in conversation:

1. **Two server kinds**: `openai` (any server with an OpenAI-compatible `POST /v1/audio/speech`:
   chatterbox-tts-api, Kokoro-FastAPI, openedai-speech, LocalAI) and `fish` (Fish Speech's native
   `POST /v1/tts`).
2. **Voices are chosen by id.** Reference audio for cloning is configured on the server itself (Fish
   references, chatterbox-tts-api voice library). Alethe never uploads audio.
3. **Loopback and local network only.** Loopback and private addresses are accepted; public
   addresses are refused. Plain HTTP is allowed for these hosts.
4. **A list of servers.** Each saved server is its own choosable narration source.
5. **Approach A**: a new `server` provider plus a `server` field in the narration choice. The server
   list lives on the Rust side; the webview only ever passes a server id, never a URL.

## 3. Non-goals

- Speech to text through local servers (narration only).
- Uploading reference audio or managing voices on the server.
- Starting, stopping or installing the Python server from Alethe.
- Discovering servers or ports automatically.
- Public or remote HTTPS endpoints (those belong to cloud providers).
- Streaming responses; each chunk is one request and one complete audio reply.

## 4. Data model and storage

### Rust store

New module `src-tauri/src/voice_servers/`:

- `store.rs` — the server list, per profile, at `{profile data dir}/voice-servers.json`:

  ```json
  { "version": 1,
    "servers": [
      { "id": "5b0c…", "name": "Chatterbox (home)", "kind": "openai",
        "baseUrl": "http://localhost:4123", "model": null } ] }
  ```

  `id` is a UUID v4 generated on create. `model` is optional and only used by the `openai` kind.
  Writes are atomic (tmp → rename), as for `projects.json`. A missing file is an empty list; a
  corrupt or unknown-version file is logged and read as an empty list (it is not overwritten until
  the next save). At most 32 servers; names at most 64 characters.
- The optional API key lives in the OS keychain, never in the JSON. `SecretKind` gains
  `VoiceServerKey(String)` (the server id); its account suffix becomes owned
  (`voice-server-{id}`). Reads go through the same blocking-thread, read-once cache pattern as
  `keys.rs`. Deleting a server deletes its key.

### Commands

| Command | Does |
|---|---|
| `voice_servers_list()` | The list, each with `hasKey` (never the key). |
| `voice_servers_save({ id?, name, kind, baseUrl, model?, key? })` | Create or edit. Validates the URL (section 5) and the key format (`validate_key`). `key: ""` removes the key; absent leaves it. Returns the saved entry. |
| `voice_servers_delete(id)` | Removes the entry and its key. |
| `voice_servers_test(id)` | Health check plus voice listing; returns `{ status, voices }`. |
| `voice_servers_voices(id)` | The voice ids the server reports (may be empty). |

### Narration choice

- `TtsProviderId` gains `'server'`; `TtsChoice` gains `server: string | null`.
- `normalizeTtsChoice` (in `src/lib/voice/voicePreferences.ts`) backfills `server: null` and drops a
  `server` provider whose `server` is not a non-empty string back to the default choice.
- Rust `TtsProvider` gains `Server`; `tts_speak` and `tts_voices` gain `server: Option<String>`.
- When the chosen server no longer exists, narration uses the system voice (section 8) and the UI
  shows a warning.

## 5. Network policy

New pure module `src-tauri/src/voice_servers/netpolicy.rs`.

A base URL is accepted when:

- the scheme is `http` or `https`;
- it has a host, and no userinfo, query or fragment; a path is allowed (for servers behind a
  prefix) and a trailing `/` is removed;
- every address the host resolves to is allowed.

Allowed addresses: `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`fe80::/10`, `fc00::/7`. Everything else is refused, explicitly including `169.254.0.0/16`
(cloud metadata), `0.0.0.0`, `::`, multicast and public addresses. A host that resolves to any
refused address is refused as a whole (`localhost.evil.example` resolving to a public IP fails).

The check runs when saving **and** before every request. Each request pins the connection to the
checked address with `reqwest::ClientBuilder::resolve`, so DNS rebinding between check and connect
cannot redirect it. The client never follows redirects and has its own instance; the cloud client
stays `https_only`.

The UI shows a notice when the resolved address is not loopback: text sent to the server crosses
the local network, unencrypted when the URL is `http`.

## 6. Adapters

`src-tauri/src/voice_servers/openai.rs` and `fish.rs`: pure request builders and reply parsers,
sharing a small sender in `client.rs`.

| | OpenAI-compatible | Fish Speech |
|---|---|---|
| Speech | `POST {base}/v1/audio/speech` `{ model, input, voice, response_format: "mp3", speed }` | `POST {base}/v1/tts` `{ text, reference_id, format: "mp3", normalize: true }` |
| Model | saved `model`, else `"tts-1"` | — |
| Voice | choice `voice`, omitted when null | `reference_id`, omitted when null |
| Speed | sent as `speed`, played at 1.0 | not sent, applied at playback (as OpenRouter) |
| Health | `GET {base}/v1/audio/voices`, then `GET {base}/voices`, then `GET {base}/v1/models` | `GET {base}/v1/health` |
| Voices | `GET {base}/v1/audio/voices`, then `GET {base}/voices` | `GET {base}/v1/references/list` |
| Auth | `Authorization: Bearer {key}` when a key is saved | same |

Some OpenAI-compatible servers ignore `speed` (chatterbox-tts-api documents no such field); for
those the rate setting has no effect. This is accepted rather than resampling, which would change
the pitch.

Voice parsing is tolerant: a JSON array of strings; `{ "voices": [...] }`; objects with `id`, `name`
or `voice_id`; Fish's `{ "reference_ids": [...] }`. Duplicates are removed, order kept, at most 500
ids, each at most 128 characters. Anything else reads as an empty list (free-text voice field).

Audio decoding reuses `decode_mp3` from `tts_cloud.rs`, extended to sniff WAV (`RIFF….WAVE`) and
decode it too; `symphonia` gains the `wav` and `pcm` features. Replies are capped at 50 MB.

## 7. Narration flow

`tts_speak` with `provider: "server"`:

1. Looks the server up by id. Missing → system voice, `voice://fallback` with reason `missing`.
2. Spawns `speak_server`, shaped like `speak_cloud`: chunks of 400 characters
   (`split_for_tts_spans`, so the first sentence plays early), 120 s timeout per chunk, playback
   and progress through the shared player.
3. A failure before any audio played hands the whole text to the system voice under the same
   utterance id; a failure mid-utterance stops where it is.

`voice://fallback` carries `{ usage: "narration", provider: "server", server: id, reason }`.

## 8. Errors

`ServerErrorKind`, surfaced as `voice_server_{kind}` codes and translated in the UI:

| Kind | When |
|---|---|
| `policy` | URL or resolved address outside section 5 |
| `network` | connection refused, unreachable, server off |
| `timeout` | 120 s per chunk exceeded (10 s for test and voice listing) |
| `auth` | HTTP 401 or 403 |
| `badRequest` | HTTP 400, 404 or 422 (unknown voice, text too long, wrong kind) |
| `badAudio` | reply is not MP3 or WAV, fails to decode, or exceeds 50 MB |
| `missing` | server id not in the list |
| `other` | anything else |

Logs and events carry the server id and error kind only — never the URL, key, response body or the
narrated text.

## 9. User interface

All strings through `t()` in en, pt-BR and zh-CN. Tokens only, no gradients, one `.module.css` per
component.

**Voice page → provider grid**: a new group **"Local servers"** between "On this computer" and
"Cloud". One card per saved server (name, kind, host, status: Online / Offline / Not tested), then
an **"Add server"** card.

**Server detail** (`ServerDetail.tsx`), opened from a card:

```
← Voice / Chatterbox (home)
Kind      [OpenAI-compatible ▾]          (OpenAI-compatible | Fish Speech)
Name      [Chatterbox (home)        ]
Address   [http://localhost:4123    ]    e.g. Chatterbox 4123 · Fish 8080 · Kokoro-FastAPI 8880
Model     [                         ]    (OpenAI-compatible only; optional)
Key       [••••••                   ]    optional, stored in the system keychain
          [Test connection]  ● Online · 12 voices
Voice     [pt-ref ▾]  (free text when the server lists none)
          [Use for narration]                          [Remove server]
Notice (non-loopback): Narrated text crosses your local network.
```

- Address errors show inline ("Only addresses on this computer or your local network").
- Test states: testing, online with N voices, offline, refused by policy, key rejected, error.

**Narration panel** (`NarrationPanel.tsx`): saved servers appear in a new "Local servers"
`ProviderGroup`. Picking one patches `{ provider: 'server', server: id, model: '', voice: null }`;
voices load through `ttsVoices('server', undefined, id)`. An empty list shows a free-text voice
field.

**In-use summary** (`VoiceInUseSummary.tsx`): shows the server's name; a deleted server shows
"Server removed — using the system voice".

**Live fallback**: the existing `voice://fallback` notice, with the text "Local server unavailable —
using the system voice".

New frontend pieces (names indicative): `ServerDetail.tsx`, `ServerCard` (or a `ProviderCard`
variant), `useVoiceServers.ts`; Tauri wrappers in `src/lib/tauri/voiceServers.ts`; types
`VoiceServer`, `VoiceServerKind` in `src/lib/types.ts`.

## 10. Testing

Rust:

- `netpolicy`: table of cases — loopback v4/v6, each private range, link-local v6, `169.254.x`,
  `0.0.0.0`, public v4/v6, a host resolving to mixed allowed and public addresses, userinfo, query,
  fragment, `file:`/`ftp:` schemes, trailing slash and path prefix.
- Adapters: built JSON bodies and URLs (no double slash) for both kinds, with and without voice,
  model and key; voice parsing against fixtures captured from Kokoro-FastAPI, chatterbox-tts-api and
  Fish `references/list` in `src-tauri/src/voice_servers/testdata/`.
- Decoding: WAV and MP3 sniffing, garbage reads as `badAudio`.
- Store: round trip, atomic write, corrupt file reads empty and is not overwritten, delete removes
  the key (fake `SecretStore`).
- `speak_server`: fallback on missing server and on a fake HTTP server bound to `127.0.0.1` that
  returns 500 on the first chunk.

Frontend (vitest):

- `ServerDetail`: validation, test states, LAN notice, remove.
- `NarrationPanel`: picking a server, voice list, free-text voice when the list is empty.
- `normalizeTtsChoice`: `server` backfill and invalid `server` choices.

`npm run build` enforces the three locales.

## 11. Documentation

- `docs/CHANGELOG.md` `[Unreleased]`: local voice servers for narration.
- `docs/VOICE.md`: a "Local voice servers" section — kinds, network policy, key storage, fallback.
- `docs/FEATURES.md`: the feature entry.
