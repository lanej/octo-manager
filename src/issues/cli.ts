import { toJson } from "@bufbuild/protobuf";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { schedulerClient } from "../client.js";
import type { ParsedCommand } from "../cli/contracts.js";
import { printResult } from "../cli-output.js";
import {
  SetIssueSubscriptionResponseSchema,
  ListIssueSubscriptionsResponseSchema,
  EnrollIssueResponseSchema,
  ListIssuesResponseSchema,
  GetIssueResponseSchema,
  UpdateIssueResponseSchema,
  IssueOperation,
} from "../gen/octomanager/v2/issues_pb.js";
import { IssueNotificationKind } from "./contracts.js";
import { wireIssueNotificationKind } from "./subscription-wire.js";
function integer(value: string | boolean | undefined): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "string" ||
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("Expected a nonnegative integer");
  return Number(value);
}
export async function issuesCLI(parsed: ParsedCommand): Promise<void> {
  const { values, positionals } = parsed;
  const command = positionals[0];
  const id = positionals[1] ?? "";
  const client = schedulerClient(
    resolve(
      values.state ??
        process.env["OCTO_MANAGER_STATE"] ??
        join(homedir(), ".local", "state", "octo-manager"),
    ),
  );
  const requestId = values["request-id"] ?? randomUUID();
  if (command === "issue-subscribe" || command === "issue-subscriptions") {
    const selected = values["events"];
    const eventNames =
      selected === "none"
        ? []
        : typeof selected === "string"
          ? selected.split(",")
          : undefined;
    const kinds = eventNames?.map((name) => {
      const kind = Object.values(IssueNotificationKind).find(
        (value) => value.localeCompare(name) === 0,
      );
      if (kind === undefined)
        throw new Error(`Unsupported issue event: ${name}`);
      return wireIssueNotificationKind(kind);
    });
    if (command === "issue-subscriptions")
      printResult(
        parsed,
        toJson(
          ListIssueSubscriptionsResponseSchema,
          await client.listIssueSubscriptions({ issueId: id }),
          { alwaysEmitImplicit: true },
        ),
      );
    else
      printResult(
        parsed,
        toJson(
          SetIssueSubscriptionResponseSchema,
          await client.setIssueSubscription({
            issueId: id,
            agentId:
              values["agent-id"] ?? process.env["OCTO_MANAGER_AGENT_ID"] ?? "",
            ...(kinds === undefined ? {} : { filter: { events: kinds } }),
          }),
          { alwaysEmitImplicit: true },
        ),
      );
    return;
  }
  if (command === "issue-track") {
    const owner = values["agent-id"] ?? process.env["OCTO_MANAGER_AGENT_ID"];
    if (owner == null)
      throw new Error(
        "Set OCTO_MANAGER_AGENT_ID or --agent-id to a registered agent",
      );
    printResult(
      parsed,
      toJson(
        EnrollIssueResponseSchema,
        await client.enrollIssue({
          provider:
            typeof values["provider"] === "string"
              ? values["provider"]
              : "github",
          url: id,
          root: resolve(values.cwd ?? process.cwd()),
          ownerAgentId: owner,
          requestId,
        }),
      ),
    );
    return;
  }
  if (command === "issue-list") {
    printResult(
      parsed,
      toJson(
        ListIssuesResponseSchema,
        await client.listIssues({ offset: integer(values["offset"]) }),
      ),
    );
    return;
  }
  if (command === "issue-show") {
    printResult(
      parsed,
      toJson(
        GetIssueResponseSchema,
        await client.getIssue({
          id,
          beforeSequence: BigInt(integer(values["before"])),
        }),
      ),
    );
    return;
  }
  const operations: Record<string, IssueOperation> = {
    "issue-approve": IssueOperation.APPROVE,
    "issue-approve-publication": IssueOperation.APPROVE_PUBLICATION,
    "issue-approve-follow-up": IssueOperation.APPROVE_FOLLOW_UP,
    "issue-answer": IssueOperation.ANSWER,
    "issue-pause": IssueOperation.PAUSE,
    "issue-resume": IssueOperation.RESUME,
    "issue-cancel": IssueOperation.CANCEL,
    "issue-refresh": IssueOperation.REFRESH,
  };
  const operation = command === undefined ? undefined : operations[command];
  if (operation === undefined) throw new Error("Unsupported issue command");
  printResult(
    parsed,
    toJson(
      UpdateIssueResponseSchema,
      await client.updateIssue({
        id,
        operation,
        text: typeof values["text"] === "string" ? values["text"] : "",
        briefVersion: integer(values["brief-version"]),
        requestId,
      }),
    ),
  );
}
