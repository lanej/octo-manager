import type {
  MessagePresentation,
  ReceiptTarget,
} from "../merging/receipt-types.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  noticeView,
  renderReference,
  type NoticeReference,
  type NoticeView,
  type SafeNotice,
} from "../security/notifications.js";
import { shortId } from "../tracking/identifiers.js";
import type { AgentMessage } from "../tracking/inbox.js";
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export interface DigestGroup {
  reference: NoticeReference;
  entries: NoticeView[];
  instructions: string[];
}
export function digestGroups(
  messages: AgentMessage[],
  presentation?: (message: AgentMessage) => MessagePresentation,
): DigestGroup[] {
  const groups = new Map<string, DigestGroup>();
  for (const message of messages) {
    const notice: SafeNotice = message.notice ?? {
      version: 1,
      kind: "update",
      assessment: "not_required",
    };
    const entry = noticeView(notice, message.actionId);
    const shown = presentation?.(message);
    const status = shown?.status;
    if (status !== undefined)
      entry.title = {
        ready: "Ready",
        review_unavailable: "Checks complete · review status unavailable",
        blocked: "Checks complete · merge prerequisites not met",
        feedback_assessment:
          "Checks complete · Review feedback requires owner assessment",
      }[status];
    const key = entry.group.url ?? "octo";
    let group = groups.get(key);
    if (group === undefined) {
      group = { reference: entry.group, entries: [], instructions: [] };
      groups.set(key, group);
    }
    if (
      !group.entries.some(
        (previous) => JSON.stringify(previous) === JSON.stringify(entry),
      )
    )
      group.entries.push(entry);
    for (const instruction of shown?.instructions?.split("\n") ?? [])
      if (instruction !== "" && !group.instructions.includes(instruction))
        group.instructions.push(instruction);
  }
  return [...groups.values()];
}
function renderGroup(group: DigestGroup): string {
  const single = group.entries.length === 1 ? group.entries[0] : undefined;
  const instructions = group.instructions.map(
    (value) => `Instructions: ${value}`,
  );
  if (single !== undefined)
    return [
      `${renderReference(single.reference)} · ${single.title}`,
      ...single.fields
        .filter(
          (field) =>
            field.label !== "Action" && field.label !== "Assessment record",
        )
        .map((field) => `${field.label}: ${field.value}`),
      ...instructions,
    ].join("\n");
  const first = group.entries[0];
  const sharedFields = (entry: NoticeView) =>
    entry.fields.filter(
      (field) =>
        field.label !== "Action" && field.label !== "Assessment record",
    );
  const actions = group.entries.map(
    (entry) => entry.fields.find((field) => field.label === "Action")?.value,
  );
  if (
    first !== undefined &&
    actions.every(
      (action) =>
        action !== undefined && action !== "none" && action !== "unavailable",
    ) &&
    group.entries.every(
      (entry) =>
        entry.title === first.title &&
        JSON.stringify(entry.reference) === JSON.stringify(first.reference) &&
        JSON.stringify(sharedFields(entry)) ===
          JSON.stringify(sharedFields(first)),
    )
  )
    return [
      `${renderReference(first.reference)} · ${first.title} · ${String(group.entries.length)} updates`,
      sharedFields(first)
        .map((field) => `${field.label}: ${field.value}`)
        .join(" · "),
      ...instructions,
    ].join("\n");
  return [
    renderReference(group.reference),
    ...group.entries.map((entry) =>
      [
        `- ${entry.title}${entry.reference.url === group.reference.url ? "" : ` · ${renderReference(entry.reference)}`}`,
        ...entry.fields
          .filter(
            (field) =>
              field.label !== "Action" && field.label !== "Assessment record",
          )
          .map((field) => `  ${field.label}: ${field.value}`),
      ].join("\n"),
    ),
    ...instructions,
  ].join("\n");
}

export function renderDigest(
  messages: AgentMessage[],
  directory: string,
  receiptId: string,
  presentation?: (message: AgentMessage) => MessagePresentation,
): { body: string; messageIds: string[]; mergeTarget?: ReceiptTarget } {
  const candidates = messages.slice(0, 20);
  const presentations = new Map(
    candidates.map((message) => [message.id, presentation?.(message)]),
  );
  function target(rows: AgentMessage[]): ReceiptTarget | undefined {
    let selected: ReceiptTarget | undefined;
    for (const row of rows) {
      const current = presentations.get(row.id)?.mergeTarget;
      if (current === undefined) continue;
      if (
        selected !== undefined &&
        JSON.stringify(selected) !== JSON.stringify(current)
      )
        return undefined;
      selected = current;
    }
    return selected;
  }
  function footer(rows: AgentMessage[]): string {
    const args = `${shortId(receiptId)}${resolve(directory) === join(homedir(), ".local/state/octo-manager") ? "" : ` --state ${quote(directory)}`}`;
    const command = `octo-manager ${target(rows) === undefined ? "ack" : "merge"} ${args}`;
    const fence = "`".repeat(
      1 +
        Math.max(
          0,
          ...[...command.matchAll(/`+/gu)].map((match) => match[0].length),
        ),
    );
    return `Inspect: ${fence}octo-manager message ${args}${fence}\n${fence}${command}${fence}`;
  }
  function body(rows: AgentMessage[]): string {
    const groups = digestGroups(
      rows,
      (message) => presentations.get(message.id) ?? {},
    );
    return `${groups.map(renderGroup).join("\n\n")}\n\n${footer(rows)}`;
  }
  const selected: AgentMessage[] = [];
  for (const message of candidates) {
    if (Buffer.byteLength(body([...selected, message])) > 6000) break;
    selected.push(message);
  }
  if (selected.length === 0)
    throw new Error("No notification fits the digest size bound");
  const mergeTarget = target(selected);
  return {
    body: body(selected),
    messageIds: selected.map((message) => message.id),
    ...(mergeTarget === undefined ? {} : { mergeTarget }),
  };
}

// The footer is canonical; the coordinator still verifies the exact full body.
export function messageReceiptId(body: string): string | undefined {
  const footer = (
    body.split("\n").findLast((line) => line.trim() !== "") ?? ""
  ).replace(/^Ack: /u, "");
  const fence = footer.match(/^`+/u)?.[0];
  if (fence === undefined) return undefined;
  const end = footer.indexOf(fence, fence.length);
  if (end < 0) return undefined;
  const command = footer.slice(fence.length, end);
  const parts = command.split(" ");
  const id = parts[2];
  return parts[0] === "octo-manager" &&
    (parts[1] === "ack" || parts[1] === "merge") &&
    id !== undefined &&
    /^[a-f0-9-]{8,36}$/u.test(id)
    ? id
    : undefined;
}
