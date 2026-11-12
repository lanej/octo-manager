import type { ReviewFeedback } from "./types.js";
import {
  categorizationEngine,
  shouldNotify,
} from "../categorization/engine.js";
import { isCodexSummary } from "../categorization/heuristics/codex.js";
export function actionableFeedback(feedback: ReviewFeedback): boolean {
  return shouldNotify(categorizationEngine.categorize(feedback));
}
export function feedbackExcerpt(feedback: ReviewFeedback): string {
  return isCodexSummary(feedback)
    ? feedback.body.replace(/^(?:\s*<!--[\s\S]*?-->)+\s*/, "")
    : feedback.body;
}
