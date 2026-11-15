import { Check } from "typebox/value";
import {
  PolicyAnalysisSchema,
  ChangeAnalysisSchema,
  WriterSchema,
  type Submission,
} from "../submissions/contracts.js";
import { record } from "./codec.js";
export function archiveSubmission(value: Submission) {
  return {
    ...value,
    stages: value.stages.map((stage) => {
      const schema =
        stage.role === "policy"
          ? PolicyAnalysisSchema
          : stage.role === "change"
            ? ChangeAnalysisSchema
            : WriterSchema;
      const { result, ...saved } = stage;
      return {
        ...saved,
        ...(Check(schema, result) ? { result } : { invalidResult: true }),
      };
    }),
  };
}
export function digestInspection(
  value: ReturnType<
    import("../notifications/service.js").DigestService["inspect"]
  >,
) {
  const textKeys = [
      "reason",
      "queueId",
      "clientId",
      "dispatchId",
      "operation",
      "socket",
      "error",
      "state",
    ],
    numberKeys = ["revision", "receivedRevision", "currentRevision"];
  return {
    ...value,
    events: value.events.map((event) => {
      const raw = record(event.detail),
        detail: Record<string, unknown> = {};
      for (const key of textKeys)
        if (typeof raw[key] === "string") detail[key] = raw[key];
      for (const key of numberKeys)
        if (typeof raw[key] === "number") detail[key] = raw[key];
      if (
        Array.isArray(raw["messages"]) &&
        raw["messages"].every((item: unknown) => typeof item === "string")
      )
        detail["messages"] = raw["messages"];
      if (typeof raw["deleted"] === "boolean")
        detail["deleted"] = raw["deleted"];
      return { ...event, detail };
    }),
  };
}
