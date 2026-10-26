import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateConfig,
  MODES,
  type RunConfig,
  type LabEvent,
} from "./protocol.js";
import { redact } from "./processes.js";
export { validateConfig, MODES };
export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
export const DEFAULT_CONFIG: RunConfig = { mode: "baseline" };
export const PROMPTS = Object.fromEntries(
  MODES.map((m) => [m, "Run the fixed trusted classroom evaluation job."]),
);
export async function runAgent(
  value: RunConfig,
  emit: (e: LabEvent) => void,
  controller = new AbortController(),
) {
  const { mode } = validateConfig(value);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./job.ts", import.meta.url)),
      mode,
    ],
    {
      cwd: root,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let pending = "",
    stderr = "",
    record: any = null,
    total = 0;
  const cancel = () => {
    if (child.connected) child.send({ type: "abort" });
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  if (controller.signal.aborted) cancel();
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => {
    total += chunk.length;
    if (total > 2000000) {
      cancel();
      return;
    }
    pending += chunk.toString();
    let n: number;
    while ((n = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, n);
      pending = pending.slice(n + 1);
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "job-evidence") record = e.evidence;
        else emit(e);
      } catch {
        stderr += "Worker emitted a non-JSON line. ";
      }
    }
  });
  child.stderr!.on(
    "data",
    (chunk) => (stderr = (stderr + chunk.toString()).slice(-20000)),
  );
  const actual = await new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  controller.signal.removeEventListener("abort", cancel);
  const evidence = JSON.parse(
    redact(
      JSON.stringify({
        ...record,
        mode,
        workerProcess: actual,
        workerStderr: stderr,
        workerOutputBytes: total,
        reportedExitMatchesActual: record?.pipelineExitCode === actual.exitCode,
      }),
    ),
  );
  if (!record)
    throw new Error(
      "The pipeline worker exited without evidence. Check its startup configuration.",
    );
  emit({ type: "evidence", evidence });
  emit({ type: "done" });
  return evidence;
}
