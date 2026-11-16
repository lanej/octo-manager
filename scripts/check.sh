#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GOTOOLCHAIN=${GOTOOLCHAIN:-go$(awk '$1 == "go" { print $2; exit }' go.mod)}
python3 scripts/check-source-code.py protobuf
bun run build
node --max-old-space-size=4096 scripts/check-typescript.mjs
bash scripts/check-go.sh
shellcheck bin/octo-manager scripts/generate.sh scripts/check.sh scripts/build.sh
