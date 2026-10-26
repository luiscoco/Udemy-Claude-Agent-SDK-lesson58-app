import { createServer, type IncomingMessage } from "node:http";
import { mkdir } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { RemoteStore } from "./remote-store.js";
import { FileSessionStore } from "./store.js";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const role = process.env.ROLE || "agent",
  token = process.env.SERVICE_TOKEN;
if (!token) throw new Error("Runtime SERVICE_TOKEN required.");
const backing = new FileSessionStore("/data"),
  leases = new Set<string>();
let failAppend = false,
  active = 0;
async function body(req: IncomingMessage) {
  let text = "";
  for await (const b of req) {
    text += b;
    if (Buffer.byteLength(text) > 1048576) throw new Error("Body too large");
  }
  return JSON.parse(text || "{}");
}
async function mapping() {
  try {
    return JSON.parse(await readFile("/data/sessions.json", "utf8"));
  } catch (e) {
    if ((e as any).code === "ENOENT") return {};
    throw e;
  }
}
async function saveMap(value: any) {
  const tmp = "/data/" + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, "/data/sessions.json");
}
// One external writer owns atomic transcript appends and per-tenant leases.
const server = createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        app: "sdk58-service",
        role,
        uid: process.getuid?.(),
        replica: process.env.REPLICA || "store",
      }),
    );
    return;
  }
  if (req.headers.authorization !== "Bearer " + token) {
    res.writeHead(401);
    res.end("Authentication required");
    return;
  }
  try {
    const input = await body(req),
      op = req.url?.slice(1);
    if (role === "store") {
      let value: any = null;
      if (op === "append") {
        if (failAppend) {
          res.writeHead(503);
          res.end("Classroom mirror outage");
          return;
        }
        await backing.append(input.key, input.entries);
      } else if (op === "load") value = await backing.load(input.key);
      else if (op === "subkeys") value = await backing.listSubkeys(input.key);
      else if (op === "get") value = (await mapping())[input.tenant] ?? null;
      else if (op === "set") {
        const m = await mapping();
        m[input.tenant] = input.sessionId;
        await saveMap(m);
      } else if (op === "lease") {
        if (leases.has(input.tenant)) {
          res.writeHead(409);
          res.end("Tenant busy");
          return;
        }
        leases.add(input.tenant);
      } else if (op === "release") leases.delete(input.tenant);
      else if (op === "fault") failAppend = input.enabled === true;
      else if (op === "inspect")
        value = (await backing.inspect()).map((r) => ({
          key: r.key,
          count: r.entries.length,
        }));
      else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
      return;
    }
    if (op !== "chat" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    // Identity comes only from the authenticated classroom gateway, never prompt text.
    const tenant = req.headers["x-classroom-user"];
    if (
      typeof tenant !== "string" ||
      !["alice", "bob"].includes(tenant) ||
      typeof input.message !== "string" ||
      input.message.length > 2000
    ) {
      res.writeHead(400);
      res.end("Invalid classroom request");
      return;
    }
    if (active >= 1) {
      res.writeHead(429);
      res.end("Replica busy");
      return;
    }
    const store = new RemoteStore(
      process.env.STORE_URL!,
      process.env.STORE_TOKEN!,
      (kind, detail) =>
        send({ type: "observation", observation: { kind, detail } }),
    );
    await store.call("lease", { tenant });
    active++;
    const abortController = new AbortController(),
      deadline = setTimeout(() => abortController.abort(), 90000);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const send = (e: any) => {
      if (!res.destroyed) res.write("data: " + JSON.stringify(e) + "\n\n");
    };
    const disconnect = () => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on("close", disconnect);
    let run: ReturnType<typeof query> | undefined,
      mirrorFailed = false,
      lastResult: any;
    try {
      const cwd = "/work/" + tenant;
      await mkdir(cwd, { recursive: true });
      await mkdir("/tmp/home", { recursive: true });
      const resume = await store.call("get", { tenant });
      const options = {
        cwd,
        resume: resume || undefined,
        sessionStore: store,
        sessionStoreFlush: "eager" as const,
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        tools: [],
        allowedTools: [],
        permissionMode: "dontAsk" as const,
        settingSources: [],
        maxTurns: 3,
        maxBudgetUsd: 0.2,
        effort: "low" as const,
        thinking: { type: "disabled" as const },
        abortController,
        env: {
          ...process.env,
          HOME: "/tmp/home",
          CLAUDE_CONFIG_DIR: "/tmp/home/.claude",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_ENABLE_TELEMETRY: "0",
        },
        systemPrompt:
          "You are a concise classroom memory assistant. Remember the supplied conversation code and answer the requested code exactly. No tools are available.",
      };
      send({
        type: "observation",
        observation: {
          kind: "configuration",
          detail: {
            replica: process.env.REPLICA,
            uid: process.getuid?.(),
            cwd,
            resume,
            tools: [],
            maxTurns: 3,
            maxBudgetUsd: 0.2,
            sessionStoreFlush: "eager",
            sessionStore: "external HTTP store",
            secrets: "runtime only; not returned",
          },
        },
      });
      run = query({ prompt: input.message, options });
      for await (const m of run) {
        if (m.type === "system" && m.subtype === "init")
          send({
            type: "observation",
            observation: {
              kind: "session-init",
              detail: { sessionId: m.session_id, replica: process.env.REPLICA },
            },
          });
        if (m.type === "system" && m.subtype === "mirror_error") {
          mirrorFailed = true;
          send({
            type: "observation",
            observation: {
              kind: "mirror-error",
              detail: { subtype: m.subtype },
            },
          });
        }
        if (m.type === "assistant")
          for (const b of m.message.content)
            if (b.type === "text") send({ type: "text", text: b.text });
        if (m.type === "result") lastResult = m;
      }
      // Wait for the SDK iterator and final mirror flush before committing the mapping.
      if (lastResult?.subtype === "success" && !mirrorFailed)
        await store.call("set", { tenant, sessionId: lastResult.session_id });
      if (lastResult) send({ type: "result", result: lastResult });
      send({
        type: "observation",
        observation: {
          kind: "durability",
          detail: { committed: !mirrorFailed, mirrorFailed },
        },
      });
    } catch (e) {
      send({ type: "error", text: String(e) });
    } finally {
      run?.close();
      clearTimeout(deadline);
      active--;
      try {
        await store.call("release", { tenant });
      } catch {}
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end("Service request failed");
  }
});
server.listen(Number(process.env.PORT || 8080), process.env.HOST || "0.0.0.0");
