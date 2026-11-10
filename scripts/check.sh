#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GOTOOLCHAIN=${GOTOOLCHAIN:-go$(awk '$1 == "go" { print $2; exit }' go.mod)}
bun run build
bun run test
bash scripts/check-go.sh
shellcheck bin/octo-manager scripts/generate.sh scripts/check.sh scripts/build.sh
