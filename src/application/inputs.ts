import type { InputScope } from "../coordinator/store.js";

interface InputTargets {
  changed(scope?: InputScope): void;
  jobs(): void;
  recipient(agentId: string): void;
}
export class ApplicationInputs {
  private generation = 0;
  private broad = 0;
  private roster = 0;
  private references = new Map<string, number>();
  private targets: InputTargets | undefined;
  private pendingBroad = false;
  private pending = new Map<string, InputScope>();
  private pendingJobs = false;
  private pendingRecipients = new Set<string>();
  recipient = (id: string): void => {
    if (this.targets !== undefined) this.targets.recipient(id);
    else this.pendingRecipients.add(id);
  };
  changed = (scope?: InputScope): void => {
    this.generation++;
    if (scope === undefined) this.roster++;
    else if (scope.prId !== undefined)
      this.references.set(scope.prId, this.generation);
    if (scope === undefined || scope.recipients === "all") this.broad++;
    if (this.targets !== undefined) {
      this.targets.changed(scope);
      return;
    }
    if (scope === undefined) this.pendingBroad = true;
    else {
      const key =
        scope.prId === undefined
          ? `source:${scope.source ?? "unknown"}`
          : `pr:${scope.prId}`;
      const previous = this.pending.get(key);
      this.pending.set(key, {
        ...(scope.prId === undefined ? {} : { prId: scope.prId }),
        ...(previous?.recipients === "all" || scope.recipients === "all"
          ? { recipients: "all" }
          : {}),
        ...(previous?.notificationEligibility === true ||
        scope.notificationEligibility === true
          ? { notificationEligibility: true }
          : {}),
        ...(previous === undefined || previous.source === scope.source
          ? scope.source === undefined
            ? {}
            : { source: scope.source }
          : {}),
      });
    }
  };
  jobs = (): void => {
    if (this.targets !== undefined) this.targets.jobs();
    else this.pendingJobs = true;
  };
  broadRevision = (): string => String(this.broad);
  referenceRevision = (prId?: string): string =>
    prId === undefined
      ? String(this.roster)
      : [this.roster, this.references.get(prId) ?? 0].join(":");
  bind(targets: InputTargets): void {
    if (this.targets !== undefined)
      throw new Error("Application inputs already bound");
    this.targets = targets;
    if (this.pendingBroad) targets.changed();
    else for (const scope of this.pending.values()) targets.changed(scope);
    if (this.pendingJobs) targets.jobs();
    for (const id of this.pendingRecipients) targets.recipient(id);
    this.pendingRecipients.clear();
    this.pending.clear();
    this.pendingBroad = false;
    this.pendingJobs = false;
  }
}
