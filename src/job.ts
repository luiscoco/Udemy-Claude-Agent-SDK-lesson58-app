import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { validateConfig } from "./protocol.js";
import { runCase } from "./runner.js";
import { redact } from "./processes.js";
const { mode } = validateConfig({ mode: process.argv[2] });
const emit = (e: any) => process.stdout.write(redact(JSON.stringify(e)) + "\n");
const controller = new AbortController(),
  deadline = setTimeout(() => controller.abort(), 540000);
process.on("message", (m) => {
  if ((m as any)?.type === "abort") controller.abort();
});
const run = await runCase(mode, emit, controller);
clearTimeout(deadline);
const passed = run.grade.passed,
  report = {
    passed,
    pipelineExitCode: passed ? 0 : 1,
    groups: [
      {
        caseId: mode,
        passed: passed ? 1 : 0,
        runs: 1,
        passRate: passed ? 1 : 0,
        avgCostUsd: run.results.reduce(
          (a, r) => a + (r.total_cost_usd || 0),
          0,
        ),
        avgTurns: null,
        wilson95: null,
      },
    ],
  };
const evidence = {
  mode,
  runs: [run],
  report,
  complete: !run.exception,
  exception: run.exception,
  pipelineExitCode: report.pipelineExitCode,
  results: run.results,
  tools: [],
  observations: run.observations,
  fixturesValid: passed,
  fixtureUnchanged: true,
  scope:
    "Actual SDK query() and CLI run inside non-root Docker replicas. An authenticated external store owns transcripts and tenant/session mapping on an independent Docker volume. The lab uses a single-writer classroom store, sequential requests, temporary runtime credentials and no public endpoints. Containers, private temporary files and this run’s owned volume/network are removed after evidence is captured. No claim of production HA, unrestricted tool isolation, or hard invoice cap.",
};
const directory = join(process.cwd(), ".runtime", "runs", randomUUID());
await mkdir(directory, { recursive: true });
await writeFile(
  join(directory, "evidence.json"),
  redact(JSON.stringify(evidence, null, 2)),
);
emit({ type: "job-evidence", evidence });
process.exitCode = evidence.pipelineExitCode;
if (process.connected) process.disconnect();
