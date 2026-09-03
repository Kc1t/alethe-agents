---
name: graphify-query
description: Query the Graphify knowledge graph (graphify-out/) for this repo's architecture, god nodes, community structure, and cross-file relationships — use for codebase-structure questions instead of raw grep/source browsing.
---

# Graphify

This project has a knowledge graph at `graphify-out/` with god nodes, community structure, and
cross-file relationships.

Universal across the 3 agent providers Alethe spawns (Claude Code, Codex, OpenCode) when the
project has Graphify enabled: each gets the Graphify MCP server wired into its session
automatically (Claude via `--mcp-config`; Codex/OpenCode via `.codex/config.toml`/`opencode.json`
in the project root — see `graphify_codex_config_write`/`graphify_opencode_config_write` in
`src-tauri/src/graphify.rs`).

Rules:
- If a Graphify MCP tool (e.g. `graphify_query`/similar) is available in this session, prefer
  calling it directly over shelling out — same scoped-subgraph result, no extra process spawn.
- Otherwise, for codebase questions, first run `graphify query "<question>"` when
  graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and
  `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually
  much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain
  do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
