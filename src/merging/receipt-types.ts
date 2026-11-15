import { Type, type Static } from "typebox";
import { Method, Sha } from "./contracts.js";

export const ReceiptTargetSchema = Type.Object(
  {
    prId: Type.String({ minLength: 1 }),
    actionId: Type.String({ minLength: 1 }),
    ownerId: Type.String({ minLength: 1 }),
    epoch: Type.Integer(),
    head: Sha,
    context: Type.String({ minLength: 1 }),
    policy: Type.String(),
    method: Method,
  },
  { additionalProperties: false },
);
export type ReceiptTarget = Static<typeof ReceiptTargetSchema>;
export const NoticeReadinessSchema = Type.Object(
  {
    target: ReceiptTargetSchema,
    policy: Type.String(),
    checkedAt: Type.Integer(),
    generation: Type.Integer({ minimum: 1 }),
    recipients: Type.Array(Type.String()),
    retryAt: Type.Integer(),
    eligible: Type.Boolean(),
    reason: Type.String({ maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type NoticeReadiness = Static<typeof NoticeReadinessSchema>;
export interface MessagePresentation {
  defer?: boolean;
  summary?: string;
  mergeTarget?: ReceiptTarget;
}
