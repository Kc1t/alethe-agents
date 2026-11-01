# 004 — Graphify stays an external tool that Alethe manages

**Status:** Accepted · **Code:** `src-tauri/src/graphify.rs`

## Context

Agents work better with a map of the codebase. Graphify already builds that map as a knowledge
graph. Reimplementing it inside Alethe would duplicate a moving external project.

## Decision

Alethe manages and observes Graphify; it does not reimplement it. It has three jobs:

1. **MCP integration:** write a per-project MCP config that injects the Graphify server into an
   agent session.
2. **Read and normalize the graph:** parse `graphify-out/graph.json` in Rust into `{ nodes, edges }`
   for Cytoscape, with a node cap so the webview stays responsive.
3. **Versioning and retention:** snapshot, list, diff, and roll back `graph.json` under
   `<repo>/.alethe/graph-snapshots/`, and prune old snapshots.

## Consequences

- The Graphify CLI is a runtime dependency the user installs; Alethe must handle it being absent.
- Heavy parsing happens in Rust, so the frontend only receives a bounded, ready-to-draw graph.
- A successful merge triggers a best-effort snapshot (see [006](006-merge-analyzer.md)).
