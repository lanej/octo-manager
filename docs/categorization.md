# Message categorization engine

The engine turns GitHub messages into a typed category before delivery policy decides whether to notify an agent. Its only implementation layer is local heuristics. It performs no model calls, uses no model SDK or credentials, and has no inference budget or paid fallback enabled.

## Data contract

Input contains the GitHub `author`, message `source` (`review`, `conversation`, or `inline`), and raw `body`. A result contains:

```typescript
{
  category: "findings" | "progress" | "inconclusive" | "no_findings" | "unknown";
  author: string;
  rule: string;
  reason: string;
  classifier: { id: string; version: number; layer: "heuristic" };
}
```

The category is an enum; the complete delivery-policy table must cover every category. Findings and unknown messages remain eligible for delivery. Progress, inconclusive outcomes, and no-findings results remain silent. Unknown is preserved rather than guessed to be noise. Raw messages and revision identities remain in existing observations; categorization results are computed rather than added to the database schema in this version.

## Author-dependent heuristics

`src/categorization/engine.ts` routes by case-insensitive GitHub login through a classifier registry. Only the selected author adapter examines a message's patterns. Inline feedback bypasses summary heuristics and remains eligible for assessment.

| GitHub author | Heuristic | Evidence |
| --- | --- | --- |
| `chatgpt-codex-connector[bot]` | `codex-review-state`, version 1 | Versioned review-state JSON; explicit findings win over lifecycle status. |
| `copilot-pull-request-reviewer[bot]`, legacy `Copilot` alias | `copilot-review-patterns`, version 1 | Recognized clean-overview sections, generated-comment counts, and standalone lifecycle text. |
| Unregistered author | `github-author-router`, version 1 | Unknown; body text cannot select another author's heuristic. |

Provider patterns live under `src/categorization/heuristics/`. Copilot overview parsing checks individual sections rather than one combined expression. Additional prose, unexpected sections, and malformed Codex metadata stay unknown. Each adapter returns a category, rule, and reason; it does not decide delivery or perform external effects. The existing tracking compatibility boundary calls this engine for new findings, changed feedback, and retirement of previously queued status-only actions.

## Extension boundary

A new author registers another heuristic without changing tracking or delivery policy. The engine result also gives a future asynchronous/model layer a concrete unknown outcome to consider, but that layer is not implemented or called. Any paid categorizer would require explicit configuration, budget controls, and orchestration outside SQLite transactions. It must retain category, classifier version, rule/reason, and evidence distinctions rather than hiding cost or uncertainty inside a boolean predicate.
