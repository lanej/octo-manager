import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import type { DatabaseSync } from "node:sqlite";
import { githubRepository } from "../publication/contract.js";
import type { TrackingStore } from "../tracking/store.js";
import type { AgentMessage } from "../tracking/inbox.js";
import { OperationState } from "../merging/contracts.js";
import { receiptContext } from "../merging/receipts.js";
import { CheckWatchState } from "../tracking/checks.js";
import { EntryState, terminal } from "../merging/contracts.js";
import { NotificationState } from "./contracts.js";
import type { MergeStore } from "../merging/store.js";
import { checked } from "../merging/contracts.js";
import {
  AutomationPolicySchema,
  ConfigSchema,
  StageSchema,
  defaults,
  type AutomationPolicy,
  type Instructions,
} from "./contracts.js";
function read(path: string): string | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 65536)
      throw new Error("Policy files must be regular files of at most 64 KiB");
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
export function load(root: string) {
  const toml = read(join(root, "octo-manager.toml"));
  if (toml === undefined)
    return {
      status: "missing" as const,
      hash: "missing",
      autoMerge: false,
      instructions: {},
    };
  const config: unknown = Bun.TOML.parse(toml);
  if (!Check(ConfigSchema, config))
    throw new Error("Invalid octo-manager.toml configuration");
  for (const text of Object.values(config.notifications?.instructions ?? {}))
    if (Buffer.byteLength(text) > 1000)
      throw new Error("Instruction text exceeds 1000 UTF-8 bytes");
  const manifest = read(join(root, ".source-code.json"));
  const installed: unknown =
    manifest === undefined ? undefined : JSON.parse(manifest);
  const stage =
    typeof installed === "object" &&
    installed !== null &&
    "schema_version" in installed &&
    installed.schema_version === 1 &&
    "stage" in installed &&
    Check(StageSchema, installed.stage)
      ? installed.stage
      : undefined;
  const configured = config.merging?.auto_merge ?? false;
  return {
    status: "valid" as const,
    hash: createHash("sha256")
      .update(toml)
      .update(manifest ?? "")
      .digest("hex"),
    ...(stage === undefined ? {} : { stage }),
    autoMerge:
      configured === "project_stage"
        ? stage === "research" || stage === "alpha"
        : configured,
    instructions: config.notifications?.instructions ?? {},
  };
}
export class RepositoryPolicies {
  constructor(
    private db: DatabaseSync,
    private tracking: TrackingStore,
    private merging: MergeStore,
    private event: (kind: string, detail: string, prId?: string) => void,
  ) {}
  get(prId: string): AutomationPolicy | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`repository-policy:${prId}`);
    return row === undefined
      ? undefined
      : checked(AutomationPolicySchema, JSON.parse(String(row["value"])));
  }
  bind(prId: string, agentId: string, cwd?: string): void {
    if (cwd === undefined || this.tracking.pr(prId).ownerAgentId !== agentId)
      return;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2000,
        maxBuffer: 65536,
      }).trim();
    let root: string;
    try {
      root = realpathSync(git("rev-parse", "--show-toplevel"));
      const repository = new URL(this.tracking.pr(prId).url).pathname
        .split("/")
        .slice(1, 3)
        .join("/")
        .toLowerCase();
      const remotes = git(
        "config",
        "--get-regexp",
        "^remote\\..*\\.url$",
      ).split("\n");
      if (
        !remotes.some(
          (line) =>
            githubRepository(
              line.slice(line.indexOf(" ") + 1),
            )?.toLowerCase() === repository,
        )
      )
        return;
    } catch {
      return;
    }
    const pr = this.tracking.pr(prId);
    const prior = this.get(prId);
    this.save({
      prId,
      root,
      ownerId: agentId,
      epoch: pr.trackingEpoch,
      status: "missing",
      hash: "",
      autoMerge: false,
      instructions:
        prior?.ownerId === agentId && prior.epoch === pr.trackingEpoch
          ? prior.instructions
          : {},
    });
    this.tick();
  }
  private save(policy: AutomationPolicy): void {
    checked(AutomationPolicySchema, policy);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`repository-policy:${policy.prId}`, JSON.stringify(policy));
  }
  tick(): void {
    const roots = new Map<string, ReturnType<typeof load> | Error>();
    for (const pr of this.tracking.prContexts()) {
      const prior = this.get(pr.id);
      if (prior === undefined || !pr.enabled) continue;
      if (
        prior.ownerId !== pr.ownerAgentId ||
        prior.epoch !== pr.trackingEpoch
      ) {
        if (this.merging.settingSource(pr.id) !== "explicit") {
          this.merging.autoMerge(
            pr.id,
            pr.ownerAgentId,
            false,
            `repository-context:${pr.id}:${String(pr.trackingEpoch)}`,
            undefined,
            "inherited",
          );
          this.merging.policyStage(pr.id);
        }
        const error =
          "Repository policy requires enrollment by the current owner and tracking epoch";
        if (prior.error !== error) {
          this.save({ ...prior, status: "invalid", autoMerge: false, error });
          this.event("repository_policy_updated", error, pr.id);
        }
        continue;
      }
      let loaded = roots.get(prior.root);
      if (loaded === undefined) {
        try {
          if (realpathSync(prior.root) !== prior.root)
            throw new Error("Repository root changed");
          loaded = load(prior.root);
        } catch (error) {
          loaded =
            error instanceof Error
              ? error
              : new Error("Repository policy unavailable");
        }
        roots.set(prior.root, loaded);
      }
      const next: AutomationPolicy =
        loaded instanceof Error
          ? {
              ...prior,
              status: "invalid",
              hash: `error:${loaded.message}`,
              autoMerge: false,
              error: loaded.message,
            }
          : {
              prId: prior.prId,
              root: prior.root,
              ownerId: prior.ownerId,
              epoch: prior.epoch,
              ...loaded,
              ...(loaded.status === "missing"
                ? {
                    instructions: prior.instructions,
                    ...(prior.status !== "missing" || prior.error !== undefined
                      ? { error: "Repository policy file is missing" }
                      : {}),
                  }
                : {}),
            };
      if (JSON.stringify(prior) !== JSON.stringify(next)) {
        this.save(next);
        this.event(
          "repository_policy_updated",
          next.error ??
            `Repository policy ${next.status}${next.stage === undefined ? "" : ` (${next.stage})`}`,
          pr.id,
        );
      }
      const entries = this.merging.entries(pr.id);
      if (
        entries.some(
          (entry) =>
            terminal(entry.state) &&
            (entry.trackingEpoch ?? entry.ready?.epoch ?? 0) ===
              pr.trackingEpoch,
        ) &&
        !entries.some((entry) => !terminal(entry.state))
      )
        continue;
      if (next.autoMerge && !entries.some((entry) => !terminal(entry.state))) {
        const observation = this.tracking.pr(pr.id).observation;
        if (
          observation === undefined ||
          observation.checks.state !== "complete" ||
          (observation.workflows !== undefined &&
            observation.workflows.state !== "complete")
        )
          continue;
      }
      const current = entries.find((entry) => !terminal(entry.state));
      if (
        this.merging.settingSource(pr.id) !== "explicit" &&
        (current === undefined
          ? next.autoMerge
          : current.autoMerge !== next.autoMerge ||
            current.autoMergeSource !== "inherited" ||
            current.autoMergeStage !== next.stage ||
            current.trackingEpoch !== pr.trackingEpoch)
      ) {
        this.merging.autoMerge(
          pr.id,
          pr.ownerAgentId,
          next.autoMerge,
          `repository:${pr.id}:${String(pr.trackingEpoch)}`,
          undefined,
          "inherited",
        );
        this.merging.policyStage(pr.id, next.stage);
      }
    }
  }
  forMessage(message: AgentMessage): string | undefined {
    const actionId =
      message.actionId === ""
        ? this.merging.readinessAction(message.id)
        : message.actionId;
    const action =
      actionId === undefined ? undefined : this.tracking.action(actionId);
    const prId = action?.prId ?? message.workflowPRId;
    if (prId === undefined) return undefined;
    const entry =
      this.merging.noticeEntry(message.id) ??
      this.merging
        .entries()
        .find((value) => value.prId === prId && !terminal(value.state));
    let state: NotificationState | undefined;
    if (
      entry !== undefined &&
      this.merging.noticeEntry(message.id) !== undefined
    ) {
      if (entry.state === EntryState.Merged) state = NotificationState.Merged;
      else if (entry.state === EntryState.Uncertain)
        state = NotificationState.MergeUncertain;
      else if (entry.state === EntryState.WaitingOwner) {
        const failed = this.merging
          .operations()
          .some(
            (operation) =>
              operation.entryId === entry.id &&
              operation.epoch === this.tracking.pr(prId).trackingEpoch &&
              operation.head === this.tracking.pr(prId).observation?.headSha &&
              operation.state === OperationState.Failed,
          );
        state =
          failed && entry.ready === undefined
            ? NotificationState.MergeBlocked
            : NotificationState.OwnerReviewRequired;
      } else if (entry.state === EntryState.Blocked)
        state = NotificationState.MergeBlocked;
    } else if (action !== undefined) {
      switch (action.blocker.kind) {
        case "review_feedback":
        case "changes_requested":
          state = NotificationState.ReviewFeedback;
          break;
        case "check_failed":
          state = NotificationState.ChecksFailed;
          break;
        case "conflict":
          state = NotificationState.MergeConflict;
          break;
        case "check_results": {
          const blocker = action.blocker;
          const pr = this.tracking.pr(prId);
          if (
            blocker.state !== CheckWatchState.Completed ||
            blocker.headSha !== pr.observation?.headSha
          )
            break;
          if (
            blocker.checks.some((check) =>
              [
                "failure",
                "timed_out",
                "cancelled",
                "action_required",
                "startup_failure",
              ].includes(check.conclusion),
            )
          ) {
            state = NotificationState.ChecksFailed;
            break;
          }
          const dependencies = this.merging
            .dependencies()
            .some(
              (edge) =>
                edge.dependentId === prId &&
                this.tracking.pr(edge.prerequisiteId).observation?.lifecycle !==
                  "merged",
            );
          const cached = this.merging.noticeReadiness(prId);
          state = dependencies
            ? NotificationState.DependenciesPending
            : entry?.state === EntryState.WaitingOwner
              ? NotificationState.OwnerReviewRequired
              : cached?.eligible === true &&
                  cached.target.actionId === action.id &&
                  cached.target.context === receiptContext(this.merging, pr)
                ? NotificationState.Ready
                : undefined;
          break;
        }
      }
    }
    return state === undefined
      ? undefined
      : this.instructions(prId, message.recipientAgentId, [state]);
  }
  instructions(
    prId: string,
    agentId: string,
    states: NotificationState[],
  ): string | undefined {
    const pr = this.tracking.pr(prId),
      policy = this.get(prId);
    if (agentId !== pr.ownerAgentId) return undefined;
    const configured: Instructions =
      policy?.ownerId === agentId && policy.epoch === pr.trackingEpoch
        ? policy.instructions
        : {};
    const text = [
      ...new Set(states.map((state) => configured[state] ?? defaults[state])),
    ]
      .filter((value) => value !== "")
      .join("\n");
    return text === "" ? undefined : text;
  }
}
