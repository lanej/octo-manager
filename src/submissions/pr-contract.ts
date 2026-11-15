import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { marked } from "marked";
import mermaid from "mermaid";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
const text = () => Type.String({ minLength: 1, maxLength: 8000 });
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const positive = () => Type.Integer({ minimum: 1, maximum: 10000 });
export const factorNames = [
  "breadth",
  "behavior",
  "coupling",
  "compatibility",
  "state_risk",
] as const;
const weightsSchema = object({
  breadth: positive(),
  behavior: positive(),
  coupling: positive(),
  compatibility: positive(),
  state_risk: positive(),
});
const profileSchema = object({
  max_prose_words: positive(),
  require_diagram: Type.Boolean(),
});
export const ContractSchema = object({
  schema_version: Type.Literal(1),
  pr: object({
    presentation: object({
      layout: Type.Literal("f-pattern"),
      first_artifact_by_prose_word: positive(),
      diagram_format: Type.Literal("mermaid"),
    }),
    complexity: object({
      weights: weightsSchema,
      routine_max: Type.Integer({ minimum: 0 }),
      standard_max: positive(),
    }),
    profiles: object({
      routine: profileSchema,
      standard: profileSchema,
      complex: profileSchema,
    }),
    overrides: Type.Array(object({ rule_id: text(), reason: text() }), {
      maxItems: 100,
    }),
  }),
});
export type PrContract = Static<typeof ContractSchema>;
export const defaultContract: PrContract = {
  schema_version: 1,
  pr: {
    presentation: {
      layout: "f-pattern",
      first_artifact_by_prose_word: 150,
      diagram_format: "mermaid",
    },
    complexity: {
      weights: {
        breadth: 1,
        behavior: 2,
        coupling: 2,
        compatibility: 3,
        state_risk: 3,
      },
      routine_max: 4,
      standard_max: 11,
    },
    profiles: {
      routine: { max_prose_words: 100, require_diagram: false },
      standard: { max_prose_words: 250, require_diagram: false },
      complex: { max_prose_words: 600, require_diagram: true },
    },
    overrides: [],
  },
};
const partialSchema = object({
  schema_version: Type.Literal(1),
  pr: Type.Optional(
    object({
      presentation: Type.Optional(
        Type.Partial(ContractSchema.properties.pr.properties.presentation),
      ),
      complexity: Type.Optional(
        object({
          weights: Type.Optional(Type.Partial(weightsSchema)),
          routine_max: Type.Optional(Type.Integer({ minimum: 0 })),
          standard_max: Type.Optional(positive()),
        }),
      ),
      profiles: Type.Optional(
        object({
          routine: Type.Optional(Type.Partial(profileSchema)),
          standard: Type.Optional(Type.Partial(profileSchema)),
          complex: Type.Optional(Type.Partial(profileSchema)),
        }),
      ),
      overrides: Type.Optional(
        ContractSchema.properties.pr.properties.overrides,
      ),
    }),
  ),
});
export function readContract(toml?: string): PrContract {
  if (toml === undefined) return structuredClone(defaultContract);
  if (Buffer.byteLength(toml) > 131072)
    throw new Error("Octo TOML exceeds 128 KiB");
  const raw: unknown = Bun.TOML.parse(toml);
  if (!Check(partialSchema, raw))
    throw new Error(
      "Invalid octo-manager.toml: unknown key, unsupported version, or invalid value",
    );
  const p = raw.pr,
    d = defaultContract.pr;
  const value: PrContract = {
    schema_version: 1,
    pr: {
      presentation: { ...d.presentation, ...p?.presentation },
      complexity: {
        ...d.complexity,
        ...p?.complexity,
        weights: { ...d.complexity.weights, ...p?.complexity?.weights },
      },
      profiles: {
        routine: { ...d.profiles.routine, ...p?.profiles?.routine },
        standard: { ...d.profiles.standard, ...p?.profiles?.standard },
        complex: { ...d.profiles.complex, ...p?.profiles?.complex },
      },
      overrides: p?.overrides ?? [],
    },
  };
  if (value.pr.complexity.routine_max >= value.pr.complexity.standard_max)
    throw new Error("Complexity thresholds must increase");
  if (
    value.pr.overrides.some(
      (rule) => rule.rule_id.trim() === "" || rule.reason.trim() === "",
    )
  )
    throw new Error("Contract overrides require a nonblank rule ID and reason");
  if (
    new Set(value.pr.overrides.map((r) => r.rule_id)).size !==
    value.pr.overrides.length
  )
    throw new Error("Duplicate contract override");
  return value;
}
export function explainContract(toml: string | undefined, source: string) {
  const effective = readContract(toml);
  const authored: unknown = toml === undefined ? {} : Bun.TOML.parse(toml);
  const values: { path: string; value: unknown; origin: string }[] = [];
  const present = (path: string[]) => {
    let value = authored;
    for (const key of path) {
      if (typeof value !== "object" || value === null || !(key in value))
        return false;
      value = Reflect.get(value, key) as unknown;
    }
    return true;
  };
  const walk = (value: unknown, path: string[]) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value))
        walk(child, [...path, key]);
    } else
      values.push({
        path: path.join("."),
        value,
        origin: present(path) ? source : "versioned defaults",
      });
  };
  walk(effective, []);
  return { effective, values };
}
const FactorSchema = object({
  factor: Type.Union([
    Type.Literal("breadth"),
    Type.Literal("behavior"),
    Type.Literal("coupling"),
    Type.Literal("compatibility"),
    Type.Literal("state_risk"),
  ]),
  rating: Type.Integer({ minimum: 0, maximum: 2 }),
  rationale: text(),
  evidenceRefs: Type.Array(text(), { minItems: 1, maxItems: 30 }),
});
export const FactorsSchema = Type.Array(FactorSchema, {
  minItems: 5,
  maxItems: 5,
});
export type Factors = Static<typeof FactorsSchema>;
export function scoreComplexity(factors: Factors, contract: PrContract) {
  if (new Set(factors.map((r) => r.factor)).size !== 5)
    throw new Error("Each complexity factor must be rated exactly once");
  const score = factors.reduce(
    (sum, r) => sum + r.rating * contract.pr.complexity.weights[r.factor],
    0,
  );
  const tier =
    score <= contract.pr.complexity.routine_max
      ? "routine"
      : score <= contract.pr.complexity.standard_max
        ? "standard"
        : "complex";
  return { score, tier } as const;
}
export const FindingSchema = object({
  ruleId: text(),
  status: Type.Union([
    Type.Literal("valid"),
    Type.Literal("invalid"),
    Type.Literal("needs_evidence"),
  ]),
  message: text(),
  evidenceRefs: Type.Array(text(), { minItems: 1, maxItems: 100 }),
});
export const EvaluationSchema = object({
  findings: Type.Array(FindingSchema, { minItems: 3, maxItems: 100 }),
  requirementChecks: Type.Array(
    object({
      ruleId: text(),
      status: Type.Union([
        Type.Literal("satisfied"),
        Type.Literal("unmet"),
        Type.Literal("unknown"),
        Type.Literal("not_applicable"),
      ]),
      rationale: text(),
    }),
    { maxItems: 100 },
  ),
});
export type Evaluation = Static<typeof EvaluationSchema>;
export const DecisionSchema = object({
  status: Type.Union([
    Type.Literal("valid"),
    Type.Literal("invalid"),
    Type.Literal("needs_evidence"),
  ]),
  score: Type.Integer(),
  tier: Type.Union([
    Type.Literal("routine"),
    Type.Literal("standard"),
    Type.Literal("complex"),
  ]),
  proseWords: Type.Integer(),
  blockers: Type.Array(text()),
  findings: EvaluationSchema.properties.findings,
});
export type Decision = Static<typeof DecisionSchema>;
const MarkdownTokenSchema = Type.Object({
  type: Type.String(),
  text: Type.Optional(Type.String()),
  lang: Type.Optional(Type.String()),
  href: Type.Optional(Type.String()),
  tokens: Type.Optional(Type.Array(Type.Unknown())),
  items: Type.Optional(
    Type.Array(Type.Object({ tokens: Type.Array(Type.Unknown()) })),
  ),
  header: Type.Optional(
    Type.Array(Type.Object({ tokens: Type.Array(Type.Unknown()) })),
  ),
  rows: Type.Optional(
    Type.Array(Type.Array(Type.Object({ tokens: Type.Array(Type.Unknown()) }))),
  ),
});
export function inspectMarkdown(body: string) {
  let words = 0,
    firstArtifact: number | undefined;
  const diagrams: string[] = [],
    links: string[] = [],
    images: string[] = [],
    references: string[] = [],
    codeReferences: string[] = [];
  const prose = (text: string) => {
    words += text.trim().split(/\s+/u).filter(Boolean).length;
    for (const ref of text.matchAll(
      /(?<![\w/])(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*(?![\w])/gu,
    ))
      references.push(ref[0]);
  };
  const html = (nodes: DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of nodes) {
      if ("tagName" in node) {
        if (node.tagName === "img") {
          const src = node.attrs.find((a) => a.name === "src")?.value;
          if (src !== undefined) {
            images.push(src);
            links.push(src);
            if (src.startsWith("https://")) firstArtifact ??= words;
          }
        }
        if (node.tagName === "a") {
          const href = node.attrs.find((a) => a.name === "href")?.value;
          if (href !== undefined) links.push(href);
        }
        if (node.tagName === "table") firstArtifact ??= words;
        html(node.childNodes);
      } else if ("value" in node) prose(node.value);
    }
  };
  const visit = (tokens: unknown[]) => {
    for (const raw of tokens) {
      if (!Check(MarkdownTokenSchema, raw))
        throw new Error("Unsupported Markdown parser token");
      const text = raw.text ?? "";
      if (raw.type === "code") {
        if (text.trim() !== "") {
          firstArtifact ??= words;
          if (raw.lang === "mermaid") diagrams.push(text);
        }
      } else if (raw.type === "image") {
        const href = raw.href ?? "";
        links.push(href);
        images.push(href);
        if (href.startsWith("https://")) firstArtifact ??= words;
      } else if (raw.type === "html") html(parseFragment(text).childNodes);
      else if (raw.type === "table") {
        firstArtifact ??= words;
        for (const row of [raw.header ?? [], ...(raw.rows ?? [])])
          for (const cell of row) visit(cell.tokens);
      } else if (raw.type === "list") {
        for (const item of raw.items ?? []) visit(item.tokens);
      } else if (raw.type === "link") {
        links.push(raw.href ?? "");
        visit(raw.tokens ?? []);
      } else if (raw.type === "codespan") {
        if (/(?:[\w.-]+\/[\w.-]+)?#\d+/u.test(text)) codeReferences.push(text);
        prose(text);
      } else if (raw.tokens !== undefined) visit(raw.tokens);
      else if (raw.type === "text" || raw.type === "escape") prose(text);
    }
  };
  const tokens: unknown = marked.lexer(body);
  if (!Array.isArray(tokens)) throw new Error("Invalid Markdown parse");
  visit(tokens);
  return {
    words,
    firstArtifact,
    diagrams,
    links,
    images,
    references,
    codeReferences,
  };
}
export async function validateDiagrams(diagrams: string[]): Promise<string[]> {
  const blockers: string[] = [];
  for (const [index, diagram] of diagrams.entries()) {
    try {
      await mermaid.parse(diagram);
    } catch {
      blockers.push(`Invalid Mermaid diagram ${String(index + 1)}`);
    }
  }
  return blockers;
}
