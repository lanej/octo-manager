import { posix } from "node:path";
import { githubReads } from "../github-api.js";
import { ghRead, type ReadGitHub, canonicalPR } from "../tracking/github.js";
import {
  hash,
  isPullRequestTemplate,
  policyAnalystVersion,
  type RepositorySnapshot,
  type Source,
  type SubmissionInput,
  type WriterDraft,
} from "./contracts.js";
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid GitHub submission response");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== "string" || value === "")
    throw new Error("Invalid GitHub submission text");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("Invalid GitHub submission collection");
  return value;
}
export interface PublishedPR {
  url: string;
  headSha: string;
  body: string;
  state: string;
}
export interface SubmissionGitHub {
  snapshot(
    request: SubmissionInput,
    signal: AbortSignal,
  ): Promise<RepositorySnapshot>;
  verify(
    request: SubmissionInput,
    baseSha: string,
    signal: AbortSignal,
  ): Promise<void>;
  find(
    request: SubmissionInput,
    marker: string,
    signal: AbortSignal,
  ): Promise<PublishedPR | undefined>;
  publish(
    request: SubmissionInput,
    draft: WriterDraft,
    marker: string,
    signal: AbortSignal,
  ): Promise<PublishedPR>;
}
export class GitHubSubmissions implements SubmissionGitHub {
  constructor(private read: ReadGitHub = ghRead) {}
  private async ref(
    repository: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<string> {
    const value = record(
      await this.read(
        `repos/${repository}/git/ref/heads/${encodeURIComponent(ref)}`,
        signal,
      ),
    );
    return string(record(value["object"])["sha"]);
  }
  async verify(
    request: SubmissionInput,
    baseSha: string,
    signal: AbortSignal,
  ): Promise<void> {
    const [head, base] = await Promise.all([
      this.ref(request.repository, request.headRef, signal),
      this.ref(request.repository, request.baseRef, signal),
    ]);
    if (head !== request.headSha)
      throw new Error(
        "Head branch changed; submit a new request for its new revision",
      );
    if (base !== baseSha)
      throw new Error(
        "Base branch changed; submit a new request with fresh analysis",
      );
  }
  async snapshot(
    request: SubmissionInput,
    signal: AbortSignal,
  ): Promise<RepositorySnapshot> {
    const repository = request.repository.toLowerCase();
    const info = record(await this.read(`repos/${repository}`, signal));
    if (typeof info["private"] !== "boolean")
      throw new Error("Repository visibility is unavailable");
    const [head, baseSha] = await Promise.all([
      this.ref(repository, request.headRef, signal),
      this.ref(repository, request.baseRef, signal),
    ]);
    if (head !== request.headSha)
      throw new Error("Push the selected head revision before submitting");
    const comparison = record(
      await this.read(
        `repos/${repository}/compare/${baseSha}...${head}`,
        signal,
      ),
    );
    const files = list(comparison["files"]).map(record);
    if (files.length === 0) throw new Error("No change against selected base");
    if (files.length >= 300)
      throw new Error(
        "Compare file coverage may be incomplete; split this submission",
      );
    const parts = files.map(
      (file) =>
        `${string(file["filename"])} (${string(file["status"])})\n${typeof file["patch"] === "string" ? file["patch"] : "[Patch unavailable; no behavioral claims may be inferred from missing text]"}`,
    );
    const diff = parts.join("\n\n");
    if (Buffer.byteLength(diff) > 512 * 1024)
      throw new Error(
        "Submission diff exceeds the bounded writer context; split the change",
      );
    const tree = record(
      await this.read(
        `repos/${repository}/git/trees/${baseSha}?recursive=1`,
        signal,
      ),
    );
    if (tree["truncated"] !== false)
      throw new Error("Repository policy tree coverage is incomplete");
    const blobs = new Map<string, string>();
    for (const item of list(tree["tree"]).map(record))
      if (item["type"] === "blob" && item["mode"] !== "120000")
        blobs.set(string(item["path"]), string(item["sha"]));
    const policyPath = (path: string) =>
      /(?:^|\/)AGENTS\.md$/i.test(path) ||
      /(?:^|\/)(?:CONTRIBUTING)(?:\.[^/]*)?$/i.test(path) ||
      isPullRequestTemplate(path);
    const pending = [...blobs.keys()].filter(policyPath).sort();
    const sources: Source[] = [];
    let bytes = 0;
    for (let index = 0; index < pending.length; index++) {
      const path = pending[index];
      if (path === undefined) continue;
      if (sources.length >= 100)
        throw new Error("Repository policy exceeds 100 source files");
      const sha = blobs.get(path);
      if (sha === undefined) continue;
      const blob = record(
        await this.read(`repos/${repository}/git/blobs/${sha}`, signal),
      );
      if (blob["encoding"] !== "base64")
        throw new Error("Unsupported repository policy encoding");
      const text = Buffer.from(string(blob["content"]), "base64").toString(
        "utf8",
      );
      bytes += Buffer.byteLength(text);
      if (Buffer.byteLength(text) > 131072 || bytes > 1024 * 1024)
        throw new Error("Repository policy context exceeds its size limit");
      sources.push({ path, sha, text });
      for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
        const href = match[1]?.split("#")[0];
        if (
          href === undefined ||
          href === "" ||
          /^(?:[a-z]+:|\/|~)/i.test(href)
        )
          continue;
        const linked = posix.normalize(posix.join(posix.dirname(path), href));
        if (
          !linked.startsWith("../") &&
          linked.endsWith(".md") &&
          blobs.has(linked) &&
          !pending.includes(linked)
        )
          pending.push(linked);
      }
    }
    sources.sort((a, b) => a.path.localeCompare(b.path));
    return {
      repository,
      headSha: head,
      baseSha,
      private: info["private"],
      files: files.map((file) => string(file["filename"])),
      diff,
      sources,
      sourceDigest: hash({
        repository,
        sources: sources.map(({ path, sha }) => ({ path, sha })),
        stockVersion: 1,
        analystVersion: policyAnalystVersion,
      }),
    };
  }
  async find(
    request: SubmissionInput,
    marker: string,
    signal: AbortSignal,
  ): Promise<PublishedPR | undefined> {
    const owner = request.repository.split("/")[0] ?? "";
    for (let page = 1; page <= 10; page++) {
      const items = list(
        await this.read(
          `repos/${request.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${request.headRef}`)}&base=${encodeURIComponent(request.baseRef)}&per_page=100&page=${String(page)}`,
          signal,
        ),
      );
      for (const raw of items) {
        const item = record(raw),
          body = typeof item["body"] === "string" ? item["body"] : "";
        if (body.includes(marker))
          return {
            url: canonicalPR(string(item["html_url"])),
            headSha: string(record(item["head"])["sha"]),
            body,
            state: string(item["state"]),
          };
        if (item["state"] === "open")
          throw new Error(
            `An unrelated PR already exists: ${string(item["html_url"])}`,
          );
      }
      if (items.length < 100) return undefined;
    }
    throw new Error(
      "PR lookup coverage is incomplete; publication cannot safely continue",
    );
  }
  async publish(
    request: SubmissionInput,
    draft: WriterDraft,
    marker: string,
    signal: AbortSignal,
  ): Promise<PublishedPR> {
    const item = record(
      await githubReads.post(
        `repos/${request.repository}/pulls`,
        {
          title: draft.title,
          body: `${draft.body}\n\n${marker}`,
          head: request.headRef,
          base: request.baseRef,
          draft: request.draft,
        },
        signal,
      ),
    );
    return {
      url: canonicalPR(string(item["html_url"])),
      headSha: string(record(item["head"])["sha"]),
      body: string(item["body"]),
      state: string(item["state"]),
    };
  }
}
