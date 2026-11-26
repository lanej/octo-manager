import { Compile } from "typebox/compile";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { AutomationPolicySchema, type AutomationPolicy } from "./contracts.js";

const policyValidator = Compile(AutomationPolicySchema);
function storedPolicy(value: unknown): AutomationPolicy {
  if (!policyValidator.Check(value)) throw new Error("Invalid merge-chain data");
  return value;
}
export class RepositoryPolicyStore {
  private policyByPr: StatementSync | undefined;
  private policiesForTick: StatementSync | undefined;

  constructor(private readonly db: DatabaseSync) {}

  get(prId: string): AutomationPolicy | undefined {
    const row = (this.policyByPr ??= this.db.prepare("SELECT value FROM settings WHERE key=?")).get(
      `repository-policy:${prId}`,
    );
    return row === undefined ? undefined : storedPolicy(JSON.parse(String(row["value"])));
  }
  save(policy: AutomationPolicy): void {
    storedPolicy(policy);
    this.db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`repository-policy:${policy.prId}`, JSON.stringify(policy));
  }
  enabledPolicies(): Map<string, AutomationPolicy> {
    return new Map(
      (this.policiesForTick ??= this.db.prepare(
        "SELECT p.id,s.value FROM tracked_prs p JOIN settings s ON s.key='repository-policy:'||p.id WHERE p.enabled=1",
      ))
        .all()
        .map((row) => [String(row["id"]), storedPolicy(JSON.parse(String(row["value"])))]),
    );
  }
}
