# 006 — The app, not the agent, decides whether a merge conflicts

**Status:** Accepted (Merge Center UI removed in 1.6.0; the backend remains) ·
**Code:** `src-tauri/src/merge_analyzer.rs`

## Context

When two agents finish work on separate branches, someone has to integrate them. Letting an agent
decide whether a conflict exists makes that judgment unverifiable and lets it touch the user's
working tree.

## Decision

The Merge Analyzer is the first stage of the merge cycle and the only part that decides whether a
conflict exists. It runs a trial merge in a disposable worktree (`.alethe/merge-envs/analyze-<id>`),
so the user's working tree is never touched.

```
agents done → Merge Analyzer → conflict? ─no→ Validation → Merge
                                        └yes→ Classifier → Conflict Resolution (007)
```

The Classifier maps each conflicted file to a class (Rust, TS, UI, Cargo, Package, JSON, Config,
Asset, Planning, Graph, Other). Each class carries a strategy, which is the minimal context handed to
the resolution agent.

## Consequences

- Conflict detection is deterministic and testable without an agent.
- The resolution agent receives only what it needs, which keeps its prompt small.
