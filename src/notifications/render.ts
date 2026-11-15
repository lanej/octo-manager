import type {
  MessagePresentation,
  ReceiptTarget,
} from "../merging/receipt-types.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cleanText } from "../domain.js";
import { shortId } from "../tracking/identifiers.js";
import type { AgentMessage } from "../tracking/inbox.js";
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
function entry(
  message: AgentMessage,
  presentation?: MessagePresentation,
): { group: string; lines: string[] } {
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
      `- ${cleanText((presentation?.summary ?? heading?.[2] ?? first).replace("Checks completed (includes neutral/skipped); no merge conflicts", "Checks complete").replace("Checks passed; no merge conflicts", "Checks passed"), 768)}${role === undefined ? "" : ` · ${cleanText(role, 160)}`}`,
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
  presentation?: (message: AgentMessage) => MessagePresentation,
): { body: string; messageIds: string[]; mergeTarget?: ReceiptTarget } {
  const candidates = messages.slice(0, 20);
  const presentations = new Map(
    candidates.map((message) => [message.id, presentation?.(message)]),
  );
  function mergeTarget(rows: AgentMessage[]): ReceiptTarget | undefined {
    let selected: ReceiptTarget | undefined;
    for (const row of rows) {
      const target = presentations.get(row.id)?.mergeTarget;
      if (target === undefined) continue;
      if (
        selected !== undefined &&
        JSON.stringify(selected) !== JSON.stringify(target)
      )
        return undefined;
      selected = target;
    }
    return selected;
  }
  function footer(rows: AgentMessage[]): string {
    const command = `octo-manager ${mergeTarget(rows) === undefined ? "ack" : "merge"} ${shortId(receiptId)}${resolve(directory) === join(homedir(), ".local/state/octo-manager") ? "" : ` --state ${quote(directory)}`}`;
    const fence = "`".repeat(
      1 +
        Math.max(
          0,
          ...[...command.matchAll(/`+/gu)].map((match) => match[0].length),
        ),
    );
    return `${fence}${command}${fence}`;
  }
  const selected: AgentMessage[] = [];
  function body(rows: AgentMessage[]): string {
    const groups = new Map<string, string[]>();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const item = entry(row, presentations.get(row.id));
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
      .join("\n\n")}\n\n${footer(rows)}`;
  }
  for (const message of candidates) {
    if (
      selected.length === 20 ||
      Buffer.byteLength(body([...selected, message])) > 6000
    )
      break;
    selected.push(message);
  }
  if (selected.length === 0)
    throw new Error("No notification fits the digest size bound");
  const target = mergeTarget(selected);
  return {
    ...(target === undefined ? {} : { mergeTarget: target }),
    body: body(selected),
    messageIds: selected.map((message) => message.id),
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
