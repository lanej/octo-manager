import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cleanText } from "../domain.js";
import { shortId } from "../tracking/identifiers.js";
import type { AgentMessage } from "../tracking/inbox.js";
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
function entry(message: AgentMessage): { group: string; lines: string[] } {
  const lines = message.body
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("[octo-delivery:"));
  const first = lines[0] ?? "Octo update",
    heading = first.match(
      /^(\[[^\]]+\]\(https:\/\/github\.com\/[^)]+\/pull\/\d+\)) · (.*)$/u,
    );
  const role = lines.find((line) => line.startsWith("Role:"));
  const excerpt = lines
    .filter((line) => line.startsWith("> "))
    .map((line) => line.slice(2))
    .filter((line) => !line.startsWith("<!--") && line.trim() !== "")
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/<[^>]*>/gu, "")
    .replaceAll("**", "")
    .trim();
  const evidence = lines.find(
    (line) =>
      line.startsWith("[Evidence](") || line.startsWith("[Failed run]("),
  );
  const reference = lines.find(
    (line) => line.startsWith("Action:") || line.startsWith("Submission:"),
  );
  return {
    group: heading?.[1] ?? "Submissions",
    lines: [
      `- ${cleanText(heading?.[2] ?? first, 240)}${reference === undefined ? "" : ` · ${reference.toLowerCase()}`}${role === undefined ? "" : ` · ${cleanText(role, 160)}`}`,
      ...(message.participantPRId !== undefined
        ? lines
            .filter((line) => line.startsWith("> "))
            .slice(0, 9)
            .map((line) => `  ${cleanText(line, 180)}`)
        : excerpt === ""
          ? []
          : [`  > ${cleanText(excerpt, 180)}`]),
      ...(evidence === undefined ? [] : [`  ${evidence}`]),
    ],
  };
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
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const item = entry(row);
      groups.set(item.group, [
        ...(groups.get(item.group) ?? []),
        ...item.lines,
      ]);
    }
    return `[octo-digest:${shortId(id)}:${String(number)}]\nOcto · ${String(rows.length)} updates\n\n${[...groups].map(([heading, lines]) => `${heading}\n${lines.join("\n")}`).join("\n\n")}\n\n${footer}`;
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
