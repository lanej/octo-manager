import type { ReviewFeedback } from "../tracking/types.js";
export enum MessageCategory {
  Findings = "findings",
  Informational = "informational",
  Progress = "progress",
  Inconclusive = "inconclusive",
  NoFindings = "no_findings",
  Unknown = "unknown",
}
export type GitHubMessage = Pick<ReviewFeedback, "author" | "body" | "source">;
export interface CategoryDecision {
  category: MessageCategory;
  rule: string;
  reason: string;
}
export interface Categorization extends CategoryDecision {
  author: string;
  classifier: { id: string; version: number; layer: "heuristic" };
}
export interface HeuristicClassifier {
  id: string;
  version: number;
  categorize(message: GitHubMessage): CategoryDecision;
}
