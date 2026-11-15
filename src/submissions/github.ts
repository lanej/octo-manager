import { parsedConfig } from "./public-contracts.js";
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
  title?: string;
  baseRef?: string;
  baseSha?: string;
  targetBaseSha?: string;
  headRepository?: string;
  headRef?: string;
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
    snapshot?: RepositorySnapshot,
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
export type WriteSubmissionGitHub = (
  path: string,
  fields: Record<string, string | boolean>,
  method: "POST" | "PATCH",
  signal: AbortSignal,
) => Promise<unknown>;
export class GitHubSubmissions implements SubmissionGitHub {
  constructor(
    private read: ReadGitHub = ghRead,
    private write: WriteSubmissionGitHub = (path, fields, method, signal) =>
      method === "POST"
        ? githubReads.post(path, fields, signal)
        : githubReads.patch(path, fields, signal),
  ) {}
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
    snapshot?: RepositorySnapshot,
  ): Promise<void> {
    const [head, base] = await Promise.all([
      this.ref(
        request.headRepository ?? request.repository,
        request.headRef,
        signal,
      ),
      this.ref(request.repository, request.baseRef, signal),
    ]);
    if (head !== request.headSha)
      throw new Error("Head branch changed; prepare its new revision");
    if (base !== baseSha)
      throw new Error("Base branch changed; prepare with fresh analysis");
    if (request.updateUrl !== undefined) {
      if (snapshot?.existing === undefined)
        throw new Error("Missing original PR description for update");
      const current = await this.existing(request, signal);
      if (
        current.title !== snapshot.existing.title ||
        current.body !== snapshot.existing.body ||
        current.headSha !== snapshot.existing.headSha ||
        current.headRepository !== snapshot.existing.headRepository ||
        current.headRef !== snapshot.existing.headRef ||
        current.baseRef !== snapshot.existing.baseRef
      )
        throw new Error(
          "PR title, body, head, or base changed after preparation; prepare again",
        );
    }
  }
  private updatePath(request: SubmissionInput): string {
    const url = canonicalPR(request.updateUrl ?? "");
    if (
      !url
        .toLowerCase()
        .startsWith(
          `https://github.com/${request.repository.toLowerCase()}/pull/`,
        )
    )
      throw new Error("Update PR belongs to a different repository");
    return `repos/${request.repository}/pulls/${url.split("/").at(-1) ?? ""}`;
  }
  private async existing(request: SubmissionInput, signal: AbortSignal) {
    const item = record(await this.read(this.updatePath(request), signal)),
      head = record(item["head"]),
      base = record(item["base"]);
    if (item["state"] !== "open")
      throw new Error("Only open PR descriptions can be updated");
    return {
      url: canonicalPR(string(item["html_url"])),
      title: string(item["title"]),
      body: typeof item["body"] === "string" ? item["body"] : "",
      headSha: string(head["sha"]),
      headRepository: string(record(head["repo"])["full_name"]),
      headRef: string(head["ref"]),
      baseRef: string(base["ref"]),
      baseSha: string(base["sha"]),
    };
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
      this.ref(request.headRepository ?? repository, request.headRef, signal),
      this.ref(repository, request.baseRef, signal),
    ]);
    if (head !== request.headSha)
      throw new Error("Push the selected head revision before submitting");
    const existing =
      request.updateUrl === undefined
        ? undefined
        : await this.existing(request, signal);
    if (
      existing !== undefined &&
      (existing.headSha !== head ||
        existing.headRepository.toLowerCase() !==
          (request.headRepository ?? repository).toLowerCase() ||
        existing.headRef !== request.headRef ||
        existing.baseRef !== request.baseRef)
    )
      throw new Error("Update PR identity disagrees with selected refs");
    const headOwner =
      (request.headRepository ?? repository).split("/")[0] ?? "";
    const comparison = record(
      await this.read(
        `repos/${repository}/compare/${baseSha}...${encodeURIComponent(`${headOwner}:${head}`)}`,
        signal,
      ),
    );
    const files = list(comparison["files"]).map(record);
    if (files.length === 0 && request.mode !== "policy")
      throw new Error("No change against selected base");
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
    const configSha = blobs.get("octo-manager.toml");
    let contractToml: string | undefined;
    if (configSha !== undefined) {
      const config = record(
        await this.read(`repos/${repository}/git/blobs/${configSha}`, signal),
      );
      if (config["encoding"] !== "base64")
        throw new Error("Unsupported Octo config encoding");
      contractToml = Buffer.from(string(config["content"]), "base64").toString(
        "utf8",
      );
    }
    const referenceVisibility = new Map([[repository, info["private"]]]);
    const references: NonNullable<RepositorySnapshot["references"]> = [];
    for (const reference of request.references ?? []) {
      const match =
        /^(?:https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/|([\w.-]+\/[\w.-]+)?#)([1-9]\d*)$/u.exec(
          reference,
        );
      if (match === null)
        throw new Error(`Invalid GitHub reference: ${reference}`);
      const refRepo = match[1] ?? match[2] ?? repository,
        number = Number(match[3]);
      const item = record(
        await this.read(`repos/${refRepo}/issues/${String(number)}`, signal),
      );
      let refPrivate = referenceVisibility.get(refRepo);
      if (refPrivate === undefined) {
        const refInfo = record(await this.read("repos/" + refRepo, signal));
        if (typeof refInfo["private"] !== "boolean")
          throw new Error("Reference visibility is unavailable");
        refPrivate = refInfo["private"];
        referenceVisibility.set(refRepo, refPrivate);
      }
      const body = typeof item["body"] === "string" ? item["body"] : "";
      if (Buffer.byteLength(body) > 32000)
        throw new Error(`Reference body exceeds context bound: ${reference}`);
      references.push({
        repository: refRepo,
        private: refPrivate,
        number,
        kind: item["pull_request"] === undefined ? "issue" : "pr",
        title: string(item["title"]),
        body,
        url: string(item["html_url"]),
        updatedAt: string(item["updated_at"]),
      });
    }
    sources.sort((a, b) => a.path.localeCompare(b.path));
    return {
      repository,
      ...(contractToml === undefined
        ? {}
        : parsedConfig(contractToml, "octo-manager.toml", configSha)),
      ...(existing === undefined ? {} : { existing }),
      references,
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
    if (request.updateUrl !== undefined) {
      const item = await this.existing(request, signal);
      return item.body.includes(marker)
        ? {
            url: item.url,
            headSha: item.headSha,
            body: item.body,
            title: item.title,
            baseRef: item.baseRef,
            baseSha: item.baseSha,
            targetBaseSha: await this.ref(
              request.repository,
              item.baseRef,
              signal,
            ),
            headRepository: item.headRepository,
            headRef: item.headRef,
            state: "open",
          }
        : undefined;
    }
    const owner =
      (request.headRepository ?? request.repository).split("/")[0] ?? "";
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
            title: string(item["title"]),
            baseRef: string(record(item["base"])["ref"]),
            baseSha: string(record(item["base"])["sha"]),
            targetBaseSha: await this.ref(
              request.repository,
              string(record(item["base"])["ref"]),
              signal,
            ),
            headRepository: string(
              record(record(item["head"])["repo"])["full_name"],
            ),
            headRef: string(record(item["head"])["ref"]),
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
    const written = record(
      await this.write(
        request.updateUrl === undefined
          ? `repos/${request.repository}/pulls`
          : this.updatePath(request),
        {
          title: draft.title,
          body: `${draft.body}\n\n${marker}`,
          ...(request.updateUrl === undefined
            ? {
                head: `${(request.headRepository ?? request.repository).split("/")[0] ?? ""}:${request.headRef}`,
                base: request.baseRef,
                draft: request.draft,
              }
            : {}),
        },
        request.updateUrl === undefined ? "POST" : "PATCH",
        signal,
      ),
    );
    const url = canonicalPR(string(written["html_url"]));
    if (
      !url
        .toLowerCase()
        .startsWith(
          `https://github.com/${request.repository.toLowerCase()}/pull/`,
        )
    )
      throw new Error("Published PR belongs to another repository");
    const item = record(
      await this.read(
        `repos/${request.repository}/pulls/${url.split("/").at(-1) ?? ""}`,
        signal,
      ),
    );
    return {
      url: canonicalPR(string(item["html_url"])),
      baseRef: string(record(item["base"])["ref"]),
      baseSha: string(record(item["base"])["sha"]),
      targetBaseSha: await this.ref(
        request.repository,
        string(record(item["base"])["ref"]),
        signal,
      ),
      headRepository: string(record(record(item["head"])["repo"])["full_name"]),
      headRef: string(record(item["head"])["ref"]),
      headSha: string(record(item["head"])["sha"]),
      body: string(item["body"]),
      title: string(item["title"]),
      state: string(item["state"]),
    };
  }
}
