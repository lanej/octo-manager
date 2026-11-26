import { bg, bold, fg, link, underline, StyledText, type TextChunk } from "@opentui/core";
import {
  type DetailLine,
  type StatusTone,
  type DeliveryPresentation,
  type RecordView,
  type Screen,
  safeText,
} from "./records.js";
import { dashboardLink } from "./links.js";

export interface Palette {
  accent: string;
  muted: string;
  border: string;
  surface: string;
  tab: string;
  warning: string;
  danger: string;
  success: string;
  info: string;
  foreground?: string;
  background?: string;
}

export function plain(text: string): TextChunk {
  return { __isChunk: true, text };
}

const graphemes = new Intl.Segmenter();

function clip(line: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(line) <= width) return line;
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(line)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells >= width) break;
    result += segment;
    used += cells;
  }
  return result + "…";
}

function line(value: string) {
  return safeText(value).replaceAll("\n", " ");
}

function deliveryColor(delivery: DeliveryPresentation, palette: Palette) {
  if (delivery.group === "Needs intervention") return palette.warning;
  if (delivery.group === "Delivered / closed") return palette.success;
  return palette.info;
}

function linkChunk(label: string, address: string, palette: Palette): TextChunk {
  return link(address)(underline(fg(palette.accent)(label)));
}

function pillChunk(label: string, tone: StatusTone, palette: Palette): TextChunk {
  const color = tone === "neutral" ? palette.muted : palette[tone];
  return bg(palette.surface)(fg(color)(` ${line(label)} `));
}

function subject(row: RecordView, width: number, palette: Palette) {
  const text = clip(line(row.delivery?.subject ?? row.label), width);
  const address = row.url === undefined ? undefined : dashboardLink(row.url);
  return !address ? fg(palette.accent)(text) : linkChunk(text, address.url, palette);
}

export function listContent(
  rows: readonly RecordView[],
  selected: string | undefined,
  screen: Screen,
  width: number,
  connection: string,
  palette: Palette,
): StyledText {
  if (rows.length === 0)
    return new StyledText([
      fg(palette.muted)(connection === "Live" ? `No ${screen.toLowerCase()} records` : "Waiting for Octo…"),
    ]);
  const chunks: TextChunk[] = [];
  let group: DeliveryPresentation["group"] | undefined;
  for (const row of rows) {
    const current = row.id === selected;
    const delivery = row.delivery;
    if (delivery && group !== delivery.group) {
      chunks.push(fg(palette.muted)(clip(delivery.group, width)), plain("\n"));
      group = delivery.group;
    }
    const prefix = current ? fg(palette.accent)(bold("› ")) : plain("  ");
    const text = subject(row, width - 2, palette);
    chunks.push(prefix, current ? bg(palette.tab)(bold(text)) : text, plain("\n"));
    if (delivery) {
      const title = delivery.title;
      if (title !== undefined && title.trim() !== "")
        chunks.push(plain("  "), plain(clip(line(title), width - 2)), plain("\n"));
      chunks.push(
        plain("  "),
        bg(palette.surface)(fg(deliveryColor(delivery, palette))(` ${clip(line(delivery.condition), width - 4)} `)),
        plain("\n"),
      );
    }
  }
  chunks.pop();
  return new StyledText(chunks);
}

function section(title: string, width: number, palette: Palette): TextChunk[] {
  return [
    fg(palette.accent)(bold(title)),
    fg(palette.border)(" " + "─".repeat(Math.max(0, width - Bun.stringWidth(title) - 2))),
    plain("\n"),
  ];
}

const referenceFields = new Set(["PR", "Issue", "Evidence", "Source", "Requires merge"]);

function fact(value: DetailLine, palette: Palette): TextChunk[] {
  if (typeof value !== "string") {
    const label = fg(palette.muted)(`${value.label}: `);
    const content =
      value.kind === "link"
        ? linkChunk(line(value.link.label), value.link.url, palette)
        : pillChunk(value.value, value.tone, palette);
    return [label, content];
  }
  const text = safeText(value);
  const separator = text.indexOf(": ");
  if (separator <= 0 || separator > 26 || text.startsWith("• ")) return [plain(text)];
  const label = text.slice(0, separator);
  const detail = text.slice(separator + 2);
  const reference = referenceFields.has(label) ? dashboardLink(detail) : undefined;
  return [
    fg(palette.muted)(`${label}: `),
    !reference ? plain(detail) : linkChunk(line(reference.label), reference.url, palette),
  ];
}

function facts(lines: readonly DetailLine[], palette: Palette): TextChunk[] {
  return lines.flatMap((value) => [...fact(value, palette), plain("\n")]);
}

function factWidth(chunks: readonly TextChunk[]): number {
  return chunks.reduce((width, chunk) => width + Bun.stringWidth(chunk.text), 0);
}

function identityAndVerification(delivery: DeliveryPresentation, width: number, palette: Palette) {
  const leftWidth = Math.floor((width - 4) / 2);
  const rightWidth = width - leftWidth - 4;
  const { identity, verification } = delivery;
  const leftFacts = identity.map((value) => fact(value, palette));
  const rightFacts = verification.map((value) => fact(value, palette));
  const fits = (chunks: readonly TextChunk[], cells: number) =>
    chunks.every((chunk) => !chunk.text.includes("\n")) && factWidth(chunks) <= cells;
  if (
    width < 66 ||
    !leftFacts.every((value) => fits(value, leftWidth)) ||
    !rightFacts.every((value) => fits(value, rightWidth))
  ) {
    return [
      ...section("Identity", width, palette),
      ...facts(identity, palette),
      plain("\n"),
      ...section("Verification", width, palette),
      ...facts(verification, palette),
      plain("\n"),
    ];
  }
  const columns: TextChunk[] = [
    ...section("Identity", leftWidth + 1, palette).slice(0, -1),
    plain("    "),
    ...section("Verification", rightWidth, palette),
  ];
  for (let index = 0; index < Math.max(identity.length, verification.length); index++) {
    const left = leftFacts[index] ?? [];
    columns.push(
      ...left,
      plain(" ".repeat(leftWidth + 4 - factWidth(left))),
      ...(rightFacts[index] ?? []),
      plain("\n"),
    );
  }
  return [...columns, plain("\n")];
}

export function detailContent(
  row: RecordView | undefined,
  width: number,
  palette: Palette,
  screen: Screen,
): StyledText {
  if (!row) return new StyledText([]);
  const delivery = row.delivery;
  if (delivery && screen !== "Reviews") {
    const hasFeedback = delivery.feedback.length > 1;
    const highlighted = [
      subject(row, width, palette),
      plain("\n"),
      ...(delivery.title === undefined ? [] : [bold(line(delivery.title) + "\n")]),
      bg(palette.surface)(fg(deliveryColor(delivery, palette))(` ${line(delivery.condition)} `)),
      plain("\n"),
      fg(palette.muted)(`Observed ${line(delivery.observed)}\n\n`),
      bg(palette.surface)(fg(palette.accent)(bold("  NEXT ACTION  "))),
      plain("\n  "),
      bold(line(delivery.next) + "\n\n"),
    ];
    const feedback = [
      ...section("Feedback delivery", width, palette),
      ...facts(delivery.feedback, palette),
      plain("\n"),
    ];
    return new StyledText([
      ...highlighted,
      ...(hasFeedback ? feedback : []),
      ...identityAndVerification(delivery, width, palette),
      ...section("Merge authority & result", width, palette),
      ...facts(delivery.authority, palette),
      plain("\n"),
      ...(hasFeedback ? [] : feedback),
      ...(row.detail.trim() === ""
        ? []
        : [...section("Additional evidence", width, palette), ...facts(row.detail.split("\n"), palette)]),
    ]);
  }

  if (screen === "GitHub") {
    return new StyledText(
      safeText(row.detail)
        .split("\n")
        .flatMap((value) => {
          if (value.endsWith(" quota") || value.startsWith("Recent ") || value === "Scheduler activity")
            return section(value, width, palette);
          if (/^[▮░]+$/u.test(value)) return [fg(palette.accent)(value), plain("\n")];
          if (/^(REST|GraphQL|Cache): +[·▁-█]+$/u.test(value)) {
            const color = value.startsWith("REST")
              ? palette.accent
              : value.startsWith("GraphQL")
                ? palette.info
                : palette.warning;
            return [fg(color)(value), plain("\n")];
          }
          return facts([value], palette);
        }),
    );
  }
  return new StyledText([...section(line(row.label), width, palette), ...facts(row.detail.split("\n"), palette)]);
}
