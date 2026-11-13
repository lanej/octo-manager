import { codexAuthor, codexHeuristic } from "./heuristics/codex.js";
import { copilotHeuristic } from "./heuristics/copilot.js";
import {
  MessageCategory,
  type Categorization,
  type GitHubMessage,
  type HeuristicClassifier,
} from "./types.js";
const githubAuthors: ReadonlyMap<string, HeuristicClassifier> = new Map([
  [codexAuthor, codexHeuristic],
  ["copilot-pull-request-reviewer[bot]", copilotHeuristic],
  ["copilot", copilotHeuristic],
]);
export class CategorizationEngine {
  constructor(
    private readonly authors: ReadonlyMap<
      string,
      HeuristicClassifier
    > = githubAuthors,
  ) {}
  categorize(message: GitHubMessage): Categorization {
    const classifier = this.authors.get(message.author.toLowerCase());
    if (classifier === undefined || message.source === "inline")
      return {
        author: message.author,
        category: MessageCategory.Unknown,
        rule:
          message.source === "inline"
            ? "inline-feedback"
            : "unrecognized-author",
        reason:
          message.source === "inline"
            ? "Inline feedback remains eligible for assessment"
            : "No heuristic registered for this GitHub author",
        classifier: {
          id: "github-author-router",
          version: 1,
          layer: "heuristic",
        },
      };
    return {
      ...classifier.categorize(message),
      author: message.author,
      classifier: {
        id: classifier.id,
        version: classifier.version,
        layer: "heuristic",
      },
    };
  }
}
const notify = {
  [MessageCategory.Findings]: true,
  [MessageCategory.Informational]: false,
  [MessageCategory.Progress]: false,
  [MessageCategory.Inconclusive]: false,
  [MessageCategory.NoFindings]: false,
  [MessageCategory.Unknown]: true,
} satisfies Record<MessageCategory, boolean>;
export function shouldNotify(result: Categorization): boolean {
  return notify[result.category];
}
export const categorizationEngine = new CategorizationEngine();
