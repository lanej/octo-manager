import type { Client } from "@connectrpc/connect";
import type { SchedulerService } from "../gen/octomanager/v2/scheduler_pb.js";
import type { MergeCommand } from "../merging/contracts.js";
import { wire, unwire } from "./codec.js";
import * as api from "../gen/octomanager/v2/domain_pb.js";
export async function mergeRequest(
  client: Client<typeof SchedulerService>,
  command: MergeCommand,
): Promise<unknown> {
  const { op, ...input } = command;
  switch (op) {
    case "auto_merge": {
      const response = await client.setAutoMerge(
        wire(api.SetAutoMergeRequestSchema, input),
      );
      return {
        prId: response.prId,
        enabled: response.enabled,
        ...(response.entry === undefined
          ? {}
          : { entry: unwire(api.DomainMergeEntrySchema, response.entry) }),
      };
    }
    case "queue": {
      const response = await client.queueMergeChain(
        wire(api.QueueMergeChainRequestSchema, input),
      );
      if (response.chain === undefined) throw new Error("Missing merge result");
      return unwire(api.DomainMergeChainSchema, response.chain);
    }
    case "inspect": {
      const response = await client.inspectMergeChains(
        wire(api.InspectMergeChainsRequestSchema, input),
      );
      if (response.overview === undefined)
        throw new Error("Missing merge result");
      return unwire(api.DomainMergeOverviewSchema, response.overview);
    }
    case "references": {
      const response = await client.listPRReferences(
        wire(api.ListPRReferencesRequestSchema, input),
      );
      return {
        references: response.references.map((value) =>
          unwire(api.DomainPRReferenceSchema, value),
        ),
      };
    }
    case "dependencies": {
      const response = await client.listPRDependencies(
        wire(api.ListPRDependenciesRequestSchema, input),
      );
      return {
        dependencies: response.dependencies.map((value) =>
          unwire(api.DomainDependencySchema, value),
        ),
      };
    }
    case "confirm": {
      const response = await client.confirmPRDependency(
        wire(api.ConfirmPRDependencyRequestSchema, input),
      );
      if (response.dependency === undefined)
        throw new Error("Missing merge result");
      return unwire(api.DomainDependencySchema, response.dependency);
    }
    case "remove": {
      const response = await client.removePRDependency(
        wire(api.RemovePRDependencyRequestSchema, input),
      );
      if (response.dependency === undefined)
        throw new Error("Missing merge result");
      return unwire(api.DomainDependencySchema, response.dependency);
    }
    case "decide": {
      const response = await client.decidePRReference(
        wire(api.DecidePRReferenceRequestSchema, input),
      );
      if (response.reference === undefined)
        throw new Error("Missing merge result");
      return unwire(api.DomainPRReferenceSchema, response.reference);
    }
    case "policy": {
      const response = await client.setMergePolicy(
        wire(api.SetMergePolicyRequestSchema, input),
      );
      if (response.entry === undefined) throw new Error("Missing merge result");
      return unwire(api.DomainMergeEntrySchema, response.entry);
    }
    case "ready": {
      const response = await client.setMergeReady(
        wire(api.SetMergeReadyRequestSchema, input),
      );
      if (response.entry === undefined) throw new Error("Missing merge result");
      return unwire(api.DomainMergeEntrySchema, response.entry);
    }
    case "pause": {
      const response = await client.pauseMergeChain(
        wire(api.PauseMergeChainRequestSchema, input),
      );
      if (response.chain === undefined) throw new Error("Missing merge result");
      return unwire(api.DomainMergeChainSchema, response.chain);
    }
    case "resume": {
      const response = await client.resumeMergeChain(
        wire(api.ResumeMergeChainRequestSchema, input),
      );
      if (response.chain === undefined) throw new Error("Missing merge result");
      return unwire(api.DomainMergeChainSchema, response.chain);
    }
    case "cancel": {
      const response = await client.cancelMergeChain(
        wire(api.CancelMergeChainRequestSchema, input),
      );
      if (response.chain === undefined) throw new Error("Missing merge result");
      return unwire(api.DomainMergeChainSchema, response.chain);
    }
    case "reconcile": {
      const response = await client.reconcileMergeOperation(
        wire(api.ReconcileMergeOperationRequestSchema, input),
      );
      if (response.operation === undefined)
        throw new Error("Missing reconciliation result");
      return unwire(api.DomainReconciliationResultSchema, response.operation);
    }
  }
}
