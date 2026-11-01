# 003 — Per-agent isolation with two worktree modes

**Status:** Accepted · **Code:** `src-tauri/src/worktrees.rs`

## Context

Agents running in parallel on one repository overwrite each other's files. Each agent needs its own
checkout, but repositories differ: some work fine with `git worktree`, others hit its limits.

## Decision

Each agent gets a physical copy, in one of two modes chosen per project:

- **GitWorktree** (fast, light): `git worktree add` under `<repo>/.alethe/worktrees/<id>/`, sharing
  the repository's `.git`. The worktree's `.git` is a file (a `gitdir` pointer).
- **LocalCopy** (heavier, fewer limits): `git clone --local`, an independent repository whose
  objects are hardlinked. Its `.git` is a directory.

Whether `.git` is a file or a directory is the marker that tells the two modes apart when listing or
removing.

## Consequences

- No extra state is stored to know a copy's mode; the filesystem is the source of truth.
- LocalCopy uses more disk and needs its own fetch, but avoids worktree restrictions such as one
  branch checked out in one place only.
