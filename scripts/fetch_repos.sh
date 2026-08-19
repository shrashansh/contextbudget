#!/usr/bin/env bash
# Fetch the repos ContextBudget indexes. Run once, locally.
# vendor/ is gitignored — only snapshots/*.json is committed.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p vendor

fetch() {
  local name=$1 url=$2
  if [ -d "vendor/$name" ]; then
    echo "vendor/$name exists, skipping"
    return
  fi
  # depth 1: we parse the working tree, not history. Churn was cut (see DECISIONS.md).
  git clone --depth 1 --quiet "$url" "vendor/$name"
  echo "vendor/$name  $(git -C "vendor/$name" rev-parse --short HEAD)"
}

fetch fastapi https://github.com/fastapi/fastapi.git
fetch httpx   https://github.com/encode/httpx.git

# Snapshots embed verbatim upstream source (signatures, docstrings, bodies).
# MIT and BSD-3 both require the copyright notice travel with it.
mkdir -p snapshots
{
  echo "# Attribution"
  echo
  echo "snapshots/*.json contain source extracted from the projects below."
  echo "Their licenses are reproduced in full."
  for r in fastapi httpx; do
    echo
    echo "## $r"
    echo
    echo '```'
    cat "vendor/$r/LICENSE"* 2>/dev/null || echo "LICENSE not found — check upstream before shipping"
    echo '```'
  done
} > snapshots/ATTRIBUTION.md

echo "wrote snapshots/ATTRIBUTION.md"
