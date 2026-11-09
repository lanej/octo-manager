#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .tools/bin
GOBIN="$PWD/.tools/bin" go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
GOBIN="$PWD/.tools/bin" go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.21.1
bun node_modules/@bufbuild/buf/bin/buf lint
bun node_modules/@bufbuild/buf/bin/buf generate
