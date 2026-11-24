---
name: typescript
description: "Use when writing or reviewing TypeScript, enforcing exhaustive state handling, or adopting strict compiler and typed lint checks in new or existing repositories. Apply the selected beta expectations."
---

# typescript: beta

Protect supported behavior, affected integrations, and compatibility. Use independent expected outcomes and migration checks where relevant.

## Verification

Run `python3 scripts/check-source-code.py typescript` for the installed lifecycle gate. The selected stage entrypoint controls required checks; standalone modes describe available tools and do not add another stage’s gates. Preserve stronger repository requirements. Missing tools and failed checks require resolution or a reported limit, never a silent skip.

When the selected stage requires lint, use Biome alongside typed ESLint and the existing formatter. Standalone `lint`, `typecheck`, `test`, and `audit` modes isolate checks; `fmt` requires explicit TypeScript paths and is the only source-writing mode. Treat parser errors, uncovered source, failing project checks, and suppression-policy violations as failures. Read [the correctness guide](references/correctness.md) when adopting, tuning, or explaining the profile.

## Enforcement: ratchet

Preserve the adopted diagnostic baseline. New diagnostics fail even in unchanged consumers. Original compilation, parser/configuration failures, missing modules, suppression-policy violations, original project checks, tests, audits, and Biome findings cannot be baselined when their checks run at the selected stage. Never add an allowance to unblock a feature or filter to changed lines.

After repairing old findings, run `node scripts/check-typescript.mjs ratchet` and commit the reduced baseline with the fix; it can only shrink the budget. One-time baseline creation requires committed source and an authorized adoption task. A signature budget can reuse indistinguishable findings and formatting is file-granular; do not claim individual defect identity or full legacy compliance. Read [the adoption mechanics](references/correctness.md) when installing or changing the profile.

## TypeScript correctness

Before selecting application tools or an API protocol, read [the installed project policy](../source-code-lifecycle/SKILL.md). Apply the declared authority and adoption at the configured maturity; preserve external providers’ protocols and established stacks according to that policy.

Follow the verification commands and enforcement in this skill’s installed entrypoint. Preserve existing repository checks.

For comment decisions, read the [shared comment guidance](../code-comments/SKILL.md). For public library APIs, also read the [library comment guidance](../library-code-comments/SKILL.md). Bootstrap bundles both with this skill in tracked or local mode; apply the library perspective only to library work and preserve project requirements.

Make decisions explicit, preserve failures, and validate untrusted data at boundaries. Follow the repository's existing architecture and stronger checks; do not replace them with a generic framework.

### Implementation

- Use discriminated unions for variants, exhaustive switches, and `satisfies Record<Key, Value>` for total tables. A default branch is a runtime guard, not coverage for an omitted declared variant.
- Accept external data as `unknown` and validate it before treating it as domain data. Do not replace validation with assertions, `any`, or non-null assertions.
- Await promises or attach a meaningful rejection handler. `void promise` does not handle rejection. Preserve cancellation and cleanup with `finally` or supported disposable resources.
- Isolate domain decisions from I/O where useful. Introduce ports or interfaces for demonstrated boundaries, not for every function. Retain existing import and architecture checks.

### Verification boundaries

Types are erased at runtime. Lint and tests do not establish business correctness; use independently derived expected behavior and actual boundary validation. Fix findings at their cause and review suppressions, exclusions, and tool upgrades as policy changes.
