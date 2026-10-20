#!/usr/bin/env bash
# Runs the whole suite from a clean checkout: string-catalog gate, divergence registry check, package unit tests, app build.
set -euo pipefail
cd "$(dirname "$0")/.."
Scripts/check-strings.py
Scripts/check-divergences.py  # Mac-only / Mac-different registry (AletheNative/DIVERGENCES.md)
Vendor/ghostty/build.sh  # no-op once built
swift test --package-path Packages/AletheKit --scratch-path build/AletheKit
Scripts/build.sh Debug
