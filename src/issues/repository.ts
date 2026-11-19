import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  BriefSchema,
  CommentSchema,
  ReferenceSchema,
  type IssueRecord,
} from "./contracts.js";

export const IssueContentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  ref: ReferenceSchema,
  title: Type.String(),
  body: Type.String(),
  externalClosed: Type.Boolean(),
  comments: Type.Array(CommentSchema),
  brief: Type.Optional(BriefSchema),
  updatedAt: Type.Integer({ minimum: 0 }),
  fieldTimes: Type.Optional(
    Type.Object({
      title: Type.Optional(Type.Integer({ minimum: 0 })),
      body: Type.Optional(Type.Integer({ minimum: 0 })),
      externalClosed: Type.Optional(Type.Integer({ minimum: 0 })),
      brief: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
  ),
});
export type IssueContent = Static<typeof IssueContentSchema>;

/** Persistence only: identities and lifecycle decisions belong to Octo. */
export interface IssueRepository {
  readonly identity: string;
  read(id: string, signal: AbortSignal): Promise<IssueContent | undefined>;
  write(
    content: IssueContent,
    signal: AbortSignal,
    expected: IssueContent | undefined,
  ): Promise<void>;
}
export function contentOf(issue: IssueRecord): IssueContent {
  return {
    id: issue.id,
    ref: issue.ref,
    title: issue.title,
    body: issue.body,
    externalClosed: issue.externalClosed,
    comments: issue.comments,
    ...(issue.brief === undefined ? {} : { brief: issue.brief }),
    updatedAt: issue.updatedAt,
  };
}
export function decodeContent(value: unknown): IssueContent {
  if (!Check(IssueContentSchema, value))
    throw new Error("Invalid issue repository content");
  return value;
}
export function sameContent(left: IssueContent, right: IssueContent): boolean {
  return isDeepStrictEqual(
    { ...left, updatedAt: 0, fieldTimes: undefined },
    { ...right, updatedAt: 0, fieldTimes: undefined },
  );
}

export class IssueStorageError extends Error {}
