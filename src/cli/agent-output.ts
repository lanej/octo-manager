import type { Capability, ParsedCommand } from "./contracts.js";
import type { Projection } from "./projection.js";
import { applicationOutputs } from "./application-output.js";
import { trackingOutputs } from "../tracking/agent-output.js";
import { subscriptionsOutputs } from "../tracking/subscriptions-output.js";
import { issueOutputs } from "../issues/agent-output.js";
import { mergingOutputs } from "../merging/agent-output.js";
import { notificationOutputs } from "../notifications/agent-output.js";
import { repairOutputs } from "../repairs/agent-output.js";
import { activityOutputs } from "../activity/agent-output.js";
import { historyOutputs } from "../submissions/agent-output.js";
import { publicationOutputs } from "../publication/agent-output.js";

const outputs: Record<Capability, Readonly<Record<string, Projection>>> = {
  application: applicationOutputs,
  tracking: trackingOutputs,
  subscriptions: subscriptionsOutputs,
  issues: issueOutputs,
  merging: mergingOutputs,
  notifications: notificationOutputs,
  repairs: repairOutputs,
  activity: activityOutputs,
  history: historyOutputs,
  publication: publicationOutputs,
};

export const agentOutputExceptions: Readonly<Record<string, string>> = {
  serve: "Long-running server readiness protocol",
  lifecycle: "Version 1 native activation evidence protocol",
  dashboard: "Interactive terminal application",
  login: "Interactive authentication",
  "codex-hook": "Codex hook protocol",
  read: "Complete evidence and scoped instructions through readOutput",
  "pr init": "Local contract paths and initialization status",
  "pr refresh": "Local guidance derivation result",
  "pr instructions": "Repository-authored Markdown instructions",
  "pr validate": "Draft validation result and findings",
};

export function agentProjection(
  parsed: Pick<ParsedCommand, "capability" | "positionals">,
): Projection | undefined {
  const command = parsed.positionals[0] ?? "";
  if (parsed.capability === "publication" && command === "pr") return undefined;
  return outputs[parsed.capability][command];
}
