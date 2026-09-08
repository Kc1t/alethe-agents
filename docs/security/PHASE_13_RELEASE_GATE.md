# Phase 13 Gate — Test and Release

## Status

Release preparation only. No commit, tag, installer publication, production deployment, or release
was authorized or performed.

## Automated evidence available

- Production frontend/i18n build.
- Frontend unit and web-launcher suites.
- Complete Rust library suite, including Phases 3–11.
- Cloudflare service typecheck and protocol tests.
- Wrangler dry-run bundle.
- Local real Worker challenge/authentication/discovery test and encrypted-envelope delivery between
  two different opaque account routes.
- Provider-neutral Desktop/Web route implementations.

## Mandatory gates still requiring external state

- Cloudflare staging deployment and the full matrix from `PHASE_10B_SECURITY_GATE.md`.
- Two-machine remote invitation and P2P negotiation with real encrypted envelope consumption.
- Multi-network NAT/firewall/IPv4/IPv6/reconnect and long-idle soak tests.
- Desktop/Web real-UI E2E for collaboration activation and access-center behavior.
- Supported-platform installer smoke tests.
- External security review and closure of every critical/high finding.
- Owner approval of endpoint, privacy disclosure, retention, incident response, support, migration,
  rollback, signing, release version, and infrastructure budget.

Release tooling must keep `ALETHE_RENDEZVOUS_ENDPOINT` and all deployment secrets environment-injected.
No secret may be written to `tauri.conf.json`, a frontend environment variable, the repository, an
installer resource, logs, diagnostics, or release notes.
