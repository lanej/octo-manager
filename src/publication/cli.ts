import { workerModule } from "../package-root.js";
import { printAgentError, printResult } from "../cli/output.js";
import { parse, SubmissionSchema } from "../submissions/contracts.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { parseCommand } from "../cli/arguments.js";
import {
  initialize,
  readContract,
  validateDraft,
  PublicationError,
  skillPath,
  type Draft,
  type Contract,
  githubRepository,
} from "./contract.js";
import { PublicationStore, receipt, type Publication, type PublicationInput } from "./store.js";

const exec = promisify(execFile);
import { supportedTrackingTarget, TrackingHarness } from "../tracking/types.js";

type Parsed = ReturnType<typeof parseCommand>;

function clip(text: string, bytes: number): string {
  const chars = Array.from(text);
  while (Buffer.byteLength(JSON.stringify(chars.join(""))) > bytes) chars.pop();
  return chars.join("");
}

function emitOrdinary(value: unknown, budget = 1024): void {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > budget)
    throw new PublicationError(
      "response_budget",
      "Response exceeds the output budget; narrow the request or inspect a single receipt.",
    );
  console.log(output);
}

function error(code: string, fix: string): void {
  process.exitCode = 1;
  emitOrdinary({ error: { code: clip(code, 50), fix: clip(fix, 500) } });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, timeout: 15000, maxBuffer: 65536 })).stdout.trim();
}

async function rootPath(parsed: Parsed): Promise<string> {
  return git(resolve(parsed.values.cwd ?? process.cwd()), "rev-parse", "--show-toplevel");
}

function draft(parsed: Parsed): Draft {
  const title = parsed.values.title ?? "";
  const body =
    parsed.values["body-file"] === undefined
      ? (parsed.values.body ?? "")
      : readFileSync(resolve(parsed.values.cwd ?? process.cwd(), parsed.values["body-file"]), "utf8");
  return { title, body };
}

function check(root: string, value: Draft, contract?: Contract, agent = false): boolean {
  const findings = validateDraft(value, contract ?? readContract(root).contract);
  if (findings.length === 0) return true;
  process.exitCode = 1;
  if (agent) {
    printAgentError(findings.map((finding) => `${finding.code}: ${finding.fix}`).join("\n"), "validation_failed");
    return false;
  }
  emitOrdinary({
    valid: false,
    errors: findings.slice(0, 3).map((finding) => ({ code: finding.code, fix: clip(finding.fix, 180) })),
    remaining: Math.max(0, findings.length - 3),
  });
  return false;
}

function legacy(state: string, id: string): Record<string, unknown> | undefined {
  const file = join(state, "jobs.sqlite");
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT id,state,substr(json_extract(data,'$.detail'),1,240) AS detail,json_extract(data,'$.prUrl') AS url FROM pr_submissions WHERE id=?",
      )
      .get(id);
    return !row ? undefined : Object.fromEntries(Object.entries(row));
  } finally {
    db.close();
  }
}

function legacyDraft(state: string, id: string, root: string): PublicationInput {
  const db = new DatabaseSync(join(state, "jobs.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT data FROM pr_submissions WHERE id=?").get(id);
    if (typeof row?.["data"] !== "string") throw new PublicationError("not_found", "Legacy submission not found.");
    const old = parse(SubmissionSchema, JSON.parse(row["data"]));
    if (!old.brief || !["uncertain", "publishing", "enrolling"].includes(old.state))
      throw new PublicationError("legacy_request", "Legacy drafting is retired; submit a caller-written title/body.");
    return {
      title: old.brief.draft.title,
      body: old.brief.draft.body,
      repository: old.request.repository,
      root,
      headRef: old.request.headRef,
      headSha: old.request.headSha,
      baseRef: old.request.baseRef,
      draft: old.request.draft,
      contract: {
        schemaVersion: 1,
        template: ".github/pull_request_template.md",
      },
      contractHash: "legacy-reconciliation-only",
    };
  } finally {
    db.close();
  }
}

function legacyPage(state: string, before: number): { items: Record<string, unknown>[]; next?: number } {
  const file = join(state, "jobs.sqlite");
  if (!existsSync(file)) return { items: [] };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT rowid,id,state,substr(json_extract(data,'$.detail'),1,160) AS detail,substr(json_extract(data,'$.prUrl'),1,256) AS url FROM pr_submissions WHERE rowid<? ORDER BY rowid DESC LIMIT 5",
      )
      .all(before);
    return {
      items: rows.slice(0, 4).map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "rowid"))),
      ...(rows.length > 4 ? { next: Number(rows[3]?.["rowid"]) } : {}),
    };
  } finally {
    db.close();
  }
}

async function launch(state: string, value: Publication): Promise<void> {
  if (value.state === "published" && (!value.input.track || value.tracking === "active")) return;
  const worker = workerModule(
    "publication",
    new URL(
      existsSync(fileURLToPath(new URL("./worker.js", import.meta.url))) ? "./worker.js" : "./worker.ts",
      import.meta.url,
    ).href,
  );
  const child = spawn(process.execPath, [worker, state, value.id], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((fulfilled, rejected) => {
    child.once("spawn", fulfilled);
    child.once("error", rejected);
  });
  child.unref();
}

async function input(parsed: Parsed, root: string, value: Draft): Promise<PublicationInput> {
  const track = parsed.values.track;
  const harness = parsed.values.harness ?? TrackingHarness.Codex;
  const codex = Object.is(harness, TrackingHarness.Codex);
  const pi = Object.is(harness, TrackingHarness.Pi);
  const endpoint = parsed.values.endpoint ?? "local";
  const sessionId = parsed.values["thread-id"] ?? (codex ? process.env["CODEX_THREAD_ID"] : undefined);
  const identified = sessionId !== undefined && sessionId.trim() !== "";
  if (track === true && !codex && !(pi && endpoint === "local"))
    throw new PublicationError("tracking_harness", "Track a Codex session or an explicit local Pi session UUID.");
  if (track === true && !identified)
    throw new PublicationError(
      "tracking_owner",
      "Supply the actual --thread-id SESSION or, for Codex, CODEX_THREAD_ID.",
    );
  const headRef = parsed.values.head ?? (await git(root, "branch", "--show-current"));
  if (headRef === "") throw new PublicationError("detached_head", "Select a branch or pass --head BRANCH.");
  await git(root, "check-ref-format", "--branch", headRef);
  const headSha = await git(root, "rev-parse", "--verify", headRef + "^{commit}");
  if (parsed.values["expected-head"] !== undefined && parsed.values["expected-head"] !== headSha)
    throw new PublicationError(
      "head_changed",
      "The publication branch moved. Verify the new commit before publishing.",
    );
  const remote = parsed.values.repo === undefined ? await git(root, "remote", "get-url", "origin") : "";
  const repository = parsed.values.repo ?? githubRepository(remote);
  if (repository === undefined || !/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new PublicationError("repository_unknown", "Pass --repo OWNER/REPO for a GitHub repository.");
  let baseRef = parsed.values.base;
  if (baseRef === undefined) {
    try {
      baseRef = (await git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//u, "");
    } catch {
      for (const candidate of ["main", "master"]) {
        try {
          await git(root, "rev-parse", "--verify", "refs/remotes/origin/" + candidate);
          baseRef = candidate;
          break;
        } catch {
          continue;
        }
      }
    }
  }
  if (baseRef === undefined)
    throw new PublicationError(
      "base_unknown",
      "Pass --base BRANCH; the remote default branch is not recorded locally.",
    );
  await git(root, "check-ref-format", "--branch", baseRef);
  const configured = readContract(root);
  const result: PublicationInput = {
    ...value,
    root,
    repository,
    headRef,
    headSha,
    baseRef,
    draft: parsed.values.draft ?? false,
    contract: configured.contract,
    contractHash: configured.hash,
  };
  if (identified && (track === true || (track !== false && codex))) {
    if (!supportedTrackingTarget({ sessionId, endpoint, harness }))
      throw new PublicationError("tracking_harness", "Track a Codex session or an explicit local Pi session UUID.");
    result.track = {
      sessionId,
      endpoint,
      ...(pi ? { harness: TrackingHarness.Pi } : {}),
    };
  }
  return result;
}

export async function publicationCLI(parsed: Parsed): Promise<boolean> {
  const [command, argument] = parsed.positionals;
  const emit = (value: unknown, budget?: number): void => {
    if (!parsed.output.agent) emitOrdinary(value, budget);
    else if (command === "pr") console.log(JSON.stringify(value));
    else printResult(parsed, value);
  };
  const emitLaunchResult = (value: Publication): void => {
    if (value.state === "failed" || value.state === "uncertain") {
      process.exitCode = 1;
      if (parsed.output.agent) {
        printAgentError(
          typeof value.error === "string" ? value.error : (value.error?.fix ?? `Publisher launch ${value.state}`),
          `publication_${value.state}`,
          `Receipt ${value.id} is ${value.state}; inspect with octo-manager publication show ${value.id}`,
        );
        return;
      }
    }
    emit(receipt(value));
  };
  if (command === "pr" && !["init", "refresh", "instructions", "validate"].includes(argument ?? "")) return false;
  if (!["pr", "submit-pr", "submission", "submissions", "retry-submission"].includes(command ?? "")) return false;
  const state = resolve(
    parsed.values.state ?? process.env["OCTO_MANAGER_STATE"] ?? join(homedir(), ".local/state/octo-manager"),
  );
  try {
    if (command === "pr") {
      const root = await rootPath(parsed);
      if (argument === "init" || argument === "refresh") {
        const paths = initialize(root, parsed.values.template);
        if (parsed.values.derive === true || argument === "refresh") {
          const count = Number(parsed.values["sample-count"] ?? 20);
          if (!Number.isInteger(count) || count < 1 || count > 20)
            throw new PublicationError("sample_count", "Use --sample-count between 1 and 20.");
          const { deriveGuidance } = await import("./derive.js");
          const derived = await deriveGuidance(root, {
            remote: parsed.values["sample-remote"] ?? "origin",
            count,
            model: parsed.values.model ?? "gpt-6.1-terra",
          });
          emit({ ready: true, ...paths, derived });
        } else emit({ ready: true, ...paths });
      } else if (argument === "instructions") {
        console.log(readFileSync(join(root, skillPath), "utf8"));
      } else if (argument === "validate") {
        if (check(root, draft(parsed), undefined, parsed.output.agent)) emit({ valid: true });
      } else
        throw new PublicationError(
          "usage",
          "Use pr init, pr instructions, or pr validate --title TITLE --body-file FILE.",
        );
      return true;
    }
    if (command === "submit-pr") {
      if (parsed.values["intent-file"] !== undefined || parsed.values.purpose !== undefined)
        throw new PublicationError(
          "caller_draft_required",
          "Read the installed pr-description skill; submit the final --title TITLE --body-file FILE. Purpose-only requests no longer start a writer.",
        );
      const root = await rootPath(parsed),
        value = draft(parsed);
      if (!check(root, value, undefined, parsed.output.agent)) return true;
      const selected = await input(parsed, root, value);
      if (!check(root, value, selected.contract, parsed.output.agent)) return true;
      const store = new PublicationStore(state);
      try {
        const accepted = store.accept(selected, parsed.values["request-id"]);
        try {
          if (accepted.state === "pending") await launch(state, accepted);
        } catch {
          const current = store.launchFailure(accepted.id);
          emitLaunchResult(current);
          return true;
        }
        emit(receipt(accepted));
      } finally {
        store.close();
      }
      return true;
    }
    const store = new PublicationStore(state);
    try {
      if (command === "submissions") {
        const cursor = parsed.values.after === undefined ? Number.MAX_SAFE_INTEGER : Number(parsed.values.after);
        if (!Number.isSafeInteger(cursor) || cursor < 1)
          throw new PublicationError("cursor_invalid", "Use the next cursor returned by submissions.");
        if (parsed.values.legacy === true) {
          emit(legacyPage(state, cursor), 4096);
          return true;
        }
        const page = store.list(cursor, 4);
        emit(
          {
            items: page.items.map(receipt),
            ...(page.next === undefined ? {} : { next: page.next }),
          },
          4096,
        );
        return true;
      }
      if (argument === undefined) throw new PublicationError("id_required", "Pass a complete submission receipt ID.");
      let value: Publication;
      try {
        value = store.get(argument);
      } catch (failure) {
        if (!(failure instanceof PublicationError && failure.code === "not_found")) throw failure;
        const old = legacy(state, argument);
        if (!old) throw failure;
        if (command === "retry-submission") {
          value = store.adoptLegacy(
            argument,
            legacyDraft(state, argument, resolve(parsed.values.cwd ?? process.cwd())),
          );
        } else {
          emit({ ...old, legacy: true });
          return true;
        }
      }
      if (command === "retry-submission") {
        value = store.retry(argument);
        try {
          await launch(state, value);
        } catch {
          value = store.launchFailure(argument);
          emitLaunchResult(value);
          return true;
        }
      }
      emit(receipt(value));
    } finally {
      store.close();
    }
  } catch (failure) {
    const code = failure instanceof PublicationError ? failure.code : "publication_input";
    const message =
      failure instanceof PublicationError
        ? failure.message
        : "Could not read the draft or repository. Check file paths, Git configuration, and the installed format contract.";
    if (parsed.output.agent) {
      process.exitCode = 1;
      printAgentError(message, code);
    } else error(code, message);
  }
  return true;
}
