import { terminal, type MergeEntry } from "../merging/contracts.js";
import type { AutomationPolicy } from "./contracts.js";

export function autoMergeForStage(
  configured: boolean | "project_stage",
  stage: AutomationPolicy["stage"],
): boolean {
  return configured === "project_stage"
    ? stage === "research" || stage === "alpha"
    : configured;
}

export function matchesBinding(
  policy: Pick<AutomationPolicy, "ownerId" | "epoch">,
  context: { ownerAgentId: string; trackingEpoch: number },
): boolean {
  return (
    policy.ownerId === context.ownerAgentId &&
    policy.epoch === context.trackingEpoch
  );
}

export function inheritedAutomation(
  policy: Pick<AutomationPolicy, "autoMerge" | "stage" | "epoch">,
  entries: readonly MergeEntry[],
  explicit: boolean | undefined,
  checksComplete: boolean | undefined,
): "keep" | "apply" | "revoke" | "inspect_checks" | "inspect_setting" {
  const current = entries.find((entry) => !terminal(entry.state));
  if (current === undefined) {
    const settled = entries.some(
      (entry) =>
        terminal(entry.state) &&
        (entry.trackingEpoch ?? entry.ready?.epoch ?? 0) === policy.epoch,
    );
    if (settled) return "keep";
    if (policy.autoMerge && checksComplete === undefined)
      return "inspect_checks";
    if (policy.autoMerge && checksComplete === false) return "keep";
  }
  if (explicit === undefined) return "inspect_setting";
  if (explicit) return "keep";
  if (current === undefined) return policy.autoMerge ? "apply" : "keep";
  if (
    current.autoMerge === policy.autoMerge &&
    current.autoMergeSource === "inherited" &&
    current.autoMergeStage === policy.stage &&
    current.trackingEpoch === policy.epoch
  )
    return "keep";
  return policy.autoMerge ? "apply" : "revoke";
}
