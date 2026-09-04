# Alethe Cloudflare rendezvous adapter

This package is the optional control-plane service described by `ADR-0002`. It routes opaque
device presence, encrypted invitation/candidate envelopes, and delivery acknowledgements. It
must never receive OAuth credentials, device private keys, paths, project/file names, project
content, task content, or chat plaintext. Project data continues over authenticated peer
transport.

## Local verification

```powershell
npm install
npm run build
npm test
npm run dev
```

Local development uses a local-only abuse hash fallback. Staging and production must configure a
random `ABUSE_HASH_KEY` with `wrangler secret put ABUSE_HASH_KEY --env <environment>`. The Worker
HMACs Cloudflare's connecting-IP signal before the account Durable Object sees it; the raw IP is
never persisted and is never treated as identity.

`GET /v1/info` is public compatibility discovery. `GET /v1/connect?accountRoute=<64-hex>` must be
upgraded to WebSocket. A random challenge is sent immediately; the client signs the canonical
challenge binding with its existing Ed25519 device identity before any other frame is accepted.

## Deployment boundaries

- `staging` and `production` are separate Workers and Durable Object namespaces.
- Wrangler/API credentials belong only in the operator environment; never add them to this
  directory, the desktop bundle, source control, logs, or support diagnostics.
- Deploying staging or production is an explicit operator action. Application builds do not run
  either deploy script.
- Before production, run the staging matrix in `docs/security/PHASE_10B_SECURITY_GATE.md`, confirm
  retention/deletion, configure quota alerts and a paid-plan budget, capture rollback evidence,
  and obtain owner authorization.
- Roll back code with a known-good Worker version. SQLite schema changes must be forward-compatible;
  destructive migrations require state export and a separate reviewed migration.

Cloudflare Free is a development/startup allowance, not a permanence guarantee. Provider quota
or suspension must degrade only rendezvous-backed features; local Alethe and established authorized
peer sessions remain available.
