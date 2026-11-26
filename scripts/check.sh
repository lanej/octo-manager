#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun scripts/generate-message-docs.ts --check
python3 scripts/check-protobuf.py all
bun run build
node --max-old-space-size=4096 scripts/check-typescript.mjs
shellcheck bin/octo-manager scripts/generate.sh scripts/check.sh scripts/build.sh
