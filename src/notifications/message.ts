import type { SafeNotice } from "../security/notifications.js";

export type NotificationSource =
  | { kind: "action"; id: string }
  | { kind: "merge"; id: string }
  | { kind: "issue"; id: string }
  | { kind: "submission"; id: string }
  | { kind: "participants"; id: string }
  | { kind: "reference"; id: string }
  | { kind: "unavailable" };

export interface NotificationItem {
  source?: NotificationSource;
  sequence: number;
  id: string;
  actionId: string;
  submissionId?: string;
  issueId?: string;
  participantPRId?: string;
  workflowPRId?: string;
  recipientAgentId: string;
  body: string;
  notice?: SafeNotice;
  createdAt: number;
  acknowledgedAt?: number;
  nextCheckAt: number;
  applicable: boolean;
}

// Existing producer interfaces still use the historical per-item name.
export type AgentMessage = NotificationItem;
