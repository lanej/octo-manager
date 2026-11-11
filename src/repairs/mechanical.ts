import {
  expandInlineSequences,
  validYamlCandidate,
  yamlRecipe,
} from "./yaml.js";
import { RecipeDecision, type ConflictStore } from "./cases.js";
import type { RebaseWorkspace } from "./git.js";
export async function mechanicalConflicts(
  workspace: RebaseWorkspace,
  paths: string[],
  store: ConflictStore,
  repairId: string,
  round: number,
): Promise<{
  remaining: string[];
  cases: Map<string, number>;
  applied: number;
}> {
  const remaining: string[] = [],
    cases = new Map<string, number>();
  let applied = 0;
  const toolVersion = (await workspace.git(["--version"])) + "; yaml@2.9.0";
  for (const path of paths) {
    const captured = await workspace.conflictInputs(path);
    const id = store.add(
      repairId,
      round,
      path,
      yamlRecipe,
      captured.refs,
      toolVersion,
      captured.inputs,
    );
    cases.set(path, id);
    if (!/\.ya?ml$/iu.test(path)) {
      store.decide(id, RecipeDecision.Declined, "File is not YAML");
      remaining.push(path);
      continue;
    }
    if (captured.inputs === undefined) {
      store.decide(
        id,
        RecipeDecision.Declined,
        "Three regular UTF-8 text stages are required; input capture unavailable",
      );
      remaining.push(path);
      continue;
    }
    let expanded;
    try {
      expanded = expandInlineSequences(captured.inputs);
    } catch (error) {
      store.decide(
        id,
        RecipeDecision.Declined,
        error instanceof Error ? error.message : "Unsupported YAML",
      );
      remaining.push(path);
      continue;
    }
    try {
      const candidate = await workspace.mergeText(expanded);
      if (
        candidate === undefined ||
        !validYamlCandidate(candidate, expanded.expected)
      ) {
        store.decide(
          id,
          RecipeDecision.Declined,
          "Expanded versions still conflict or do not form valid YAML",
          candidate,
        );
        remaining.push(path);
        continue;
      }
      store.decide(
        id,
        RecipeDecision.Pending,
        "Candidate retained; applying to the isolated worktree",
        candidate,
      );
      await workspace.write(path, candidate);
      store.decide(
        id,
        RecipeDecision.Applied,
        "Expanded inline sequences and merged non-overlapping lines; repository validation is still required",
        candidate,
      );
      applied++;
    } catch (error) {
      store.decide(
        id,
        RecipeDecision.Error,
        error instanceof Error ? error.message : "Mechanical resolver failed",
      );
      remaining.push(path);
    }
  }
  return { remaining, cases, applied };
}
