#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GOTOOLCHAIN=${GOTOOLCHAIN:-go$(awk '$1 == "go" { print $2; exit }' go.mod)}
bun run build:server
go build -o build/octo-manager-tui ./cmd/octo-manager-tui
