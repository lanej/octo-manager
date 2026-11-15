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

  return {
    group: heading?.[1] ?? "",
    lines: [
      `- ${cleanText((heading?.[2] ?? first).replace("Checks completed (includes neutral/skipped); no merge conflicts", "Checks complete; no conflicts").replace("Checks passed; no merge conflicts", "Checks passed; no conflicts"), 240)}${role === undefined ? "" : ` · ${cleanText(role, 160)}`}`,
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
  messages: AgentMessage[],
  directory: string,
  receiptId: string,
): { body: string; messageIds: string[] } {
  const command = `octo-manager ack ${shortId(receiptId)}${resolve(directory) === join(homedir(), ".local/state/octo-manager") ? "" : ` --state ${quote(directory)}`}`;
  const fence = "`".repeat(
    1 +
      Math.max(
        0,
        ...[...command.matchAll(/`+/gu)].map((match) => match[0].length),
      ),
  );
  const footer = `Ack: ${fence}${command}${fence}`;
  const selected: AgentMessage[] = [];
  function body(rows: AgentMessage[]): string {
    const groups = new Map<string, string[]>();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const item = entry(row);
      counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
      groups.set(item.group, [
        ...(groups.get(item.group) ?? []),
        ...item.lines,
      ]);
    }
    return `${[...groups]
      .map(([heading, lines]) => {
        const single = counts.get(heading) === 1;
        if (single) {
          const first = (lines[0] ?? "- Update").replace(/^- /u, "");
          return `${heading === "" ? "" : heading + " · "}${first}${lines.length > 1 ? "\n" + lines.slice(1).join("\n") : ""}`;
        }
        return `${heading === "" ? "" : heading + "\n"}${lines.join("\n")}`;
      })
      .join("\n\n")}\n\n${footer}`;
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

// The footer is canonical; the coordinator still verifies the exact full body.
export function messageReceiptId(body: string): string | undefined {
  const start = body.lastIndexOf("\nAck: ");
  if (start < 0) return undefined;
  const footer = body.slice(start + 6).trimEnd();
  const fence = footer.match(/^`+/u)?.[0];
  if (fence === undefined) return undefined;
  const end = footer.indexOf(fence, fence.length);
  if (end < 0) return undefined;
  const command = footer.slice(fence.length, end);
  const parts = command.split(" ");
  const id = parts[2];
  return parts[0] === "octo-manager" &&
    parts[1] === "ack" &&
    id !== undefined &&
    /^[a-f0-9-]{8,36}$/u.test(id)
    ? id
    : undefined;
}
