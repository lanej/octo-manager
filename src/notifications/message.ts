import type { SafeNotice } from "../security/notifications.js";

export interface AgentMessage {
  sequence: number;
  id: string;
  actionId: string;
  submissionId?: string;
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
