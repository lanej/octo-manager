import { sdkTransport, type GitHubTransport } from "../github/sdk.js";
import { trackingRequest } from "../client.js";
import { readContract, validateDraft, PublicationError } from "./contract.js";
import { PublicationStore, type PublicationInput, type Publication } from "./store.js";

export interface RemotePR {
  url: string;
  repository: string;
  headRepository: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  title: string;
  body: string;
  state: string;
}
export interface PublisherGitHub {
  revisions(input: PublicationInput): Promise<{ head: string; base: string }>;
  find(input: PublicationInput, marker: string): Promise<RemotePR | undefined>;
  create(input: PublicationInput, marker: string, dispatched: () => void): Promise<RemotePR>;
}

class Rejected extends PublicationError {}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid GitHub response.");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("Missing GitHub response field.");
  return value;
}

function remote(value: unknown): RemotePR {
  const item = object(value),
    head = object(item["head"]),
    base = object(item["base"]);
  const url = text(item["html_url"]);
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/u.test(url)) throw new Error("Invalid GitHub PR URL.");
  return {
    url,
    title: text(item["title"]),
    body: typeof item["body"] === "string" ? item["body"] : "",
    headSha: text(head["sha"]),
    headRef: text(head["ref"]),
    baseRef: text(base["ref"]),
    repository: text(object(base["repo"])["full_name"]),
    headRepository: text(object(head["repo"])["full_name"]),
    state: text(item["state"]),
  };
}

export class GitHubPublisher implements PublisherGitHub {
  constructor(private transport: GitHubTransport = sdkTransport()) {}

  private async read(path: string): Promise<unknown> {
    const response = await this.transport({ method: "GET", path });
    if (response.status < 200 || response.status >= 300)
      throw new PublicationError(
        "github_read",
        `GitHub read failed (HTTP ${String(response.status)}); check access and retry.`,
      );
    const value: unknown = JSON.parse(response.body);
    return value;
  }

  async revisions(input: PublicationInput): Promise<{ head: string; base: string }> {
    const ref = async (name: string) =>
      text(
        object(
          object(await this.read(`repos/${input.repository}/git/ref/heads/${encodeURIComponent(name)}`))["object"],
        )["sha"],
      );
    const [head, base] = await Promise.all([ref(input.headRef), ref(input.baseRef)]);
    return { head, base };
  }

  async find(input: PublicationInput, marker: string): Promise<RemotePR | undefined> {
    const owner = input.repository.split("/")[0] ?? "";
    let unrelated: string | undefined;
    for (let page = 1; page <= 10; page++) {
      const value = await this.read(
        `repos/${input.repository}/pulls?state=all&head=${encodeURIComponent(owner + ":" + input.headRef)}&base=${encodeURIComponent(input.baseRef)}&per_page=100&page=${String(page)}`,
      );
      if (!Array.isArray(value)) throw new Error("Invalid GitHub PR list.");
      for (const raw of value as unknown[]) {
        const item = object(raw);
        if (typeof item["body"] === "string" && item["body"].includes(marker)) return remote(raw);
        if (item["state"] === "open")
          unrelated = typeof item["html_url"] === "string" ? item["html_url"] : "this branch";
      }
      if (value.length < 100) {
        if (unrelated !== undefined)
          throw new PublicationError(
            "existing_pr",
            `An unrelated open PR exists for ${unrelated}; update that PR instead.`,
          );
        return undefined;
      }
    }
    throw new PublicationError(
      "lookup_incomplete",
      "PR lookup exceeded its bounded coverage; inspect before retrying.",
    );
  }

  async create(input: PublicationInput, marker: string, dispatched: () => void): Promise<RemotePR> {
    const result = await this.transport(
      {
        method: "POST",
        path: `repos/${input.repository}/pulls`,
        data: {
          title: input.title,
          body: input.body + "\n\n" + marker,
          head: input.headRef,
          base: input.baseRef,
          draft: input.draft,
        },
      },
      undefined,
      dispatched,
    );
    if (result.status >= 400 && result.status < 500)
      throw new Rejected(
        "github_rejected",
        `GitHub rejected this PR (HTTP ${String(result.status)}); check branch, access, and draft before resubmitting.`,
      );
    if (result.status < 200 || result.status >= 300) throw new Error("GitHub did not confirm publication.");
    const value: unknown = JSON.parse(result.body);
    return remote(value);
  }
}

function verify(input: PublicationInput, item: RemotePR, marker: string): void {
  if (
    item.url.split("/").slice(3, 5).join("/").toLowerCase() !== input.repository.toLowerCase() ||
    item.repository.toLowerCase() !== input.repository.toLowerCase() ||
    item.headRepository.toLowerCase() !== input.repository.toLowerCase() ||
    item.headRef !== input.headRef ||
    item.headSha !== input.headSha ||
    item.baseRef !== input.baseRef ||
    item.title !== input.title ||
    item.body !== input.body + "\n\n" + marker ||
    (item.state !== "open" && item.state !== "closed")
  ) {
    throw new Error("Published PR differs from the frozen request; inspect the remote PR before retrying.");
  }
}

export async function publishRequest(
  store: PublicationStore,
  id: string,
  github: PublisherGitHub = new GitHubPublisher(),
  enroll: (value: Publication) => Promise<void> = async (value) => {
    if (!value.input.track || value.url === undefined) return;
    await trackingRequest(store.directory.replace(/[/\\]publications$/u, ""), "track", undefined, {
      url: value.url,
      cwd: value.input.root,
      harness: value.input.track.harness ?? "codex",
      endpoint: value.input.track.endpoint,
      sessionId: value.input.track.sessionId,
      label: "PR publication",
    });
  },
): Promise<void> {
  store.get(id);
  const lock = store.lock(id);
  if (!lock) return;
  let value = store.get(id);
  try {
    if (value.state === "published") {
      if (value.input.track && value.tracking !== "active") {
        try {
          await enroll(value);
          value = { ...value, tracking: "active" };
        } catch {
          value = { ...value, tracking: "unavailable" };
        }
        store.save(value);
      }
      return;
    }
    const marker = `<!-- octo-submission:${id} -->`;
    const existing = await github.find(value.input, marker);
    if (existing) {
      value = { ...value, attempted: true };
      store.save(value);
      verify(value.input, existing, marker);
      value = { ...value, state: "published", url: existing.url };
      delete value.error;
      store.save(value);
    } else {
      if (value.attempted)
        throw new Error(
          "Publication may have happened but no matching PR is visible; inspect and retry reconciliation.",
        );
      const current = readContract(value.input.root);
      if (current.hash !== value.input.contractHash)
        throw new PublicationError(
          "contract_changed",
          "The format contract changed; validate and submit a new request.",
        );
      const findings = validateDraft(value.input, current.contract);
      if (findings.length > 0) throw new PublicationError("invalid_draft", findings[0]?.fix ?? "Fix the draft.");
      const before = await github.revisions(value.input);
      if (before.head !== value.input.headSha)
        throw new PublicationError("head_changed", "Push the selected commit and submit a new request.");
      const after = await github.revisions(value.input);
      if (before.base !== after.base || before.head !== after.head)
        throw new PublicationError("revision_changed", "Head or base changed during preflight; submit again.");
      const created = await github.create(value.input, marker, () => {
        value = { ...value, attempted: true };
        store.save(value);
      });
      verify(value.input, created, marker);
      value = { ...value, state: "published", url: created.url };
      delete value.error;
      store.save(value);
    }
    if (value.input.track && value.tracking !== "active") {
      try {
        await enroll(value);
        value = { ...value, tracking: "active" };
      } catch {
        value = { ...value, tracking: "unavailable" };
      }
      store.save(value);
    }
  } catch (error) {
    if (error instanceof Rejected) value = { ...value, attempted: false };
    const code =
      error instanceof PublicationError ? error.code : value.attempted ? "publication_uncertain" : "publication_failed";
    const fix =
      error instanceof PublicationError
        ? error.message
        : value.attempted
          ? "GitHub acceptance is unknown; retry this receipt to reconcile before any new submission."
          : "Publication failed before dispatch; check authentication/connectivity and retry this receipt.";
    value = {
      ...value,
      state: value.attempted ? "uncertain" : "failed",
      error: { code, fix },
    };
    store.save(value);
  } finally {
    lock.close();
  }
}
