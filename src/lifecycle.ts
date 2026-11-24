import { requireBun } from "./runtime.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const program = import.meta.url.endsWith(".ts") ? "src" : "dist";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
}

function loadedHost(): string | null {
  requireBun(process.versions["bun"]);
  const image =
    process.platform === "linux"
      ? `/proc/${String(process.pid)}/exe`
      : realpathSync(process.execPath);
  const descriptor = openSync(image, "r");
  try {
    const selected = fstatSync(descriptor, { bigint: true });
    if (!selected.isFile()) return null;
    if (process.platform === "darwin") {
      const output = execFileSync(
        "/usr/sbin/lsof",
        ["-a", "-p", String(process.pid), "-d", "txt", "-F", "Dfin"],
        { encoding: "utf8" },
      );
      let device: bigint | undefined;
      let matched = false;
      for (const line of output.split("\n")) {
        if (line.startsWith("f")) device = undefined;
        else if (line.startsWith("D")) device = BigInt(line.slice(1));
        else if (
          line.startsWith("i") &&
          device === selected.dev &&
          BigInt(line.slice(1)) === selected.ino
        )
          matched = true;
      }
      if (!matched) return null;
    } else if (process.platform !== "linux") return null;
    const digest = createHash("sha256")
      .update(readFileSync(descriptor))
      .digest("hex");
    const current = fstatSync(descriptor, { bigint: true });
    return current.dev === selected.dev &&
      current.ino === selected.ino &&
      current.size === selected.size &&
      current.mtimeNs === selected.mtimeNs &&
      current.ctimeNs === selected.ctimeNs
      ? digest
      : null;
  } finally {
    closeSync(descriptor);
  }
}

/** Identity of the loaded package and kernel-mapped environment host, captured before serving. */
export function artifactIdentity(): string | null {
  if (program !== "dist" || !root.includes("/releases/")) return null;
  let host: string | null;
  try {
    host = loadedHost();
  } catch {
    return null;
  }
  if (host === null) return null;
  const hash = createHash("sha256").update("host\0").update(host).update("\0");
  const names = [
    ...files(join(root, program)),
    ...files(join(root, "node_modules")),
    ...["package.json", "bun.lock", "build/octo-manager-tui"]
      .map((name) => join(root, name))
      .filter(existsSync),
  ];
  for (const path of names) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() && !realpathSync(path).startsWith(root + "/"))
      return null;
    hash.update(path.slice(root.length));
    hash.update("\0");
    hash.update(
      info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface ActivationProcess {
  pid: number;
  start_identity: string;
  native_id: string;
  owner_verified: boolean;
}
export interface ActivationTarget {
  target: string;
  expected_identity: string | null;
  running_identity: string | null;
  ready: boolean;
  process: ActivationProcess;
  sessions: [];
  scheduler_paused: boolean;
  retirement_policy: "successful-exit" | "unknown";
  stop_accepted: boolean;
  checkpoint?: { state: "confirmed" | "refused" | "pending"; run_id: string };
  reason?: string;
}
export interface ActivationReport {
  schema_version: 1;
  targets: [ActivationTarget];
}

export class Activation {
  private readonly incarnation = randomUUID();
  private operation: string | undefined;
  private checkpointed = false;
  private stopped = false;
  private readonly restored = new Set<string>();
  readonly identity = artifactIdentity();
  private readonly retirement =
    this.identity !== null &&
    process.env["PROJECT_UPDATE_RETIREMENT_POLICY"] === "successful-exit";

  report(ready: boolean, paused: boolean): ActivationReport {
    const target: ActivationTarget = {
      target: "local",
      expected_identity: this.identity,
      running_identity: this.identity,
      ready,
      process: {
        pid: process.pid,
        start_identity: this.incarnation,
        native_id: this.incarnation,
        owner_verified: true,
      },
      sessions: [],
      scheduler_paused: paused,
      retirement_policy: this.retirement ? "successful-exit" : "unknown",
      stop_accepted: this.stopped,
    };
    if (this.operation !== undefined)
      target.checkpoint = {
        state: this.checkpointed ? "confirmed" : "pending",
        run_id: this.operation,
      };
    return { schema_version: 1, targets: [target] };
  }

  claim(incarnation: string, operation: string): void {
    if (
      this.stopped ||
      this.restored.has(operation) ||
      incarnation !== this.incarnation ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        operation,
      ) ||
      (this.operation !== undefined && this.operation !== operation)
    )
      throw new Error("Checkpoint process incarnation or owner differs");
    this.operation = operation;
  }

  restore(incarnation: string, operation: string): boolean {
    if (this.stopped)
      throw new Error("Retirement is irreversible; preserve closed admission");
    if (
      incarnation !== this.incarnation ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        operation,
      )
    )
      throw new Error("Restore process incarnation or operation differs");
    if (this.restored.has(operation)) return false;
    this.restored.add(operation);
    return true;
  }

  stop(incarnation: string, operation: string): boolean {
    if (
      incarnation !== this.incarnation ||
      operation !== this.operation ||
      !this.checkpointed ||
      this.identity === null ||
      !this.retirement
    )
      throw new Error(
        "Native retirement policy, checkpoint, or process owner differs",
      );
    if (this.stopped) return false;
    this.stopped = true;
    return true;
  }

  confirm(): void {
    this.checkpointed = true;
  }
}
