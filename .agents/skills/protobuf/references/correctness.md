# Strict Protobuf profile

Octo owns its Protobuf runner in `scripts/check-protobuf.py`. The source-code preset that provisions a Go-based Buf plugin is disabled for this project. The authored check runs both locally and in CI, and keeps the same standard, comment, field representation, and compatibility requirements.

```sh
bun install --frozen-lockfile --ignore-scripts
python3 scripts/check-protobuf.py fmt
python3 scripts/check-protobuf.py all --against '.git#ref=origin/main'
```

Buf 1.75.0 produces the descriptor set consumed by `scripts/check-proto-json.ts`. The rule checks scalar `string` fields with the case-sensitive suffix `_json`, including nested, repeated, and oneof members, and excludes imported dependency declarations. Use typed messages for structured data. For an established schema, add a compatible field at a new number or introduce a versioned migration. Buf checks the `FILE` compatibility rules against the explicit PR base or released schema.
