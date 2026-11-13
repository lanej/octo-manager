import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  chmod,
  writeFile,
  link,
  unlink,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { canonicalPR } from "../tracking/github.js";
import type { AgentTarget } from "../tracking/types.js";

export interface Handoff {
  id: string;
  url: string;
  owner: AgentTarget;
  cwd: string;
  createdAt: number;
}
export interface FailedHandoff {
  handoff: Handoff;
  reason: string;
  at: number;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function handoffId(url: string, sessionId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([canonicalPR(url), sessionId]))
    .digest("hex");
}
export function parseHandoff(value: unknown): Handoff {
  if (!object(value) || !object(value["owner"]))
    throw new Error("Invalid PR handoff");
  const owner = value["owner"],
    url = value["url"],
    cwd = value["cwd"],
    sessionId = owner["sessionId"],
    label = owner["label"],
    createdAt = value["createdAt"];
  if (
    typeof url !== "string" ||
    url.length > 2048 ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    cwd.length > 4000 ||
    typeof sessionId !== "string" ||
    sessionId === "" ||
    sessionId.length > 200 ||
    owner["harness"] !== "codex" ||
    owner["endpoint"] !== "local" ||
    (label !== undefined &&
      (typeof label !== "string" || label.length > 200)) ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    value["id"] !== handoffId(url, sessionId)
  )
    throw new Error("Invalid PR handoff");
  return {
    id: handoffId(url, sessionId),
    url: canonicalPR(url),
    cwd,
    owner: {
      harness: "codex",
      endpoint: "local",
      sessionId,
      ...(label === undefined ? {} : { label }),
    },
    createdAt,
  };
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (
    !(await lstat(path)).isDirectory() ||
    (await lstat(path)).isSymbolicLink()
  )
    throw new Error("Handoff directory must be private and not a symlink");
  await chmod(path, 0o700);
}
async function statusFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (object(error) && error["code"] === "ENOENT") return undefined;
    throw error;
  }
}
export class Handoffs {
  private root: string;
  constructor(
    directory: string,
    private now: () => number = Date.now,
  ) {
    this.root = join(directory, "handoffs");
  }
  private async directories(): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, "pending"));
    await privateDirectory(join(this.root, "failed"));
  }
  async enqueue(
    url: string,
    owner: AgentTarget,
    cwd: string,
  ): Promise<Handoff> {
    const request = parseHandoff({
      id: handoffId(url, owner.sessionId),
      url,
      owner,
      cwd,
      createdAt: this.now(),
    });
    if (Buffer.byteLength(JSON.stringify(request)) > 16000)
      throw new Error("PR handoff exceeds its size limit");
    await this.directories();
    const path = join(this.root, "pending", `${request.id}.json`),
      temporary = join(this.root, `.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(request), {
      mode: 0o600,
      flag: "wx",
    });
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(object(error) && error["code"] === "EEXIST")) throw error;
    } finally {
      await unlink(temporary);
    }
    return request;
  }
  private async entries(folder: "pending" | "failed"): Promise<string[]> {
    try {
      return (await readdir(join(this.root, folder)))
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .sort()
        .slice(0, 1000);
    } catch (error) {
      if (object(error) && error["code"] === "ENOENT") return [];
      throw error;
    }
  }
  async drain(
    accept: (
      handoff: Handoff,
    ) => { accepted: true } | { accepted: false; reason: string },
  ): Promise<void> {
    for (const file of (await this.entries("pending")).slice(0, 20)) {
      const path = join(this.root, "pending", file);
      let handoff: Handoff;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000)
          throw new Error("Invalid handoff file");
        handoff = parseHandoff(JSON.parse(await readFile(path, "utf8")));
        if (file !== `${handoff.id}.json`)
          throw new Error("Handoff identity mismatch");
      } catch {
        await rename(path, join(this.root, "failed", `${file}.invalid`));
        continue;
      }
      const result = accept(handoff);
      if (!result.accepted) {
        const failed: FailedHandoff = {
          handoff,
          reason: result.reason.slice(0, 2000),
          at: this.now(),
        };
        const temporary = join(this.root, `.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(failed), {
            mode: 0o600,
            flag: "wx",
          });
          await rename(temporary, join(this.root, "failed", file));
        } finally {
          await rm(temporary, { force: true });
        }
      }
      if (result.accepted) {
        try {
          await rename(
            join(this.root, "failed", file),
            join(
              this.root,
              "failed",
              `${handoff.id}.resolved-${randomUUID()}.json`,
            ),
          );
        } catch (error) {
          if (!(object(error) && error["code"] === "ENOENT")) throw error;
        }
      }
      await unlink(path);
    }
  }
  async status(
    sessionId: string,
  ): Promise<{ pending: Handoff[]; failed: FailedHandoff[] }> {
    const pending: Handoff[] = [],
      failed: FailedHandoff[] = [];
    for (const file of await this.entries("pending")) {
      const content = await statusFile(join(this.root, "pending", file));
      if (content === undefined) continue;
      const value = parseHandoff(JSON.parse(content));
      if (value.owner.sessionId === sessionId) pending.push(value);
    }
    for (const file of await this.entries("failed")) {
      const content = await statusFile(join(this.root, "failed", file));
      if (content === undefined) continue;
      const raw: unknown = JSON.parse(content);
      if (
        !object(raw) ||
        typeof raw["reason"] !== "string" ||
        typeof raw["at"] !== "number"
      )
        continue;
      const handoff = parseHandoff(raw["handoff"]);
      if (handoff.owner.sessionId === sessionId)
        failed.push({ handoff, reason: raw["reason"], at: raw["at"] });
    }
    return { pending, failed };
  }
}
