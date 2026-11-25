---
name: protobuf
description: "Use when creating, modifying, reviewing, or validating Protobuf schemas. Apply schema correctness guidance and the selected lifecycle checks; preserve repository-specific requirements. Apply the selected beta expectations."
---

# protobuf: beta

Protect supported behavior, affected integrations, and compatibility. Use independent expected outcomes and migration checks where relevant.

## Verification

Run `PROTOBUF_AGAINST='.git#ref=origin/main' python3 scripts/check-protobuf.py all` for the project’s strict gate. The runner uses Buf for compilation, formatting, comment and standard lint rules, and FILE compatibility. The Bun descriptor rule rejects declared string fields whose names end in `_json`, including nested, repeated, and oneof fields. Install the pinned tools with the repository’s frozen Bun lockfile. Use the actual PR base or released schema for compatibility. Inline Buf lint ignores are disabled.


## Protobuf

Follow the verification commands in this skill’s installed entrypoint. Preserve existing project gates and Buf workspace, dependency, and generation configuration.

Model structured data with explicit messages, enums, repeated fields, typed maps, and `oneof` variants. Do not serialize JSON into string fields in place of a typed contract. Application code can hide JSON in innocently named strings; a field-name check alone does not establish typed contracts throughout the application.

Fix findings at their cause. For published schemas, introduce compatible fields or a versioned migration; never rename published fields, recycle field numbers, loosen policy, or select a newer compatibility baseline merely to pass checks. Preserve deleted field names and numbers as reserved where appropriate. Buf checks schema structure and compatibility; use runtime validation and focused application tests for value constraints and actual serialization behavior.
