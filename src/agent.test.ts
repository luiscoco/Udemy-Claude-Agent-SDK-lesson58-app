import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "./store.js";
import { runtimeFlags } from "./deployment.js";
import { validateConfig } from "./protocol.js";
test("browser cannot choose commands, identities or unbounded experiments", () => {
  assert.equal(validateConfig({ mode: "replace" }).mode, "replace");
  assert.throws(() => validateConfig({ mode: "replace", tenant: "../bob" }));
  assert.throws(() => validateConfig({ mode: "shell" }));
});
test("deployment constrains actual Docker resources without a key in command arguments", () => {
  const flags = runtimeFlags("sdk58-test", "sdk58-test-net");
  for (const value of [
    "--read-only",
    "--cap-drop=ALL",
    "--memory=2g",
    "--cpus=2",
    "--pids-limit=200",
  ])
    assert.ok(flags.includes(value));
  assert.ok(!flags.join(" ").includes("ANTHROPIC_API_KEY"));
});
test("external writer deduplicates transcript UUIDs and survives reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdk58-store-test-"));
  try {
    const store = new FileSessionStore(dir),
      key = { projectKey: "classroom-alice", sessionId: "session-test" };
    const entry = {
      uuid: "message-1",
      type: "user",
      message: { role: "user", content: "hello" },
    };
    await Promise.all([store.append(key, [entry]), store.append(key, [entry])]);
    assert.equal((await new FileSessionStore(dir).load(key))?.length, 1);
    assert.equal(
      await store.load({ ...key, projectKey: "classroom-bob" }),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
