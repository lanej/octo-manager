#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun scripts/export-api-contracts.ts
bun node_modules/@bufbuild/buf/bin/buf format --write
python3 scripts/check-protobuf.py lint
bun node_modules/@bufbuild/buf/bin/buf generate

bun scripts/export-pr-schemas.ts
bun scripts/generate-message-docs.ts
