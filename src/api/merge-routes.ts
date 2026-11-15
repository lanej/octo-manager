import type { Coordinator } from "../coordinator.js";
import { wire, unwire, record } from "./codec.js";
import { trackingOperation } from "../tracking/rpc.js";
import * as api from "../gen/octomanager/v2/domain_pb.js";
import { CommandSchema, checked } from "../merging/contracts.js";
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected merge records");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected merge result text");
  return value;
}
export function mergeRoutes(coordinator: Coordinator) {
  return {
    setAutoMerge(
      r: import("../gen/octomanager/v2/domain_pb.js").SetAutoMergeRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "auto_merge",
            ...record(unwire(api.SetAutoMergeRequestSchema, r)),
          }),
        );
        const data = record(result);
        if (typeof data["enabled"] !== "boolean")
          throw new Error("Invalid automatic merge result");
        return {
          prId: text(data["prId"]),
          enabled: data["enabled"],
          ...(data["entry"] === undefined
            ? {}
            : { entry: wire(api.DomainMergeEntrySchema, data["entry"]) }),
        };
      });
    },
    queueMergeChain(
      r: import("../gen/octomanager/v2/domain_pb.js").QueueMergeChainRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "queue",
            ...record(unwire(api.QueueMergeChainRequestSchema, r)),
          }),
        );
        return { chain: wire(api.DomainMergeChainSchema, result) };
      });
    },
    inspectMergeChains(
      r: import("../gen/octomanager/v2/domain_pb.js").InspectMergeChainsRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "inspect",
            ...record(unwire(api.InspectMergeChainsRequestSchema, r)),
          }),
        );
        return { overview: wire(api.DomainMergeOverviewSchema, result) };
      });
    },
    listPRReferences(
      r: import("../gen/octomanager/v2/domain_pb.js").ListPRReferencesRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "references",
            ...record(unwire(api.ListPRReferencesRequestSchema, r)),
          }),
        );
        return {
          references: list(record(result)["references"]).map((value) =>
            wire(api.DomainPRReferenceSchema, value),
          ),
        };
      });
    },
    listPRDependencies(
      r: import("../gen/octomanager/v2/domain_pb.js").ListPRDependenciesRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "dependencies",
            ...record(unwire(api.ListPRDependenciesRequestSchema, r)),
          }),
        );
        return {
          dependencies: list(record(result)["dependencies"]).map((value) =>
            wire(api.DomainDependencySchema, value),
          ),
        };
      });
    },
    confirmPRDependency(
      r: import("../gen/octomanager/v2/domain_pb.js").ConfirmPRDependencyRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "confirm",
            ...record(unwire(api.ConfirmPRDependencyRequestSchema, r)),
          }),
        );
        return { dependency: wire(api.DomainDependencySchema, result) };
      });
    },
    removePRDependency(
      r: import("../gen/octomanager/v2/domain_pb.js").RemovePRDependencyRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "remove",
            ...record(unwire(api.RemovePRDependencyRequestSchema, r)),
          }),
        );
        return { dependency: wire(api.DomainDependencySchema, result) };
      });
    },
    decidePRReference(
      r: import("../gen/octomanager/v2/domain_pb.js").DecidePRReferenceRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "decide",
            ...record(unwire(api.DecidePRReferenceRequestSchema, r)),
          }),
        );
        return { reference: wire(api.DomainPRReferenceSchema, result) };
      });
    },
    setMergePolicy(
      r: import("../gen/octomanager/v2/domain_pb.js").SetMergePolicyRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "policy",
            ...record(unwire(api.SetMergePolicyRequestSchema, r)),
          }),
        );
        return { entry: wire(api.DomainMergeEntrySchema, result) };
      });
    },
    setMergeReady(
      r: import("../gen/octomanager/v2/domain_pb.js").SetMergeReadyRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "ready",
            ...record(unwire(api.SetMergeReadyRequestSchema, r)),
          }),
        );
        return { entry: wire(api.DomainMergeEntrySchema, result) };
      });
    },
    pauseMergeChain(
      r: import("../gen/octomanager/v2/domain_pb.js").PauseMergeChainRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "pause",
            ...record(unwire(api.PauseMergeChainRequestSchema, r)),
          }),
        );
        return { chain: wire(api.DomainMergeChainSchema, result) };
      });
    },
    resumeMergeChain(
      r: import("../gen/octomanager/v2/domain_pb.js").ResumeMergeChainRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "resume",
            ...record(unwire(api.ResumeMergeChainRequestSchema, r)),
          }),
        );
        return { chain: wire(api.DomainMergeChainSchema, result) };
      });
    },
    cancelMergeChain(
      r: import("../gen/octomanager/v2/domain_pb.js").CancelMergeChainRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "cancel",
            ...record(unwire(api.CancelMergeChainRequestSchema, r)),
          }),
        );
        return { chain: wire(api.DomainMergeChainSchema, result) };
      });
    },
    reconcileMergeOperation(
      r: import("../gen/octomanager/v2/domain_pb.js").ReconcileMergeOperationRequest,
    ) {
      return trackingOperation(() => {
        const result = coordinator.merging.command(
          checked(CommandSchema, {
            op: "reconcile",
            ...record(unwire(api.ReconcileMergeOperationRequestSchema, r)),
          }),
        );
        return {
          operation: wire(api.DomainReconciliationResultSchema, result),
        };
      });
    },
  };
}
