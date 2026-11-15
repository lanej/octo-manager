import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { SchedulerService } from "../src/gen/octomanager/v2/scheduler_pb.js";
import { schedulerClient } from "../src/client.js";
test("TypeScript client rejects a mismatched API before attempting a mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-version-"));
  let mutations = 0;
  const server = createServer(
    connectNodeAdapter({
      routes: (router) =>
        router.service(SchedulerService, {
          getServerInfo: () => ({ apiVersion: 1 }),
          setPaused: () => {
            mutations++;
            return {};
          },
        }),
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(directory, "run.sock"), resolve);
    });
    await expect(
      schedulerClient(directory).setPaused({ paused: true }),
    ).rejects.toThrow("update the server, CLI, and dashboard together");
    expect(mutations).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
