import sage from "./sage-terminal-ui.json" with { type: "json" };

export const terminalPalette = {
  accent: sage.roles.accent,
  muted: sage.roles["text.muted"],
  border: sage.roles.border,
  surface: sage.roles["surface.raised"],
  tab: sage.roles["surface.selected"],
  warning: sage.roles["status.warning"],
  danger: sage.roles["status.error"],
  success: sage.roles["status.success"],
  info: sage.roles["status.info"],
};

export const darkCanvas = {
  foreground: sage.roles.text,
  background: sage.roles.surface,
};

export type DashboardGlyph =
  | "approval"
  | "checksPassed"
  | "merged"
  | "selected"
  | "connected"
  | "connecting"
  | "disconnected";

export function dashboardGlyph(name: DashboardGlyph, ascii = false): string {
  const states = ascii ? sage.ascii_states : sage.states;
  const symbols = ascii ? sage.ascii_symbols : sage.symbols;
  return {
    approval: states["access.approval"],
    checksPassed: symbols["publication.checks_passed"],
    merged: symbols["publication.merged"],
    selected: symbols["ui.selection"],
    connected: states["connectivity.connected"],
    connecting: states["connectivity.connecting"],
    disconnected: states["connectivity.disconnected"],
  }[name];
}
