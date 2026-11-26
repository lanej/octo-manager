import type { TrackingStore } from "../tracking/store.js";
import type { DigestStore } from "./store.js";
import type { TrackingConfig } from "../tracking/config.js";
import { terminal } from "./types.js";

export function managedQueuePolicy(
  tracking: TrackingStore,
  digests: DigestStore,
  config: TrackingConfig,
) {
  const managed = (agentId: string): boolean => {
    const agent = tracking.agent(agentId);
    if (agent.harness === "pi") return false;
    return (
      config.endpoints[agent.endpoint]?.delivery === "queue" ||
      digests
        .list(agentId)
        .some((value) => !terminal(value) || value.cleanupPending)
    );
  };
  const managedBatch = (agentIds: readonly string[]): ReadonlySet<string> => {
    const result = new Set<string>();
    for (const id of new Set(agentIds)) {
      try {
        if (managed(id)) result.add(id);
      } catch {
        /* Omission preserves the later per-recipient authority check. */
      }
    }
    return result;
  };
  return { managed, managedBatch };
}
