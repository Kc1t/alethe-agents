#!/usr/bin/env python3
"""Checks AletheNative/DIVERGENCES.md and the places that cite it (see the rule in that file).

It cannot know that a divergence exists; reviewers have to ask that. It does make sure the registry cannot rot:

  - the table header and every row have the expected columns, kinds, dispositions and dates;
  - ids are unique and ascending, and every path a row cites in the Code column exists;
  - every `MD-nnn` cited in CHANGELOG.md exists, and every changelog bullet tagged [Mac-only] or
    [Mac-different] cites at least one.

    Scripts/check-divergences.py
"""
import pathlib
import re
import sys

NATIVE = pathlib.Path(__file__).resolve().parents[1]
REPO = NATIVE.parent
COLUMNS = ["ID", "Area", "Kind", "What differs", "Baseline (web)", "Mac", "Data / compat", "Code", "Since", "Disposition"]
KINDS = {"Mac-only", "Behavior", "Data", "Platform"}
DISPOSITIONS = {"Keep", "Propose to web", "Revisit", "Converged", "Retired"}
CLOSED = {"Converged", "Retired"}


def cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def registry_rows(text: str) -> tuple[list[str], list[tuple[int, list[str]]]]:
    problems: list[str] = []
    rows: list[tuple[int, list[str]]] = []
    in_registry = False
    header_seen = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.startswith("## "):
            in_registry = line.strip() == "## Registry"
            continue
        if not in_registry or not line.startswith("|"):
            continue
        parts = cells(line)
        if not header_seen:
            header_seen = True
            if parts != COLUMNS:
                problems.append(f"DIVERGENCES.md:{number}: the table header must be exactly: {' | '.join(COLUMNS)}")
            continue
        if set("".join(parts)) <= set("-: "):
            continue  # the |---| separator
        if len(parts) != len(COLUMNS):
            problems.append(f"DIVERGENCES.md:{number}: expected {len(COLUMNS)} columns, found {len(parts)} "
                            "(a cell must not contain a pipe)")
            continue
        rows.append((number, parts))
    if not header_seen:
        problems.append("DIVERGENCES.md: no '## Registry' table found")
    return problems, rows


def cited_paths(code: str) -> list[str]:
    return re.findall(r"`([^`]+)`", code)


def check_rows(rows: list[tuple[int, list[str]]]) -> list[str]:
    problems: list[str] = []
    seen: list[str] = []
    for number, parts in rows:
        row = dict(zip(COLUMNS, parts))
        where = f"DIVERGENCES.md:{number}"
        if not re.fullmatch(r"MD-\d{3}", row["ID"]):
            problems.append(f"{where}: id '{row['ID']}' must look like MD-001")
        elif row["ID"] in seen:
            problems.append(f"{where}: duplicate id {row['ID']}")
        elif seen and row["ID"] < seen[-1]:
            problems.append(f"{where}: ids must be ascending ({row['ID']} after {seen[-1]})")
        seen.append(row["ID"])
        for column, value in row.items():
            if not value:
                problems.append(f"{where}: {row['ID']} has an empty '{column}' cell")
        if row["Kind"] not in KINDS:
            problems.append(f"{where}: {row['ID']} kind '{row['Kind']}' must be one of {sorted(KINDS)}")
        label = row["Disposition"].split(" — ")[0].strip()
        if label not in DISPOSITIONS:
            problems.append(f"{where}: {row['ID']} disposition '{label}' must be one of {sorted(DISPOSITIONS)}")
        if row["Since"] != "pre-registry" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["Since"]):
            problems.append(f"{where}: {row['ID']} 'Since' must be a YYYY-MM-DD date or 'pre-registry'")
        paths = cited_paths(row["Code"])
        if not paths and label not in CLOSED:
            problems.append(f"{where}: {row['ID']} must cite at least one path in `backticks` in the Code column")
        for path in paths:
            if label in CLOSED:
                continue  # the code may be gone on purpose
            if not any((base / path).exists() for base in (NATIVE, REPO)):
                problems.append(f"{where}: {row['ID']} cites a path that does not exist: {path}")
    return problems


def changelog_blocks(text: str) -> list[tuple[int, str]]:
    blocks: list[tuple[int, str]] = []
    start, current = 0, []
    for number, line in enumerate(text.splitlines(), 1):
        if line.startswith("- "):
            if current:
                blocks.append((start, "\n".join(current)))
            start, current = number, [line]
        elif current and line.startswith("  "):
            current.append(line)
        else:
            if current:
                blocks.append((start, "\n".join(current)))
            current = []
    if current:
        blocks.append((start, "\n".join(current)))
    return blocks


def check_changelog(known: set[str]) -> list[str]:
    problems: list[str] = []
    changelog = NATIVE / "CHANGELOG.md"
    if not changelog.exists():
        return problems
    for number, block in changelog_blocks(changelog.read_text()):
        refs = set(re.findall(r"MD-\d{3}", block))
        for ref in sorted(refs - known):
            problems.append(f"CHANGELOG.md:{number}: cites {ref}, which is not in DIVERGENCES.md")
        if re.search(r"\[Mac-(only|different)\]", block) and not refs:
            problems.append(f"CHANGELOG.md:{number}: a [Mac-only]/[Mac-different] bullet must cite its MD-nnn id")
    return problems


def main() -> int:
    registry = NATIVE / "DIVERGENCES.md"
    if not registry.exists():
        print("check-divergences: AletheNative/DIVERGENCES.md is missing")
        return 1
    problems, rows = registry_rows(registry.read_text())
    problems += check_rows(rows)
    problems += check_changelog({parts[0] for _, parts in rows})
    if problems:
        print("check-divergences: FAILED")
        for problem in problems:
            print("  " + problem)
        return 1
    print(f"check-divergences: ok ({len(rows)} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
