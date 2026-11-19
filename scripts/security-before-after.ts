import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runBeforeAfter } from "../test/support/security-before-after.js";
const directory = resolve(process.argv[2] ?? "build/security-before-after");
const report = await runBeforeAfter();
await mkdir(directory, { recursive: true });
const rows = [
  [
    "Attack reaches direct owner context",
    report.checks.beforeDirectExposesAttack,
    report.checks.afterDirectExposesAttack,
  ],
  [
    "Attack reaches digest owner context",
    report.checks.beforeDigestExposesAttack,
    report.checks.afterDigestExposesAttack,
  ],
  [
    "Simulated publish_secret calls (direct)",
    report.checks.beforeDirectSimulatedPublishCalls,
    report.checks.afterDirectSimulatedPublishCalls,
  ],
  [
    "Simulated publish_secret calls (digest)",
    report.checks.beforeDigestSimulatedPublishCalls,
    report.checks.afterDigestSimulatedPublishCalls,
  ],
];
const markdown = `# Before and after: malicious review feedback\n\nVerdict: ${report.passed ? "PASS: positive control exposed the attack; current paths contained it" : "FAIL: inspect report.json for contradictory observations"}.\n\nMode: ${report.mode}.\n\nBaseline: ${report.baselineCommit}; current source fingerprint: ${report.afterSourceSha256}.\n\n| Observation | Before | After |\n| --- | --- | --- |\n${rows.map((row) => `| ${row.map((value) => String(value)).join(" | ")} |`).join("\n")}\n\n${report.passed ? "The new recovery and receipt outputs also omit the attack. Hostile feedback and assessment analysis remain stored. The malicious schema-valid assessment completes; the forbidden worker request fails. Both actions stay open, receipts are confirmed, and benign feedback still delivers." : "The expected containment conditions did not all hold. The JSON report retains every observed result."}\n\n## Limits\n\n${report.limits}\n\n## Before: direct owner context\n\n\`\`\`text\n${report.before.direct}\n\`\`\`\n\n## After: direct owner context\n\n\`\`\`text\n${report.after.direct.join("\n\n")}\n\`\`\`\n`;
await writeFile(
  join(directory, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(join(directory, "report.md"), markdown);
await writeFile(
  join(directory, "before-digest.txt"),
  report.before.digest + "\n",
);
await writeFile(
  join(directory, "after-digest.txt"),
  report.after.digest + "\n",
);
console.log(
  JSON.stringify(
    {
      report: join(directory, "report.md"),
      passed: report.passed,
      checks: report.checks,
    },
    null,
    2,
  ),
);

if (!report.passed) process.exitCode = 1;
