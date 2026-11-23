import { fields, rows } from "../cli/projection.js";
const participants = fields(["total", "hasMore"], {
  participants: rows(fields(["agentId", "role", "label", "harness"])),
});
export const subscriptionsOutputs = {
  subscribe: participants,
  unsubscribe: participants,
  participants,
};
