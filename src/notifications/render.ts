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
}
export function digestGroups(messages: AgentMessage[]): DigestGroup[] {
  const groups = new Map<string, DigestGroup>();
  for (const message of messages) {
    const notice: SafeNotice = message.notice ?? {
      version: 1,
      kind: "update",
      assessment: "not_required",
    };
    const entry = noticeView(notice, message.actionId);
    const key = entry.group.url ?? "octo";
    let group = groups.get(key);
    if (group === undefined) {
      group = { reference: entry.group, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}
function renderGroup(group: DigestGroup): string {
  return [
    renderReference(group.reference),
    ...group.entries.map((entry) => {
      const reference =
        entry.reference.url === group.reference.url
          ? ""
          : ` · ${renderReference(entry.reference)}`;
      return [
        `- ${entry.title}${reference}`,
        ...entry.fields.map((field) => `  ${field.label}: ${field.value}`),
      ].join("\n");
    }),
  ].join("\n");
}

export function renderDigest(
  id: string,
  number: number,
  agentId: string,
  messages: AgentMessage[],
  directory: string,
  agentIds: string[] = [],
): { body: string; messageIds: string[] } {
  const command = `octo-manager acknowledge-digest ${shortId(id)} --revision ${String(number)} --agent-id ${shortId(agentId, agentIds)}${resolve(directory) === join(homedir(), ".local/state/octo-manager") ? "" : ` --state ${quote(directory)}`}`;
  const fence = "`".repeat(
    1 +
      Math.max(
        0,
        ...[...command.matchAll(/`+/gu)].map((match) => match[0].length),
      ),
  );
  const footer = `Receipt: ${fence}${command}${fence}\nUse current returned items for triage.`;
  const selected: AgentMessage[] = [];
  function body(rows: AgentMessage[]): string {
    const groups = digestGroups(rows);
    return `[octo-digest:${shortId(id)}:${String(number)}]\nOcto · ${String(rows.length)} updates\n\n${groups.map(renderGroup).join("\n\n")}\n\n${footer}`;
  }
  for (const message of messages) {
    if (
      selected.length === 20 ||
      Buffer.byteLength(body([...selected, message])) > 6000
    )
      break;
    selected.push(message);
  }
  if (selected.length === 0)
    throw new Error("No notification fits the digest size bound");
  return {
    body: body(selected),
    messageIds: selected.map((message) => message.id),
  };
}
