#!/usr/bin/env python3
"""Reports what changed in the Tauri app (upstream) since the last reviewed commit (plan §9).

The native app shares no code with upstream, so staying current means detecting and triaging
changes, not merging them. This script lists, for <baseline>..<target>:

  - Tauri commands added/removed in src-tauri/src/lib.rs (invoke_handler)
  - i18n keys added/removed in src/lib/i18n/messages/en.ts
  - new CHANGELOG.md release sections and [Unreleased] bullets
  - new top-level directories under src/components/
  - lines added/removed in the persisted-shape types (src/lib/types.ts)
  - projects.json schema version bumps (src/stores/projectsStore.migrations.ts)
  - changes to the bundled remote client: src-tauri/remote/ and every other upstream file in
    AletheRemote's bundle-manifest.json, diffed from the manifest's upstream SHA (plus @xterm
    version changes in package-lock.json) — resync with Scripts/sync-remote-client.sh

and writes AletheNative/upstream-reports/<date>-<target>.md. Triage then moves each item into the
plan's parity matrix (§8) and advances UPSTREAM_BASELINE in its own commit.

    Scripts/upstream-watch.py [--remote <name>] [--baseline <rev>] [--target <rev>] [--no-fetch]

The Windows/Linux app is the baseline. In the Mac-only repository add it once as a remote:
    git remote add upstream https://github.com/Kc1t/alethe-agents.git
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

NATIVE = Path(__file__).resolve().parent.parent
REPO = NATIVE.parent
REMOTE_MANIFEST = NATIVE / "Packages/AletheKit/Sources/AletheRemote/Resources/RemoteClient/bundle-manifest.json"


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True, text=True).stdout


def show(rev: str, path: str) -> str:
    try:
        return git("show", f"{rev}:{path}")
    except subprocess.CalledProcessError:
        return ""


def commands(rev: str) -> set[str]:
    text = show(rev, "src-tauri/src/lib.rs")
    block = re.search(r"generate_handler!\[(.*?)\]\)", text, flags=re.S)
    if not block:
        return set()
    body = re.sub(r"//[^\n]*", "", block.group(1))
    return {name.split("::")[-1] for name in re.findall(r"[A-Za-z_][\w:]*", body)}


def i18n_keys(rev: str) -> set[str]:
    return set(re.findall(r"^\s*'([^']+)':", show(rev, "src/lib/i18n/messages/en.ts"), flags=re.M))


def changelog_sections(rev: str) -> list[str]:
    return re.findall(r"^## \[([^\]]+)\]", show(rev, "docs/CHANGELOG.md"), flags=re.M)


def unreleased_bullets(rev: str) -> list[str]:
    text = show(rev, "docs/CHANGELOG.md")
    match = re.search(r"^## \[Unreleased\]\s*\n(.*?)(?=^## \[)", text, flags=re.S | re.M)
    return [line.strip() for line in (match.group(1) if match else "").splitlines() if line.strip().startswith("-")]


def component_dirs(rev: str) -> set[str]:
    listing = git("ls-tree", "-d", "--name-only", f"{rev}:src/components")
    return {line.strip() for line in listing.splitlines() if line.strip()}


def schema_version(rev: str) -> int | None:
    versions = [int(v) for v in re.findall(r"version:\s*(\d+)", show(rev, "src/stores/projectsStore.migrations.ts"))]
    return max(versions) if versions else None


def type_changes(baseline: str, target: str) -> tuple[list[str], list[str]]:
    diff = git("diff", "--unified=0", f"{baseline}..{target}", "--", "src/lib/types.ts")
    added = [l[1:].strip() for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]
    removed = [l[1:].strip() for l in diff.splitlines() if l.startswith("-") and not l.startswith("---")]
    keep = lambda lines: [l for l in lines if l and not l.startswith(("//", "*", "/*"))]
    return keep(added), keep(removed)


def xterm_versions(rev: str) -> dict[str, str]:
    try:
        packages = json.loads(show(rev, "package-lock.json") or "{}").get("packages", {})
    except json.JSONDecodeError:
        return {}
    return {name: packages.get(f"node_modules/{name}", {}).get("version", "?")
            for name in ("@xterm/xterm", "@xterm/addon-unicode11")}


def remote_client_changes(baseline: str, target: str) -> tuple[str, list[str], list[str]]:
    """(since, changed files, npm version changes) for the bundled phone client."""
    sources = {"src-tauri/remote/"}
    since = baseline
    if REMOTE_MANIFEST.exists():
        manifest = json.loads(REMOTE_MANIFEST.read_text())
        sources |= {f["source"] for f in manifest.get("files", []) if not f["source"].startswith("node_modules/")}
        try:
            since = git("rev-parse", manifest["upstreamSHA"]).strip()
        except (KeyError, subprocess.CalledProcessError):
            pass
    diff = git("diff", "--name-status", f"{since}..{target}", "--", *sorted(sources))
    changed = [" ".join(line.split()) for line in diff.splitlines() if line.strip()]
    old, new = xterm_versions(since), xterm_versions(target)
    npm = [f"{name} {old.get(name)} → {new[name]}" for name in new if old.get(name) != new[name]]
    return since, changed, npm


def bullets(items, empty="none") -> str:
    items = sorted(items) if isinstance(items, set) else list(items)
    return "\n".join(f"- `{i}`" for i in items) if items else f"_{empty}_"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", default=(NATIVE / "UPSTREAM_BASELINE").read_text().strip())
    parser.add_argument("--remote", help="remote that holds the Windows/Linux app "
                        "(default: 'upstream' when configured, otherwise 'origin')")
    parser.add_argument("--target", help="revision to compare against (default: <remote>/main)")
    parser.add_argument("--no-fetch", action="store_true")
    args = parser.parse_args()

    remote = args.remote or ("upstream" if "upstream" in git("remote").split() else "origin")
    if not args.no_fetch:
        git("fetch", "--quiet", remote)
    baseline = git("rev-parse", args.baseline).strip()
    target = git("rev-parse", args.target or f"{remote}/main").strip()
    log = git("log", "--oneline", "--no-merges", f"{baseline}..{target}").strip().splitlines()

    old_cmds, new_cmds = commands(baseline), commands(target)
    old_keys, new_keys = i18n_keys(baseline), i18n_keys(target)
    old_sections = set(changelog_sections(baseline))
    new_sections = [s for s in changelog_sections(target) if s not in old_sections and s != "Unreleased"]
    new_dirs = component_dirs(target) - component_dirs(baseline)
    added_types, removed_types = type_changes(baseline, target)
    old_schema, new_schema = schema_version(baseline), schema_version(target)
    remote_since, remote_changed, remote_npm = remote_client_changes(baseline, target)

    added_keys = new_keys - old_keys
    key_groups: dict[str, int] = {}
    for key in added_keys:
        key_groups[key.split(".")[0]] = key_groups.get(key.split(".")[0], 0) + 1

    today = datetime.date.today().isoformat()
    report = f"""# Upstream report {today}

Range: `{baseline[:7]}..{target[:7]}` — {len(log)} non-merge commit(s).

## Tauri commands
Added ({len(new_cmds - old_cmds)}):
{bullets(new_cmds - old_cmds)}

Removed ({len(old_cmds - new_cmds)}):
{bullets(old_cmds - new_cmds)}

## Release sections
{bullets(new_sections)}

[Unreleased] bullets at target:
{chr(10).join(unreleased_bullets(target)) or "_none_"}

## New component directories
{bullets(new_dirs)}

## i18n keys
Added: {len(added_keys)} — by prefix: {", ".join(f"{k} ({v})" for k, v in sorted(key_groups.items())) or "none"}
Removed: {len(old_keys - new_keys)}

## Persisted types (src/lib/types.ts)
Added lines ({len(added_types)}):
{bullets(added_types[:80])}

Removed lines ({len(removed_types)}):
{bullets(removed_types[:80])}

## projects.json schema
{"Unchanged (v" + str(new_schema) + ")" if old_schema == new_schema else f"**Bumped v{old_schema} → v{new_schema}** — extend TauriImporter and add a fixture."}

## Remote client (src-tauri/remote/ and the bundled upstream files)
Since `{remote_since[:7]}` (the bundle manifest's upstream SHA):
{bullets(remote_changed)}

npm versions:
{bullets(remote_npm)}

{"Resync with `Scripts/sync-remote-client.sh` and re-apply or drop native patches." if remote_changed or remote_npm else "Bundle current."}

## Commits
{chr(10).join("- " + line for line in log) or "_none_"}

## Triage
Assign each item a phase in the parity matrix (docs/MAC_NATIVE_V2_PLAN.md §8) or mark it Won't port,
then set UPSTREAM_BASELINE to `{target}` in the same commit.
"""
    out_dir = NATIVE / "upstream-reports"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{today}-{target[:7]}.md"
    out.write_text(report)
    print(f"upstream-watch: {len(log)} commit(s), {len(new_cmds - old_cmds)} new command(s), "
          f"{len(added_keys)} new key(s), {len(new_dirs)} new component dir(s), "
          f"{len(remote_changed)} remote client file(s) → {out.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
