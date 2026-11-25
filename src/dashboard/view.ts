import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  MarkdownRenderable,
  SyntaxStyle,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import {
  diagnostics,
  primary,
  safeText,
  type RecordView,
  type Screen,
} from "./records.js";

type Theme = "terminal" | "dark" | "light" | "contrast" | "mono";
const palettes = {
  terminal: { accent: "#6091a5", hint: "#729b62" },
  dark: {
    accent: "#88c0d0",
    hint: "#a3be8c",
    foreground: "#eceff4",
    background: "#2e3440",
  },
  light: {
    accent: "#245c72",
    hint: "#325c22",
    foreground: "#222831",
    background: "#f1f2f4",
  },
  contrast: {
    accent: "#00ffff",
    hint: "#ffff00",
    foreground: "#ffffff",
    background: "#000000",
  },
  mono: {
    accent: "#ffffff",
    hint: "#ffffff",
    foreground: "#ffffff",
    background: "#000000",
  },
} satisfies Record<
  Theme,
  { accent: string; hint: string; foreground?: string; background?: string }
>;

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

export function dashboardView(
  renderer: CliRenderer,
  controls: Controls,
  theme: Theme = "terminal",
) {
  const palette: {
    accent: string;
    hint: string;
    foreground?: string;
    background?: string;
  } = palettes[theme];
  const foreground =
    palette.foreground === undefined ? {} : { fg: palette.foreground };
  if (palette.background !== undefined)
    renderer.setBackgroundColor(palette.background);
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
    fg: palette.hint,
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
  });
  const list = new TextRenderable(renderer, {
    ...foreground,
    wrapMode: "none",
    flexShrink: 0,
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
    wrapMode: "char",
  });
  const markdown = new MarkdownRenderable(renderer, {
    ...foreground,
    width: "100%",
    syntaxStyle: SyntaxStyle.create(renderer.nativeScene),
  });
  const log = new TextRenderable(renderer, {
    ...foreground,
    width: "100%",
    wrapMode: "char",
  });
  inspector.add(details);
  inspector.add(markdown);
  inspector.add(log);
  body.add(list);
  body.add(inspector);
  for (const node of [header, tabs, body, status, footer])
    renderer.root.add(node);

  let screen: Screen = "Attention";
  let origin: Screen = screen;
  let rows: readonly RecordView[] = [];
  let connection = "Connecting";
  let notice = "";
  let prevList = "";
  let prevDetails = "";
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
    const visibleRows = Math.max(1, renderer.height - 4);
    current.first = Math.max(
      0,
      Math.min(current.first, rows.length - visibleRows),
    );
    if (index >= 0)
      current.first = Math.min(
        index,
        Math.max(current.first, index - visibleRows + 1),
      );

    header.content = `Octo Manager  /  ${screen}    ${connection}`;
    const navigation = primary.some((value) => value === screen)
      ? primary
      : diagnostics;
    tabs.content = navigation
      .map((name, i) => `${String(i + 1)} ${name}`)
      .join("  ");
    status.content = safeText(notice.replaceAll("\n", " "));
    tabs.visible = !compact;
    status.visible = !compact && notice !== "";
    body.visible = !compact;
    header.visible = renderer.height > 1;
    const keys =
      screen === "Activity"
        ? "h/l Pages   r Reconcile"
        : screen === "Output" || screen === "Runtime"
          ? "Tab Worker events   p/c/r Controls"
          : screen === "GitHub" || screen === "Issues"
            ? "u Refresh"
            : screen === "Tracking"
              ? "u Refresh   a Auto merge   o Open"
              : "u Refresh   o Open";
    footer.content = compact
      ? "q Quit"
      : current.inspecting
        ? `q Quit   Esc Back   [/] Scroll   ${keys}`
        : `q Quit   d Diagnostics   j/k Move   Enter Inspect   ${keys}`;
    list.width = wide ? Math.floor(renderer.width * 0.42) : renderer.width;
    list.visible =
      item === undefined || (!single && (wide || !current.inspecting));
    inspector.visible =
      item !== undefined && (single || wide || current.inspecting);
    const nextList = rows
      .slice(current.first, current.first + visibleRows)
      .map(
        (row) =>
          `${row.id === current.id ? "›" : " "} ${safeText(row.label.replaceAll("\n", " "))}`,
      )
      .join("\n");
    const listContent =
      nextList === ""
        ? connection === "Live"
          ? `No ${screen.toLowerCase()} records`
          : "Waiting for Octo…"
        : nextList;
    if (listContent !== prevList) {
      prevList = listContent;
      list.content = listContent;
    }
    details.visible = !logFocused;
    markdown.visible = !logFocused && item?.markdown !== undefined;
    log.visible = logFocused;
    const markdownContent = safeText(
      (item?.markdown ?? "").slice(0, 256 * 1024),
    );
    if (markdownContent !== prevMarkdown) {
      markdown.content = markdownContent;
      prevMarkdown = markdownContent;
    }
    const logText = safeText(item?.log ?? "");
    if (logText !== prevLog) {
      log.content = logText === "" ? "No worker events retained" : logText;
      prevLog = logText;
    }
    const content = safeText(item?.detail ?? "");
    if (content !== prevDetails) {
      prevDetails = content;
      details.content = content;
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
    const destination = /^[1-6]$/u.test(name)
      ? options[Number(name) - 1]
      : undefined;
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
    if (name === "return" && selected() !== undefined) {
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
      ((screen === "Output" || screen === "Runtime" || screen === "Issues") &&
        (name === "h" || name === "l"))
    ) {
      const index = rows.findIndex((row) => row.id === current.id);
      const next =
        rows[
          Math.max(
            0,
            Math.min(rows.length - 1, index + (down || name === "l" ? 1 : -1)),
          )
        ];
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
