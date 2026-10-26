import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
export function cliExecutable() {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
  );
  return join(
    dirname(pkg),
    process.platform === "win32" ? "claude.exe" : "claude",
  );
}
export function runProcess(
  program: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) {
  return new Promise<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "",
      stderr = "";
    let overflow = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 1000000) {
        overflow = true;
        child.kill();
      }
    });
    child.stderr.on(
      "data",
      (chunk) => (stderr = (stderr + chunk.toString()).slice(-20000)),
    );
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      options.signal?.removeEventListener("abort", abort);
      if (overflow)
        reject(new Error("Child output exceeded the classroom limit."));
      else resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
export function privateEnv(w: {
  home: string;
  config: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env))
    if (
      /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/.test(k) &&
      k !== "ANTHROPIC_API_KEY"
    )
      delete env[k];
  for (const k of [
    "NODE_OPTIONS",
    "NODE_TEST_CONTEXT",
    "NODE_TEST_REPORTER",
    "CLAUDECODE",
    "CLAUDE_CODE_SIMPLE",
  ])
    delete env[k];
  return {
    ...env,
    HOME: w.home,
    USERPROFILE: w.home,
    CLAUDE_CONFIG_DIR: w.config,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_ENABLE_TELEMETRY: "0",
    OTEL_LOG_RAW_API_BODIES: "0",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
  };
}
export function redact(value: string) {
  for (const key of [
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
  ].filter(Boolean) as string[])
    value = value.split(key).join("[REDACTED]");
  return value.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
}
