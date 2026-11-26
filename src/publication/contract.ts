import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const strings = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
  maxItems: 20,
});
export const ContractSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    template: Type.String({ minLength: 1, maxLength: 500 }),
    title: Type.Optional(
      Type.Object(
        {
          maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
          prefixes: Type.Optional(strings),
        },
        { additionalProperties: false },
      ),
    ),
    body: Type.Optional(
      Type.Object(
        {
          requiredHeadings: Type.Optional(strings),
          requiredText: Type.Optional(strings),
        },
        { additionalProperties: false },
      ),
    ),
    guidance: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 12 })),
  },
  { additionalProperties: false },
);
export type Contract = Static<typeof ContractSchema>;
export interface Draft {
  title: string;
  body: string;
}
export interface Finding {
  code: string;
  fix: string;
}

export class PublicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const contractPath = ".octo/pr-contract.json";
export const skillPath = ".agents/skills/pr-description/SKILL.md";
export const stockTemplate = "<!-- octo:describe-change -->\n\n<!-- octo:explain-why -->\n";
export const skill = `---
name: pr-description
description: Use when preparing or revising a pull request title and description under the repository's Octo format contract.
---

# Write a PR description

The calling agent owns the content and factual accuracy. Octo checks declared format rules and publishes the submitted draft; it does not write or judge its meaning.

Read the repository's CONTRIBUTING and development guidance, the template selected in \`.octo/pr-contract.json\`, and that contract. Read .octo/pr-style.json when present for advisory local guidance and PR-sample statistics; its proposed format rules are not active checks. Follow authored project instructions. Explain the final outcome and why; add only context the diff and checks do not supply. Omit empty sections, boilerplate, file inventories, and automated test inventories. Include required template sections and material compatibility or verification gaps. Never invent observations or links.

Assess complexity from the actual diff: routine changes need a short explanation; interacting components or compatibility changes need the relevant decisions and limits. Use PR Flow evidence for an existing PR when available. Its current analyze command requires a PR URL; unavailable analysis is advisory, not a publication blocker. Historical PR statistics and inferred styles are also advisory.

Write the final title and description to a local file. Run \`octo-manager pr validate --title TITLE --body-file FILE\` and fix its specific findings. This command runs local checks only. When the user authorizes publication, run \`octo-manager pr publish --title TITLE --body-file FILE\`. An invalid draft fails before acceptance. A pending receipt means accepted for publication, not that GitHub accepted the PR. Inspect completion with \`octo-manager publication show ID\`. Publication defaults to tracking when the caller has a Codex thread ID. Use \`--no-track\` to opt out or \`--track\` to require a supported owner identity. Verify the publication and tracking status separately. Retry an unavailable enrollment with \`octo-manager publication retry ID\`.

For title/body revisions, apply these same writing and validation instructions to the revised draft. Octo never adds a separate writer or rewrites the content.
`;

export function githubRepository(remote: string): string | undefined {
  const scp = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(remote)?.[1];
  if (scp !== undefined) return scp;
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return undefined;
  }
  if (
    url.hostname !== "github.com" ||
    !["https:", "ssh:"].includes(url.protocol) ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined;
  return /^\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(url.pathname)?.[1];
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function safePath(root: string, path: string): string {
  const target = resolve(root, path);
  const offset = relative(root, target);
  if (isAbsolute(path) || offset === ".." || offset.startsWith("../") || offset === "") {
    throw new PublicationError("invalid_path", "Use a repository-relative file path.");
  }
  let cursor = target;
  while (cursor !== root) {
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new PublicationError("linked_path", "Preserve linked files; use an ordinary repository-local path.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    cursor = dirname(cursor);
  }
  return target;
}

export function readContract(root: string): {
  contract: Contract;
  hash: string;
} {
  let raw: string;
  try {
    raw = readFileSync(safePath(root, contractPath), "utf8");
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    throw new PublicationError("contract_missing", "Run octo-manager pr init, then inspect .octo/pr-contract.json.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PublicationError("invalid_contract", "Fix the JSON syntax in .octo/pr-contract.json.");
  }
  if (!Check(ContractSchema, value))
    throw new PublicationError(
      "invalid_contract",
      "Fix .octo/pr-contract.json: use schemaVersion 1, template, and optional title/body format rules.",
    );
  safePath(root, value.template);
  return { contract: value, hash: digest(value) };
}

export function validateDraft(draft: Draft, contract: Contract): Finding[] {
  const findings: Finding[] = [];
  const add = (code: string, fix: string) => {
    findings.push({ code, fix });
  };
  if (draft.title.trim() === "") add("title_empty", "Provide a nonempty PR title.");
  if (
    Array.from(draft.title).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    draft.title.trimStart().startsWith("#")
  )
    add("title_format", "Use a single plain-text title line.");
  if (draft.body.trim() === "") add("body_empty", "Provide a nonempty PR description.");
  const maximum = contract.title?.maxLength;
  if (maximum !== undefined && Array.from(draft.title).length > maximum)
    add("title_length", `Shorten the title to ${String(maximum)} characters.`);
  const prefixes = contract.title?.prefixes;
  if (prefixes && prefixes.length > 0 && !prefixes.some((prefix) => draft.title.startsWith(prefix)))
    add("title_prefix", `Start the title with one of: ${prefixes.join(", ")}.`);
  const headings = new Set<string>();
  let fence: string | undefined;
  for (const line of draft.body.split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    const marker = fenceMatch?.[1];
    const suffix = fenceMatch?.[2] ?? "";
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && suffix.trim() === "") fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.[1];
    if (heading !== undefined) headings.add(heading.trim().toLowerCase());
  }
  for (const heading of contract.body?.requiredHeadings ?? [])
    if (!headings.has(heading.trim().toLowerCase())) add("heading_missing", `Add the required heading: ${heading}.`);
  for (const text of contract.body?.requiredText ?? [])
    if (!draft.body.includes(text)) add("text_missing", `Include the required text: ${text}.`);
  if (/<!--\s*octo:[^>]*-->/u.test(draft.body))
    add("template_unfilled", "Replace the Octo template prompts with the actual description.");
  if (Buffer.byteLength(draft.body) > 65536) add("body_size", "Keep the description within GitHub's 64 KiB limit.");
  return findings;
}

function install(root: string, path: string, text: string): void {
  const target = safePath(root, path);
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(target, text, { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

export function initialize(
  root: string,
  selected?: string,
): { contract: string; instructions: string; template: string } {
  root = realpathSync(root);
  const templates: string[] = [];
  for (const directory of ["", ".github", "docs", ".github/PULL_REQUEST_TEMPLATE", ".github/pull_request_template"]) {
    let names: string[];
    try {
      names = readdirSync(join(root, directory));
    } catch {
      continue;
    }
    for (const name of names) {
      if (
        /^pull_request_template\.md$/iu.test(name) ||
        (directory.toLowerCase().endsWith("/pull_request_template") && /\.md$/iu.test(name))
      )
        templates.push(join(directory, name));
    }
  }
  let configured: string | undefined;
  try {
    configured = readContract(root).contract.template;
  } catch (error) {
    if (!(error instanceof PublicationError && error.code === "contract_missing")) throw error;
  }
  if (configured === undefined && selected === undefined && templates.length > 1)
    throw new PublicationError("template_selection", "Multiple PR templates exist; rerun pr init --template PATH.");
  const template = configured ?? selected ?? templates[0] ?? ".github/pull_request_template.md";
  safePath(root, template);
  install(root, template, stockTemplate);
  install(root, contractPath, JSON.stringify({ schemaVersion: 1, template }, null, 2) + "\n");
  install(root, skillPath, skill);
  readContract(root);
  return { contract: contractPath, instructions: skillPath, template };
}
