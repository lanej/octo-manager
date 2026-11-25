import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ConnectError } from "@connectrpc/connect";
import { createCliRenderer } from "@opentui/core";
import { schedulerClient } from "../client.js";
import { trackingView } from "./tracking-view.js";

if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error("Tracking needs an interactive terminal.");

const directory = resolve(
  process.env["OCTO_MANAGER_STATE"] ??
    join(homedir(), ".local", "state", "octo-manager"),
);
const stop = new AbortController();
const stopped = () => stop.signal.aborted;
const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  useMouse: false,
  consoleMode: "disabled",
  onDestroy: () => {
    stop.abort();
  },
});

try {
  const view = trackingView(renderer, () => {
    renderer.destroy();
  });
  while (!stopped()) {
    const client = schedulerClient(directory);
    try {
      for await (const { snapshot } of client.watchDashboard(
        {},
        { signal: stop.signal, timeoutMs: 0 },
      )) {
        if (snapshot?.tracking !== undefined) view.update(snapshot.tracking);
      }
    } catch (error) {
      if (stopped()) break;
      if (!(error instanceof ConnectError)) throw error;
    }
    if (stopped()) break;
    view.disconnected();
    try {
      await setTimeout(1000, undefined, { signal: stop.signal });
    } catch (error) {
      if (!stopped()) throw error;
    }
  }
} finally {
  renderer.destroy();
  await renderer.closed;
}
