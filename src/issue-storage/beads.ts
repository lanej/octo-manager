import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  sameContent,
  decodeContent,
  type IssueContent,
  type IssueRepository,
} from "../issues/repository.js";

const recordSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  status: Type.String(),
  updated_at: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
});
const commentSchema = Type.Array(
  Type.Object({
    id: Type.String(),
    author: Type.String(),
    text: Type.String(),
    created_at: Type.String(),
  }),
);
type Command = (
  args: string[],
  input: string | undefined,
  signal: AbortSignal,
) => Promise<string>;
function native(binary: string, workspace: string): Command {
  return (args, input, signal) =>
    new Promise((resolve, reject) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("BEADS_") &&
            !key.startsWith("BD_") &&
            !key.startsWith("DOLT_"),
        ),
      );
      const child = execFile(
        binary,
        ["-C", workspace, "--sandbox", "--json", ...args],
        {
          cwd: workspace,
          env,
          signal,
          timeout: 15000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            const detail =
              stderr.length > 0
                ? stderr
                : stdout.length > 0
                  ? stdout
                  : error.message;
            reject(
              new Error(
                `Issue storage command failed: ${detail.slice(0, 1000)}`,
              ),
            );
          } else resolve(stdout);
        },
      );
      child.stdin?.end(input);
    });
}
function commentId(id: string, revision: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([id, revision]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/** Native Beads identities never cross the persistence boundary. */
export class BeadsIssueRepository implements IssueRepository {
  readonly identity: string;
  private command: Command;
  constructor(workspace: string, binary = "bd", command?: Command) {
    if (!isAbsolute(workspace))
      throw new Error("Issue storage workspace must be absolute");
    const root = realpathSync(workspace);
    this.identity = `beads:${root}`;
    this.command = command ?? native(binary, root);
  }
  private key(id: string): string {
    if (!/^[0-9a-f-]{36}$/u.test(id))
      throw new Error("Invalid Octo issue identity");
    return `octo-${id}`;
  }
  private async raw(id: string, signal: AbortSignal) {
    // An empty filtered list means absent; command failures must never mean absence.
    const parsed: unknown = JSON.parse(
      await this.command(
        ["list", "--all", "--id", this.key(id), "--limit", "1"],
        undefined,
        signal,
      ),
    );
    if (!Array.isArray(parsed) || parsed.length > 1)
      throw new Error("Invalid issue storage response");
    if (parsed.length === 0) return undefined;
    const value: unknown = parsed[0];
    if (!Check(recordSchema, value) || value.id !== this.key(id))
      throw new Error("Invalid stored issue identity or fields");
    return value;
  }
  async read(
    id: string,
    signal: AbortSignal,
  ): Promise<IssueContent | undefined> {
    const value = await this.raw(id, signal);
    if (value === undefined) return undefined;
    return this.document(id, value, await this.comments(id, signal));
  }
  private async comments(id: string, signal: AbortSignal) {
    const value: unknown = JSON.parse(
      await this.command(["comments", this.key(id)], undefined, signal),
    );
    if (!Check(commentSchema, value))
      throw new Error("Invalid stored comments");
    return value;
  }
  private document(
    id: string,
    value: Static<typeof recordSchema>,
    comments: Static<typeof commentSchema>,
  ): IssueContent {
    const content = decodeContent(value.metadata["octo.document"]);
    if (content.id !== id) throw new Error("Issue storage identity mismatch");
    const timestamp = Date.parse(value.updated_at);
    if (!Number.isFinite(timestamp))
      throw new Error("Invalid issue storage timestamp");
    const expected = new Set(
      content.comments.map((item) => commentId(item.id, item.revision)),
    );
    const known = value.metadata["octo.commentIds"];
    if (
      !Array.isArray(known) ||
      !known.every((item: unknown) => typeof item === "string")
    )
      throw new Error("Invalid stored comment identities");
    const local = comments
      .filter((item) => !known.includes(item.id) && !expected.has(item.id))
      .map((item) => ({
        id: `local:${item.id}`,
        revision: item.created_at,
        author: item.author,
        body: item.text,
        url: content.ref.url,
      }));
    const title =
      content.title === "" && value.title === "Untitled Octo issue"
        ? ""
        : value.title;
    const changed =
      title !== content.title ||
      (value.description ?? "") !== content.body ||
      (value.status === "closed") !== content.externalClosed ||
      local.length > 0;
    const fieldTimes = { ...content.fieldTimes };
    if (title !== content.title) fieldTimes.title = timestamp;
    if ((value.description ?? "") !== content.body) fieldTimes.body = timestamp;
    if ((value.status === "closed") !== content.externalClosed)
      fieldTimes.externalClosed = timestamp;
    return decodeContent({
      ...content,
      ...(changed ? { fieldTimes } : {}),
      title,
      body: value.description ?? "",
      externalClosed: value.status === "closed",
      comments: [
        ...new Map(
          [...content.comments, ...local].map((item) => [item.id, item]),
        ).values(),
      ],
      updatedAt: changed
        ? Math.max(timestamp, content.updatedAt)
        : content.updatedAt,
    });
  }
  async write(
    content: IssueContent,
    signal: AbortSignal,
    expected: IssueContent | undefined,
  ): Promise<void> {
    decodeContent(content);
    const existing = await this.raw(content.id, signal);
    const previous = existing?.metadata["octo.commentIds"];
    if (
      previous !== undefined &&
      (!Array.isArray(previous) ||
        !previous.every((item: unknown) => typeof item === "string"))
    )
      throw new Error("Invalid stored comment identities");
    const times: unknown = existing?.metadata["octo.commentTimes"] ?? {};
    if (!Check(Type.Record(Type.String(), Type.String()), times))
      throw new Error("Invalid stored comment timestamps");
    const storedComments =
      existing === undefined ? [] : await this.comments(content.id, signal);
    const actual =
      existing === undefined
        ? undefined
        : this.document(content.id, existing, storedComments);
    if (
      (actual === undefined) !== (expected === undefined) ||
      (actual !== undefined &&
        expected !== undefined &&
        !sameContent(actual, expected))
    )
      throw new Error(
        "Issue storage changed during persistence; retry reconciliation",
      );
    const nativeIds = new Set(storedComments.map((item) => `local:${item.id}`));
    const comments = content.comments
      .filter((item) => !nativeIds.has(item.id))
      .map((item) => {
        const id = commentId(item.id, item.revision);
        const sourceAt = Date.parse(item.revision);
        times[id] ??= new Date(
          Number.isFinite(sourceAt) ? sourceAt : content.updatedAt,
        ).toISOString();
        return {
          id,
          issue_id: this.key(content.id),
          author: item.author,
          text: item.body,
          created_at: times[id],
        };
      });
    const metadata = {
      ...existing?.metadata,
      "octo.document": content,
      "octo.commentTimes": times,
      "octo.commentIds": [
        ...new Set([...(previous ?? []), ...comments.map((item) => item.id)]),
      ],
    };
    const record = {
      ...(existing ?? { issue_type: "task", priority: 2 }),
      id: this.key(content.id),
      title: content.title !== "" ? content.title : "Untitled Octo issue",
      description: content.body,
      status: content.externalClosed
        ? "closed"
        : existing !== undefined && existing.status !== "closed"
          ? existing.status
          : "open",
      updated_at: new Date(
        Math.max(
          content.updatedAt,
          existing === undefined ? 0 : Date.parse(existing.updated_at) + 1000,
        ),
      ).toISOString(),
      external_ref: content.ref.url,
      metadata,
      comments,
    };
    // Native import has no row-version CAS; a writer after this check follows provider ordering.
    await this.command(["import", "-"], JSON.stringify(record) + "\n", signal);
  }
}
