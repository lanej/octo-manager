import {
  bg,
  bold,
  fg,
  StyledText,
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  MarkdownRenderable,
  SyntaxStyle,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { compactMarkdownLinks } from "./links.js";
import { diagnostics, primary, safeText, type RecordView, type Screen } from "./records.js";

import { detailContent, listContent, plain, type Palette } from "./presentation.js";

type Theme = "terminal" | "dark" | "light" | "contrast" | "mono";
const colorful = {
  accent: "#65cfc1",
  muted: "#aab8c7",
  border: "#4c6176",
  surface: "#263344",
  tab: "#244742",
  warning: "#f0c678",
  danger: "#f8a7a3",
  success: "#8fd2a6",
  info: "#8dbcf0",
};
const mono = {
  accent: "#ffffff",
  muted: "#cccccc",
  border: "#999999",
  surface: "#262626",
  tab: "#404040",
  warning: "#ffffff",
  danger: "#ffffff",
  success: "#ffffff",
  info: "#ffffff",
  foreground: "#ffffff",
  background: "#000000",
};
const palettes = {
  terminal: colorful,
  dark: { ...colorful, foreground: "#eceff4", background: "#151e29" },
  light: {
    accent: "#125f57",
    muted: "#465466",
    border: "#718699",
    surface: "#e4e9ef",
    tab: "#c4e4dc",
    warning: "#754a00",
    danger: "#942f36",
    success: "#17613b",
    info: "#24598d",
    foreground: "#222831",
    background: "#f1f5f8",
  },
  contrast: {
    ...mono,
    accent: "#00ffff",
    warning: "#ffff00",
    danger: "#ffabab",
    info: "#9eccff",
    success: "#b0f8b0",
  },
  mono,
} satisfies Record<Theme, Palette>;

export function dashboardTheme(value: string | undefined): Theme {
  switch (value) {
    case undefined:
    case "terminal":
      return "terminal";
    case "dark":
    case "light":
    case "contrast":
    case "mono":
      return value;
    default:
      throw new Error(`Invalid dashboard theme ${value}`);
  }
}

interface Controls {
  quit(): void;
  changed(): void;
  action(key: string): void;
}
interface Selection {
  id: string | undefined;
  first: number;
  inspecting: boolean;
}

export function dashboardView(renderer: CliRenderer, controls: Controls, theme: Theme = "terminal") {
  const palette: Palette = palettes[theme];
  const foreground = palette.foreground === undefined ? {} : { fg: palette.foreground };
  if (palette.background !== undefined) renderer.setBackgroundColor(palette.background);
  const header = new TextRenderable(renderer, {
    height: 1,
    fg: palette.accent,
    wrapMode: "none",
  });
  const tabs = new TextRenderable(renderer, {
    height: 1,
    fg: palette.accent,
    wrapMode: "none",
  });
  const footer = new TextRenderable(renderer, {
    height: 1,
    fg: palette.muted,
    wrapMode: "none",
  });
  const status = new TextRenderable(renderer, {
    height: 1,
    ...foreground,
    wrapMode: "none",
  });
  const body = new BoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
    flexDirection: "row",
    gap: 2,
  });
  const list = new TextRenderable(renderer, {
    ...foreground,
    wrapMode: "none",
    flexShrink: 0,
  });
  const listPanel = new BoxRenderable(renderer, {
    border: true,
    borderColor: palette.accent,
    titleColor: palette.accent,
    paddingX: 1,
    flexShrink: 0,
  });
  const detailPanel = new BoxRenderable(renderer, {
    border: true,
    borderColor: palette.border,
    titleColor: palette.muted,
    paddingX: 1,
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
  });
  const inspector = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    scrollbarOptions: { visible: false },
  });
  const details = new TextRenderable(renderer, {
    ...foreground,
    width: "100%",
    wrapMode: "word",
  });
  const markdown = new MarkdownRenderable(renderer, {
    ...foreground,
    width: "100%",
    syntaxStyle: SyntaxStyle.create(renderer.nativeScene),
    inlineHook: compactMarkdownLinks,
  });
  const log = new TextRenderable(renderer, {
    ...foreground,
    width: "100%",
    wrapMode: "char",
  });
  inspector.add(details);
  inspector.add(markdown);
  inspector.add(log);
  listPanel.add(list);
  detailPanel.add(inspector);
  body.add(listPanel);
  body.add(detailPanel);
  for (const node of [header, tabs, body, status, footer]) renderer.root.add(node);

  let screen: Screen = "Attention";
  let origin: Screen = screen;
  let rows: readonly RecordView[] = [];
  let connection = "Connecting";
  let notice = "";
  let previousList = "";
  let previousDetails = "";
  let prevMarkdown = "";
  let prevLog = "";
  let logFocused = false;
  const selections = new Map<Screen, Selection>();
  function selection() {
    const current = selections.get(screen) ?? {
      id: undefined,
      first: 0,
      inspecting: false,
    };
    selections.set(screen, current);
    return current;
  }
  function selected() {
    return rows.find((row) => row.id === selection().id);
  }
  function paint() {
    const current = selection();
    const index = rows.findIndex((row) => row.id === current.id);
    const item = rows[index];
    const compact = renderer.height < 7;
    const wide = renderer.width >= 96 && !compact;
    const single = screen === "GitHub";
    const inDiagnostics = diagnostics.some((name) => name === screen);
    const stackedTabs = inDiagnostics && renderer.width < 82;
    const stackedFooter = !compact && renderer.width < 82 && renderer.height >= 11;
    tabs.height = stackedTabs ? 2 : 1;
    footer.height = stackedFooter ? 2 : 1;
    const fullDetail =
      current.inspecting && item?.delivery !== undefined && (screen === "Attention" || screen === "Deliveries");
    const detailedRows = rows.some((row) => row.delivery !== undefined);
    const availableRows = Math.max(1, renderer.height - (notice === "" ? 5 : 6));
    const visibleRows = Math.max(1, Math.floor(availableRows / (detailedRows ? 4 : 1)));
    current.first = Math.max(0, Math.min(current.first, rows.length - visibleRows));
    if (index >= 0) current.first = Math.min(index, Math.max(current.first, index - visibleRows + 1));

    const indicator = connection === "Live" ? palette.success : palette.warning;
    header.content = new StyledText([
      fg(palette.accent)(bold(" OCTO MANAGER ")),
      plain(` / ${screen}   `),
      bg(palette.surface)(fg(indicator)(` ● ${connection.toUpperCase()} `)),
    ]);
    const navigation = primary.some((value) => value === screen) ? primary : diagnostics;
    tabs.content = new StyledText(
      navigation.flatMap((name, i) => {
        const label = ` ${String(i + 1)} ${name} `;
        return [
          name === screen ? bg(palette.tab)(bold(label)) : plain(label),
          plain(stackedTabs && i === 2 ? "\n" : " "),
        ];
      }),
    );
    status.content = safeText(notice.replaceAll("\n", " "));
    tabs.visible = !compact;
    status.visible = !compact && notice !== "";
    body.visible = !compact;
    header.visible = renderer.height > 1;
    const keys =
      screen === "Activity"
        ? item?.operationId === undefined
          ? "h/l Pages"
          : "h/l Pages   r Reconcile"
        : screen === "Output" || screen === "Runtime"
          ? "Tab Worker events   p/c/r Controls"
          : screen === "GitHub" || screen === "Issues"
            ? "u Refresh"
            : screen === "Tracking" || fullDetail
              ? "u Refresh   a Auto merge   o Open"
              : "u Refresh   o Open";
    const shortcuts =
      current.inspecting || single
        ? "q Quit   Esc Back   [/] Scroll"
        : "q Quit   d Diagnostics   j/k Move   Enter Inspect";
    footer.content = compact ? "q Quit" : `${shortcuts}${stackedFooter ? "\n" : "   "}${keys}`;
    const listWidth = wide && item && !single ? Math.max(32, Math.floor(renderer.width * 0.35)) : renderer.width;
    listPanel.width = listWidth;
    listPanel.title = ` ${screen.toUpperCase()} · ${String(rows.length)} `;
    listPanel.visible = item === undefined || (!single && !fullDetail && (wide || !current.inspecting));
    detailPanel.visible = item !== undefined && (single || wide || current.inspecting);
    const detailWidth = listPanel.visible ? renderer.width - listWidth - 6 : renderer.width - 4;
    const detailTitle = item?.delivery
      ? "DELIVERY DETAIL"
      : screen === "Activity"
        ? "OPERATION & EVENT EVIDENCE"
        : screen.toUpperCase();
    detailPanel.title = ` ${detailTitle} `;
    detailPanel.borderColor = current.inspecting || single ? palette.accent : palette.border;
    if (listPanel.visible) {
      const listText = listContent(
        rows.slice(current.first, current.first + visibleRows),
        current.id,
        screen,
        listWidth - 4,
        connection,
        palette,
      );
      const listKey = JSON.stringify(listText.chunks);
      if (listKey !== previousList) {
        list.content = listText;
        previousList = listKey;
      }
    }
    details.visible = !logFocused;
    markdown.visible = !logFocused && item?.markdown !== undefined;
    log.visible = logFocused;
    const markdownContent = safeText((item?.markdown ?? "").slice(0, 256 * 1024));
    if (markdownContent !== prevMarkdown) {
      markdown.content = markdownContent;
      prevMarkdown = markdownContent;
    }
    const logText = safeText(item?.log ?? "");
    if (logText !== prevLog) {
      log.content = logText === "" ? "No worker events retained" : logText;
      prevLog = logText;
    }
    if (detailPanel.visible) {
      const detailText = detailContent(item, Math.max(1, detailWidth), palette, screen);
      const detailKey = JSON.stringify(detailText.chunks);
      if (detailKey !== previousDetails) {
        details.content = detailText;
        previousDetails = detailKey;
      }
    }
  }

  function changeScreen(next: Screen) {
    if (next === screen) return;
    screen = next;
    logFocused = false;
    rows = [];
    inspector.scrollTop = 0;
    controls.changed();
  }

  function keypress(key: KeyEvent) {
    const name = key.name;
    if (name === "q" || (key.ctrl && name === "c")) {
      controls.quit();
      return;
    }
    if (name === "tab" && (screen === "Output" || screen === "Runtime")) {
      logFocused = !logFocused;
      selection().inspecting = true;
      inspector.scrollTop = 0;
      paint();
      return;
    }
    const current = selection();
    const inPrimary = primary.some((value) => value === screen);
    const options = inPrimary ? primary : diagnostics;
    const destination = /^[1-6]$/u.test(name) ? options[Number(name) - 1] : undefined;
    if (destination !== undefined) {
      changeScreen(destination);
      return;
    }
    if (name === "d" || name === "?") {
      if (inPrimary) origin = screen;
      changeScreen(inPrimary ? "GitHub" : origin);
      return;
    }
    if (name === "escape" || name === "backspace") {
      if (current.inspecting) {
        current.inspecting = false;
        logFocused = false;
        controls.changed();
      } else if (!inPrimary) changeScreen(origin);
      return;
    }
    if (name === "return" && selected()) {
      current.inspecting = !current.inspecting;
      controls.changed();
      return;
    }
    const down = name === "j" || name === "down";
    const up = name === "k" || name === "up";
    if (
      name === "[" ||
      name === "]" ||
      name === "pageup" ||
      name === "pagedown" ||
      ((screen === "GitHub" || current.inspecting) && (down || up))
    ) {
      inspector.scrollBy(name === "[" || name === "pageup" || up ? -3 : 3);
      return;
    }
    if (
      down ||
      up ||
      ((screen === "Output" || screen === "Runtime" || screen === "Issues") && (name === "h" || name === "l"))
    ) {
      const index = rows.findIndex((row) => row.id === current.id);
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (down || name === "l" ? 1 : -1)))];
      if (next?.id !== current.id) {
        current.id = next?.id;
        inspector.scrollTop = 0;
        controls.changed();
      }
      return;
    }
    controls.action(name);
  }

  renderer.on("resize", paint);
  renderer.keyInput.on("keypress", keypress);
  paint();
  return {
    get screen() {
      return screen;
    },
    get inspecting() {
      return selection().inspecting;
    },
    selected,
    update(next: readonly RecordView[], state: string, message: string) {
      rows = next;
      connection = state;
      notice = message;
      const current = selection();
      if (!rows.some((row) => row.id === current.id)) {
        if (current.id !== undefined) current.inspecting = false;
        current.id = rows[0]?.id;
        inspector.scrollTop = 0;
      }
      paint();
    },
  };
}
