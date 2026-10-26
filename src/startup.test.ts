import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

function start(port: number) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

test(
  "an unrelated port listener produces an actionable error without a stack trace",
  { timeout: 15000 },
  async () => {
    const other = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    other.listen(0, "127.0.0.1");
    await once(other, "listening");
    const address = other.address();
    assert.ok(address && typeof address !== "string");
    const run = start(address.port);
    try {
      const [code] = await once(run.child, "exit");
      assert.equal(code, 1);
      assert.match(run.output(), /already in use by another process/);
      assert.match(run.output(), /PORT in .env/);
      assert.doesNotMatch(run.output(), /Unhandled|node:events|at Server/);
    } finally {
      run.child.kill();
      other.closeAllConnections();
      other.close();
    }
  },
);

test(
  "a second start recognises this app and prints its existing URL",
  { timeout: 15000 },
  async () => {
    const temporary = createServer();
    temporary.listen(0, "127.0.0.1");
    await once(temporary, "listening");
    const address = temporary.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve) => temporary.close(() => resolve()));
    const first = start(address.port);
    try {
      await once(first.child.stdout, "data");
      const second = start(address.port);
      try {
        const [code] = await once(second.child, "exit");
        assert.equal(code, 0);
        assert.match(second.output(), /Agent SDK Lesson 58 is already running/);
        assert.match(
          second.output(),
          new RegExp(`http://127.0.0.1:${address.port}`),
        );
        assert.doesNotMatch(second.output(), /Unhandled|node:events/);
      } finally {
        second.child.kill();
      }
    } finally {
      first.child.kill();
    }
  },
);
