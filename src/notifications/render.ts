import { linkPRReferences } from "./links.js";
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

  const summary = (presentation?.summary ?? heading?.[2] ?? first)
    .replace(
      "Checks completed (includes neutral/skipped); no merge conflicts",
      "Checks complete",
    )
    .replace("Checks passed; no merge conflicts", "Checks passed");
  const sourceUrl = heading?.[1]?.match(
    /\((https:\/\/github\.com\/[^)]+)\)$/u,
  )?.[1];
  const knownUrl = summary.match(
    /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\b/u,
  )?.[0];
  return {
    group: heading?.[1] ?? "",
    lines: [
      `- ${linkPRReferences(cleanText(summary), sourceUrl, knownUrl)}${role === undefined ? "" : ` · ${cleanText(role, 160)}`}`,
      ...(message.participantPRId !== undefined
        ? lines
            .filter((line) => line.startsWith("> "))
            .slice(0, 9)
            .map((line) => `  ${cleanText(line, 180)}`)
        : excerpt === ""
          ? []
          : [
              `  > ${linkPRReferences(cleanText(excerpt), sourceUrl, knownUrl, 480)}`,
            ]),
      ...(evidence === undefined ? [] : [`  ${evidence}`]),
    ],
  };
}
// Collapse presentation only: every selected source remains in the receipt.
function compactEntries(items: { group: string; lines: string[] }[]): {
  group: string;
  lines: string[];
}[] {
  const result: { group: string; lines: string[] }[] = [];
  const conditions = new Set<string>();
  let applicability: { group: string; lines: string[] } | undefined;
  for (const item of items) {
    const prefix = "- PR submission needs_input: ";
    const reason = "Unverified applicability condition: ";
    const summary = item.lines[0] ?? "";
    const blockers = summary.slice(prefix.length).split("; ");
    if (
      item.group === "" &&
      item.lines.length === 1 &&
      summary.startsWith(prefix) &&
      blockers.every(
        (blocker) =>
          blocker.startsWith(reason) && blocker.length > reason.length,
      )
    ) {
      for (const blocker of blockers)
        conditions.add(blocker.slice(reason.length));
      if (applicability === undefined) {
        applicability = { group: "", lines: [] };
        result.push(applicability);
      }
      applicability.lines = [
        `- PR submission needs input: verify applicability conditions: ${[...conditions].join(", ")}`,
      ];
    } else if (
      !result.some(
        (previous) =>
          previous.group === item.group &&
          JSON.stringify(previous.lines) === JSON.stringify(item.lines),
      )
    ) {
      result.push(item);
    }
  }
  return result;
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
    const instructions = new Map<string, Set<string>>();
    for (const row of rows) {
      const text = presentations.get(row.id)?.instructions;
      if (text === undefined) continue;
      const group = entry(row, presentations.get(row.id)).group;
      const texts = instructions.get(group) ?? new Set<string>();
      texts.add(text);
      instructions.set(group, texts);
    }
    for (const item of compactEntries(
      rows.map((row) => entry(row, presentations.get(row.id))),
    )) {
      counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
      groups.set(item.group, [
        ...(groups.get(item.group) ?? []),
        ...item.lines,
      ]);
    }
    return `${[...groups]
      .map(([heading, lines]) => {
        const instruction = [...(instructions.get(heading) ?? [])]
          .map((text) => `\nInstructions: ${cleanText(text, 1000)}`)
          .join("");
        const single = counts.get(heading) === 1;
        if (single) {
          const first = (lines[0] ?? "- Update").replace(/^- /u, "");
          return `${heading === "" ? "" : heading + " · "}${first}${lines.length > 1 ? "\n" + lines.slice(1).join("\n") : ""}${instruction}`;
        }
        return `${heading === "" ? "" : heading + "\n"}${lines.join("\n")}${instruction}`;
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
