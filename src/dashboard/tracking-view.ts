import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import {
  TrackingState,
  type TrackedPullRequest,
  type TrackingSnapshot,
} from "../gen/octomanager/v2/tracking_pb.js";

function terminalText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

function displayValue(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

function label(pr: TrackedPullRequest): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/u.exec(
    pr.url,
  );
  return terminalText(
    match?.[1] !== undefined && match[2] !== undefined
      ? `${match[1]} #${match[2]}`
      : pr.url,
  );
}

function monitoring(pr: TrackedPullRequest): string {
  const names: Partial<Record<number, string>> = TrackingState;
  return names[pr.trackingState]?.toLowerCase() ?? "unknown";
}

export function trackingView(renderer: CliRenderer, quit: () => void) {
  const header = new TextRenderable(renderer, {
    fg: "#88c0d0",
    height: 1,
    wrapMode: "none",
  });
  const footer = new TextRenderable(renderer, {
    fg: "#a3be8c",
    height: 1,
    wrapMode: "none",
  });
  const body = new BoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
    flexDirection: "row",
  });
  const list = new TextRenderable(renderer, {
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
    width: "100%",
    wrapMode: "char",
  });
  inspector.add(details);
  body.add(list);
  body.add(inspector);
  renderer.root.add(header);
  renderer.root.add(body);
  renderer.root.add(footer);

  let snapshot: TrackingSnapshot | undefined;
  let selectedId: string | undefined;
  let firstRow = 0;
  let inspecting = false;
  let connection = "Connecting";
  let previousList = "";
  let previousDetails = "";

  function paint() {
    const prs = snapshot?.prs ?? [];
    const selectedIndex = prs.findIndex((pr) => pr.id === selectedId);
    const selected = prs[selectedIndex];
    const wide = renderer.width >= 96;
    const visibleRows = Math.max(1, renderer.height - 2);
    firstRow = Math.max(
      0,
      Math.min(firstRow, Math.max(0, prs.length - visibleRows)),
    );
    if (selectedIndex >= 0)
      firstRow = Math.min(
        selectedIndex,
        Math.max(firstRow, selectedIndex - visibleRows + 1),
      );

    header.content = `Octo Manager  /  Tracking    ${connection}`;
    footer.content = inspecting
      ? "[ / ] Scroll   Esc Back   q Quit"
      : "j / k Move   Enter Inspect   q Quit";
    list.width = wide ? Math.floor(renderer.width * 0.42) : renderer.width;
    list.visible = wide || !inspecting;
    inspector.visible = selected !== undefined && (wide || inspecting);
    const rows = prs
      .slice(firstRow, firstRow + visibleRows)
      .map(
        (pr) =>
          `${pr.id === selectedId ? "›" : " "} ${label(pr)} · ${monitoring(pr)}`,
      )
      .join("\n");
    const nextList =
      rows !== ""
        ? rows
        : snapshot === undefined
          ? "Waiting for Octo…"
          : "No tracked pull requests";
    if (nextList !== previousList) {
      list.content = nextList;
      previousList = nextList;
    }
    const owner = snapshot?.agents.find(
      (agent) => agent.id === selected?.ownerAgentId,
    );
    const observation = selected?.observation;
    const nextDetails =
      selected === undefined
        ? ""
        : [
            label(selected),
            terminalText(selected.url),
            "",
            `Owner: ${terminalText(displayValue(owner?.target?.label, displayValue(selected.ownerAgentId, "Unassigned")))}`,
            `Monitoring: ${monitoring(selected)}`,
            `PR state: ${terminalText(displayValue(observation?.lifecycle, "Awaiting observation"))}`,
            `Mergeability: ${terminalText(displayValue(observation?.mergeability, "Unknown"))}`,
            `Head: ${terminalText(displayValue(observation?.headSha, "Unknown"))}`,
            `Base: ${terminalText(displayValue(observation?.targetBase?.ref, "Unknown"))}`,
            `Refresh error: ${terminalText(displayValue(selected.refreshError, "None reported"))}`,
            "",
            "Tracked actions",
            ...(snapshot?.actions
              .filter((action) => action.prId === selected.id)
              .map((action) => `• ${terminalText(action.summary)}`) ?? []),
          ].join("\n");
    if (nextDetails !== previousDetails) {
      details.content = nextDetails;
      previousDetails = nextDetails;
    }
  }

  function select(id: string | undefined) {
    if (id === selectedId) return;
    selectedId = id;
    inspector.scrollTop = 0;
  }

  function keypress(key: KeyEvent) {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      quit();
      return;
    }
    if (inspecting) {
      if (key.name === "escape") inspecting = false;
      else if (key.name === "[") inspector.scrollBy(-1);
      else if (key.name === "]") inspector.scrollBy(1);
      else return;
    } else if (key.name === "return" && selectedId !== undefined) {
      inspecting = true;
    } else if (key.name === "j" || key.name === "k") {
      const prs = snapshot?.prs ?? [];
      const index = prs.findIndex((pr) => pr.id === selectedId);
      const next = Math.max(
        0,
        Math.min(prs.length - 1, index + (key.name === "j" ? 1 : -1)),
      );
      select(prs[next]?.id);
    } else {
      return;
    }
    paint();
  }

  renderer.on("resize", paint);
  renderer.keyInput.on("keypress", keypress);
  paint();
  return {
    update(next: TrackingSnapshot) {
      const previousIndex =
        snapshot?.prs.findIndex((pr) => pr.id === selectedId) ?? 0;
      snapshot = next;
      if (!next.prs.some((pr) => pr.id === selectedId)) {
        select(
          next.prs[Math.max(0, Math.min(previousIndex, next.prs.length - 1))]
            ?.id,
        );
        if (selectedId === undefined) inspecting = false;
      }
      connection = "Live";
      paint();
    },
    disconnected() {
      connection =
        snapshot === undefined
          ? "Reconnecting…"
          : "Disconnected · showing last snapshot";
      paint();
    },
  };
}
