import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { Role, clarificationTimeout, type IssuePolicy } from "./contracts.js";

const profile = Type.Object(
  {
    harness: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    instructions: Type.Optional(Type.String({ maxLength: 4000 })),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86400000 })),
  },
  { additionalProperties: false },
);
export const IssueConfigSchema = Type.Object(
  {
    auto_implement: Type.Optional(Type.Boolean()),
    auto_publish: Type.Optional(Type.Boolean()),
    proceed_under_assumptions: Type.Optional(Type.Boolean()),
    auto_follow_ups: Type.Optional(Type.Boolean()),
    clarification_timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 604800000 })),
    clarification_timeout_disabled: Type.Optional(Type.Boolean()),
    max_concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    profiles: Type.Object(
      {
        investigation: profile,
        implementation: profile,
        verification: profile,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type IssueConfig = Static<typeof IssueConfigSchema>;

function read(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 65536) throw new Error("Issue policy must be a regular file of at most 64 KiB");
  return readFileSync(path, "utf8");
}

export function loadIssuePolicy(root: string): IssuePolicy {
  const source = read(join(root, "octo-manager.toml"));
  const parsed: unknown = Bun.TOML.parse(source);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schema_version" in parsed) ||
    parsed.schema_version !== 1 ||
    !("issues" in parsed) ||
    !Check(IssueConfigSchema, parsed.issues)
  )
    throw new Error("Configure issues.profiles in repository octo-manager.toml");
  let stage = "unknown";
  try {
    const manifest: unknown = JSON.parse(read(join(root, ".source-code.json")));
    if (typeof manifest === "object" && manifest !== null && "stage" in manifest && typeof manifest.stage === "string")
      stage = manifest.stage;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const config = parsed.issues;
  const convert = (value: IssueConfig["profiles"]["investigation"]) => ({
    harness: value.harness,
    model: value.model,
    instructions: value.instructions ?? "",
    timeoutMs: value.timeout_ms ?? 1800000,
  });
  return {
    hash: createHash("sha256").update(source).update(stage).digest("hex"),
    stage,
    timeoutMs:
      (config.clarification_timeout_disabled ?? false)
        ? undefined
        : (config.clarification_timeout_ms ?? clarificationTimeout(stage)),
    implement: config.auto_implement ?? false,
    publish: config.auto_publish ?? false,
    assumptions: config.proceed_under_assumptions ?? false,
    followUps: config.auto_follow_ups ?? false,
    concurrency: config.max_concurrency ?? 1,
    profiles: {
      [Role.Investigation]: convert(config.profiles.investigation),
      [Role.Implementation]: convert(config.profiles.implementation),
      [Role.Verification]: convert(config.profiles.verification),
    },
  };
}
