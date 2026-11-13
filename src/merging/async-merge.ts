import { Type } from "typebox";
import { checked, Sha } from "./contracts.js";
export type MergeProgress =
  | { state: "pending"; requestId: string }
  | { state: "merged"; sha: string }
  | { state: "failed" | "enqueued"; reason: string };
const uuid = Type.String({ pattern: "^[a-fA-F0-9-]{36}$" });
const response = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("merged"),
      Type.Literal("failed"),
      Type.Literal("enqueued"),
    ]),
  ),
  uuid: Type.Optional(uuid),
  details: Type.Optional(
    Type.Object({
      uuid: Type.Optional(uuid),
      sha: Type.Optional(Sha),
      message: Type.Optional(Type.String({ maxLength: 6000 })),
    }),
  ),
});
export function mergeProgress(
  value: unknown,
  requestId?: string,
): MergeProgress {
  const parsed = checked(response, value);
  switch (parsed.status) {
    case "merged":
      if (parsed.details?.sha === undefined)
        throw new Error("Merge result omitted its revision");
      return { state: "merged", sha: parsed.details.sha };
    case "failed":
    case "enqueued":
      return {
        state: parsed.status,
        reason: parsed.details?.message ?? `GitHub merge ${parsed.status}`,
      };
    case "pending":
    case undefined: {
      const id = parsed.uuid ?? parsed.details?.uuid ?? requestId;
      if (id === undefined)
        throw new Error("Merge request omitted its identity");
      return { state: "pending", requestId: id };
    }
  }
  throw new Error("Unsupported asynchronous merge response");
}

export class MergeDeclined extends Error {}
