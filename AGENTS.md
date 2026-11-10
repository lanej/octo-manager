# Development

Use the repository-local [Builder](.agents/skills/builder/SKILL.md) and [Go](.agents/skills/go/SKILL.md) guidance. Use Bun 1.4.4, the committed bun.lock, and the Go toolchain declared by go.mod. Run `bun run check` before handoff; it builds both applications, checks the Bun scheduler, and runs the portable strict Go profile including race tests and vulnerability analysis. Keep Markdown paragraphs on one source line.

The versioned API lives in `proto/`; run `bun run generate` after changing it and commit both Go and TypeScript bindings. Keep generated code reproducible. Run `bash scripts/check-go.sh fix ./internal/... ./cmd/...` with the declared Go toolchain for scoped mechanical fixes; never weaken lint policy or add a baseline for new code.

The Bun coordinator owns durable state and all Git/GitHub effects. The Charmed Go frontend is an API client and owns its terminal lifecycle. Disconnecting the frontend must not cancel jobs. Workers receive only typed scoped tools. Do not add unrestricted shell tools, load project extensions, copy Codex credentials, or write to remote GitHub objects as part of the demo. Automated tests use synthetic credentials or controlled workers; provider acceptance is separate.
