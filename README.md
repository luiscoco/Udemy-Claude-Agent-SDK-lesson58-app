# Claude Agent SDK · Lesson 58 · Deploying with Docker

Five student pages, thirteen source-linked UML steps and nine actual Docker deployment experiments.

## What you will learn

- Package the actual SDK service: Compile TypeScript in a Linux build stage and retain the platform-specific optional CLI dependency. Run the HTTP service and its real SDK subprocess as the node user.
- Inject private configuration at runtime: Keep the model key out of source and image layers. The lab creates short-lived private env files and separate random service/store tokens; it never displays their values.
- Move transcripts outside replicas: The SDK mirrors transcript entries to a separate authenticated HTTP store backed by its own Docker volume. The store also maps trusted classroom identities to session IDs.
- Replace and alternate containers: Resume the same session after replacing a replica or sending the next turn to a different replica. A matching per-tenant working directory lets the external transcript hydrate correctly.
- Test deployment boundaries: Observe actual non-root IDs, read-only root filesystems, CPU/memory/PID limits, rejected authentication and distinct tenant sessions. These examples expose no agent tools.
- Handle persistence failures honestly: A mirror_error is a durability failure even when a model answer succeeds. Do not commit a failed transcript mapping. Recover the store with the same volume and verify recall of previously committed turns.

## Configure and run

```powershell
git clone https://github.com/luiscoco/Udemy-Claude-Agent-SDK-lesson58-app.git
cd .\Udemy-Claude-Agent-SDK-lesson58-app
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
npm start
```

From presentations: `cd .\agent-sdk\lesson58-docker-deployment`. Open http://127.0.0.1:3158. Node 24+, model API credit, and Windows Git Bash if required.

## Create your .env file

Preserve the real file locally and enter your own key. Restart after edits. Existing shell values take precedence. No secret is included in source.

```dotenv
ANTHROPIC_API_KEY=your_api_key
CLAUDE_MODEL=claude-sonnet-4-6
PORT=3158
# CLAUDE_CODE_GIT_BASH_PATH=C:/Program Files/Git/bin/bash.exe
```

## Run the student web lab

Keep the terminal open and open the displayed URL. Choose Baseline first, then Resume, Replace, Replicas and Recovery. Each experiment starts its own store plus two replicas, makes real model requests, records evidence and removes only its own UUID-named resources afterward.

```powershell
npm start
# http://127.0.0.1:3158
```

## Verify and run from a terminal

Tests use temporary directories and no model calls. Live pipeline commands require Docker and model credit. They inspect real Docker configuration and actual native results; provider waits can take a while.

```powershell
npm test
npm run pipeline -- baseline
npm run pipeline -- replace
npm run pipeline -- replicas
```

## Explore failures and evidence

Mirror temporarily rejects transcript appends in its own external store. The old committed Alice session stays usable, while Bob’s failed transcript is not committed. Recovery removes and recreates the store container with the same owned volume. Do not treat this single-writer classroom service as a production HA database.

```powershell
npm run pipeline -- mirror
npm run pipeline -- recovery
# Sanitized evidence: .runtime/runs/<run-id>/evidence.json
# Replica ports bind to 127.0.0.1 only; no public deployment is created.
```

## How the app was built


### 1. Build for the target Linux platform

The build stage installs the pinned SDK inside Linux. Keep its optional native CLI dependencies and compile the server. The separate runtime stage omits dev dependencies.

Source: Dockerfile

```docker
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Keep the SDK's platform-specific optional CLI dependencies.
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
```

### 2. Run a non-root runtime image

Copy the compiled app and runtime dependencies, select the node user and start the actual HTTP SDK service. No model key is baked into the image.

Source: Dockerfile

```docker
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "dist/service.js"]
```

### 3. Inject private runtime configuration

Write the private model key and per-run service credentials to an ignored temporary env file. Docker receives the filename; credentials never appear in recorded command arguments or UI evidence.

Source: src/deployment.ts

```typescript
const key = process.env.ANTHROPIC_API_KEY;
    if (!key || /[\r\n]/.test(key))
      throw new Error("Configure a valid private API key.");
    await writeFile(
      join(this.folder, "agent.env"),
      `ANTHROPIC_API_KEY=${key}\nCLAUDE_MODEL=${process.env.CLAUDE_MODEL || "claude-sonnet-4-6"}\nSERVICE_TOKEN=${this.token}\nSTORE_TOKEN=${this.storeToken}\nSTORE_URL=http://${this.id}-store:8080\n`,
      { mode: 0o600 },
    );
    await writeFile(join(this.folder,"store.env"),`SERVICE_TOKEN=${this.storeToken}\nROLE=store\n`,{mode:0o600});
    await this.docker(["network", "create", this.network]);
    await this.docker(["volume", "create", this.volume]);
    await this.startStore();
    await this.replica("a");
```

### 4. Apply container resource boundaries

Run replicas with a read-only root, bounded memory/CPU/PIDs, dropped capabilities, no-new-privileges and explicit writable tmpfs paths. Model API access still needs the bridge network.

Source: src/deployment.ts

```typescript
return [
    "--name",
    name,
    "--network",
    network,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=2g",
    "--cpus=2",
    "--pids-limit=200",
    "--tmpfs",
    "/tmp:rw,nosuid,size=512m,uid=1000,gid=1000",
    "--tmpfs",
    "/work:rw,nosuid,size=64m,uid=1000,gid=1000",
```

### 5. Authenticate the incoming request

Require the random classroom gateway credential before chat or store operations. The browser cannot supply user identities; the host harness chooses Alice or Bob. This is a local teaching gateway, not a production identity provider.

Source: src/service.ts

```typescript
if (req.headers.authorization !== "Bearer " + token) {
    res.writeHead(401);
    res.end("Authentication required");
    return;
  }
```

### 6. Resolve identity and serialize turns

Use only the authenticated gateway’s known identity, reject invalid tasks and acquire the external per-tenant lease. Limit active queries per replica so concurrent turns cannot race within the demonstrated session.

Source: src/service.ts

```typescript
const tenant = req.headers["x-classroom-user"];
    if (
      typeof tenant !== "string" ||
      !["alice", "bob"].includes(tenant) ||
      typeof input.message !== "string" ||
      input.message.length > 2000
```

### 7. Load the retained session ID

Get the tenant’s committed session ID from the external store. Use the same per-tenant working directory in every replica and pass resume plus the actual SessionStore adapter to the SDK.

Source: src/service.ts

```typescript
const resume = await store.call("get", { tenant });
      const options = {
        cwd,
        resume: resume || undefined,
        sessionStore: store,
        sessionStoreFlush: "eager" as const,
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
```

### 8. Invoke query inside the container

The real SDK starts its CLI subprocess inside the non-root agent container and yields actual messages. Observe native init IDs, text, mirror failures and terminal results; no model response is simulated.

Source: src/service.ts

```typescript
run = query({ prompt: input.message, options });
      for await (const m of run) {
        if (m.type === "system" && m.subtype === "init")
          send({
            type: "observation",
            observation: {
              kind: "session-init",
```

### 9. Mirror transcript entries externally

Send actual SDK transcript entries to the authenticated external writer and record only entry counts and IDs in browser evidence. This store mirrors transcripts, not arbitrary workspace files or memory.

Source: src/remote-store.ts

```typescript
async append(key: SessionKey, entries: SessionStoreEntry[]) {
    await this.call("append", { key, entries });
    this.notify("store-append", {
      sessionId: key.sessionId,
      count: entries.length,
    });
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
```

### 10. Commit after the mirror flush

Wait for the actual SDK iterator and final mirroring before saving a successful session mapping. A visible mirror failure prevents that commit even if the native answer succeeded.

Source: src/service.ts

```typescript
// Wait for the SDK iterator and final mirror flush before committing the mapping.
      if (lastResult?.subtype === "success" && !mirrorFailed)
        await store.call("set", { tenant, sessionId: lastResult.session_id });
      if (lastResult) send({ type: "result", result: lastResult });
```

### 11. Replace a replica and hydrate

Delete this run’s owned agent container, launch a new one and check its actual container ID changed. The next query resumes from external storage and must recall the unpredictable conversation code.

Source: src/runner.ts

```typescript
const old = stack.inspect[stack.id + "-a"].id;
        await stack.remove("a");
        await stack.replica("a");
        checks.newContainer = old !== stack.inspect[stack.id + "-a"].id;
      }
      if (caseId === "recovery") {
        await stack.remove("store");
```

### 12. Restart the external store

Recreate the external writer with the same independent Docker volume. The Recovery case checks that both the mapping and transcript survive replacing the store and agent containers.

Source: src/deployment.ts

```typescript
async startStore() {
    await this.launched(this.id + "-store", [
      "-p",
      "127.0.0.1::8080",
      "--mount",
      `type=volume,source=${this.volume},target=/data`,
      "--env-file",
      join(this.folder,"store.env"),
    ]);
  }
```

### 13. Grade actual deployment evidence

Require observed task checks and successful owned-resource cleanup. Persist sanitized evidence with actual native results and Docker configuration. A green label is computed from those measurements, not from fluent narration.

Source: src/runner.ts

```typescript
checks.ownedResourcesCleaned = cleanupErrors.length === 0;
  const passed =
    !exception &&
    Object.keys(checks).length > 3 &&
    Object.values(checks).every(Boolean);
```

### Scope of the deployment

The browser UI and bounded orchestration harness run on your computer. Actual query() and CLI run in two Linux containers. A third container is the external single-writer HTTP session store. The lab cleans up its own stack after each experiment.

### External store versus production storage

The HTTP adapter is implemented in this app, not a built-in RedisSessionStore class. The separate writer serializes transcript appends and uses atomic file replacement on its own volume. Production systems need transactional/CAS semantics, durable infrastructure, tenancy authorization, retention, encryption, lease expiry and HA.

### Gateway and tenant boundary

Random per-run bearer credentials authenticate harness requests. The trusted harness supplies only Alice or Bob. Session IDs are looked up server-side and never accepted from the browser. This demonstrates the contract for a real authentication gateway without claiming to implement public login.

### Durability and interruption

Replacement tests cover completed, committed turns. They do not promise that a turn killed mid-generation is fully durable. Eager mirroring reduces the unflushed window; final persistence errors still matter. The independent store volume survives its container replacement and is deleted only when the experiment is over.

### Resources and isolation

The actual inspect evidence includes user, CPU/memory/PID limits, read-only root, mount types and dropped capabilities. The SDK has no tools in this memory exercise. A distinct cwd alone is not an operating-system tenant boundary. Resource values are classroom settings; measure your real workload rather than assuming a universal RAM requirement.

### Telemetry for a production exercise

Native SDK messages, HTTP statuses, mirror errors and Docker inspect data are captured here. OTLP export is not enabled in this small lab. To extend it, configure CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_METRICS_EXPORTER=otlp, OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_SERVICE_NAME with a private collector. Avoid raw prompts, keys or transcripts in telemetry; observe mirror_error alerts.

### Primary references

https://platform.claude.com/docs/en/agent-sdk/hosting ; https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores ; https://docs.docker.com/build/building/multi-stage/ ; https://docs.docker.com/engine/containers/resource_constraints/ ; Original teaching deck: Lesson58_Build_Deploying_with_Docker.pptx
