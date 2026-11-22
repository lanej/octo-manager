import type { SafeNotice } from "../security/notifications.js";
import type { AgentMessage } from "../notifications/message.js";
import type { NotificationRepository } from "../notifications/repository.js";
export type { AgentMessage } from "../notifications/message.js";

export class AgentInbox {
  constructor(private repository: NotificationRepository) {}
  newMessageId(): string {
    return this.repository.newMessageId();
  }
  recoverWorkflows(): void {
    this.repository.recoverWorkflows();
  }
  isReplaced(id: string): boolean {
    return this.repository.isReplaced(id);
  }
  supersede(originalId: string, replacementId: string): void {
    this.repository.supersede(originalId, replacementId);
  }
  markReplacement(originalId: string, replacementId: string): void {
    this.repository.markReplacement(originalId, replacementId);
  }
  freezeNotice(id: string, notice: SafeNotice): void {
    this.repository.freezeNotice(id, notice);
  }
  notice(id: string): SafeNotice | undefined {
    return this.repository.notice(id);
  }
  get(id: string): AgentMessage | undefined {
    return this.repository.get(id);
  }
  render(id: string, notice: SafeNotice): string {
    return this.repository.render(id, notice);
  }
  record(id: string, body: string): AgentMessage {
    return this.repository.record(id, body);
  }
  list(
    agentId: string,
    after = 0,
    includeAcknowledged = false,
    applicableOnly = false,
  ) {
    return this.repository.list(
      agentId,
      after,
      includeAcknowledged,
      applicableOnly,
    );
  }
  acknowledge(id: string, agentId: string): AgentMessage {
    return this.repository.acknowledge(id, agentId);
  }
  defer(id: string, at: number): void {
    this.repository.defer(id, at);
  }
  automatic(message: AgentMessage): AgentMessage {
    const stored = this.repository.notice(message.id);
    const notice =
      stored ??
      ({
        version: 1,
        kind:
          message.issueId !== undefined
            ? "issue"
            : message.submissionId !== undefined
              ? "submission"
              : message.participantPRId !== undefined
                ? "participants"
                : message.workflowPRId !== undefined
                  ? "merge"
                  : "update",
        assessment: "not_required",
        ...(message.issueId !== undefined
          ? { subject: { kind: "issue" as const, id: message.issueId } }
          : {}),
        ...(message.submissionId === undefined
          ? {}
          : {
              subject: {
                kind: "submission" as const,
                id: message.submissionId,
              },
            }),
      } satisfies SafeNotice);
    // Receipt matching uses the exact safe body frozen at delivery, even after a renderer upgrade.
    return {
      ...message,
      notice,
      body:
        stored === undefined ? this.render(message.id, notice) : message.body,
    };
  }
}
