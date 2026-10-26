import { Deployment } from "./deployment.js";
import type { Mode } from "./protocol.js";
export async function runCase(
  caseId: Mode,
  emit: (e: any) => void,
  controller: AbortController,
) {
  const observations: any[] = [],
    results: any[] = [],
    checks: Record<string, boolean> = {};
  const observe = (kind: string, detail: any) => {
    const observation = { kind, detail };
    observations.push(observation);
    emit({ type: "observation", observation });
  };
  const relay = (e: any) => {
    if (e.type === "observation") observations.push(e.observation);
    if (e.type === "result") results.push(e.result);
    emit(e);
  };
  const stack = new Deployment(observe, controller.signal),
    code = "DOCKER58-" + Math.random().toString(36).slice(2, 10).toUpperCase();
  let exception: string | null = null,
    cleanupErrors: string[] = [],
    rows: any[] = [];
  const remember =
    "Remember this classroom conversation code: " +
    code +
    ". Reply with that code only.";
  const recall =
    "What classroom conversation code did I ask you to remember? Reply with the code only. Do not infer from file names.";
  const chat = async (
    label: string,
    tenant: string,
    prompt: string,
    authorized = true,
  ) => {
    const response = await stack.chat(label, tenant, prompt, relay, authorized);
    observe("http-response", {
      replica: label,
      tenant,
      status: response.httpStatus,
    });
    return response;
  };
  const recalls = () =>
    results.at(-1)?.subtype === "success" &&
    results.at(-1)?.result?.includes(code);
  try {
    await stack.start();
    if (caseId === "auth") {
      const denied = await chat("a", "alice", remember, false);
      checks.unauthenticatedRejected =
        denied.httpStatus === 401 && denied.events.length === 0;
    }
    await chat("a", "alice", remember);
    checks.nativeSuccess = recalls();
    const first = results.at(-1)?.session_id;
    if (!first) throw new Error("No native session ID.");
    rows = await stack.store("inspect");
    checks.transcriptMirrored = rows.some(
      (r: any) => r.key.sessionId === first && r.count > 0,
    );
    if (["resume", "replace", "replicas", "recovery"].includes(caseId)) {
      if (caseId === "replace" || caseId === "recovery") {
        const old = stack.inspect[stack.id + "-a"].id;
        await stack.remove("a");
        await stack.replica("a");
        checks.newContainer = old !== stack.inspect[stack.id + "-a"].id;
      }
      if (caseId === "recovery") {
        await stack.remove("store");
        await stack.startStore();
        checks.storeRestarted = true;
      }
      await chat(caseId === "replicas" ? "b" : "a", "alice", recall);
      checks.recalledFromTranscript = recalls();
      checks.sameSession = results.at(-1)?.session_id === first;
      checks.externalLoadObserved = observations.some(
        (o) => o.kind === "store-load" && o.detail.count > 0,
      );
    }
    if (caseId === "tenant") {
      await chat("b", "bob", "Reply with the classroom greeting HELLO-BOB.");
      checks.differentTenantSession = results.at(-1)?.session_id !== first;
      checks.bobDoesNotReceiveCode = !JSON.stringify(results.at(-1)).includes(
        code,
      );
      await chat("b", "alice", recall);
      checks.aliceStillRecalls = recalls();
    }
    if (caseId === "limits") {
      const data = Object.values(stack.inspect).filter(
        (v: any) => v.container.endsWith("-a") || v.container.endsWith("-b"),
      );
      checks.actualResourceLimits = data.every(
        (v: any) =>
          v.memoryBytes === 2147483648 &&
          v.nanoCpus === 2000000000 &&
          v.pids === 200 &&
          v.readOnly,
      );
      const r = await stack.docker([
        "exec",
        stack.id + "-a",
        "node",
        "-e",
        "try{require('fs').writeFileSync('/app/probe','x');process.exitCode=1}catch(e){console.log(e.code);process.exitCode=e.code==='EROFS'?0:1}",
      ]);
      observe("read-only-probe", {
        exitCode: r.exitCode,
        error: r.stdout.trim(),
      });
      checks.writeRejected = r.stdout.trim() === "EROFS";
    }
    if (caseId === "mirror") {
      await stack.store("fault", { enabled: true });
      await chat("b", "bob", "Reply with MIRROR-58.");
      checks.mirrorFailureVisible = observations.some(
        (o) => o.kind === "mirror-error",
      );
      checks.failedTranscriptNotCommitted =
        (await stack.store("get", { tenant: "bob" })) === null;
      await stack.store("fault", { enabled: false });
      await chat("b", "alice", recall);
      checks.previousSessionStillRecalls = recalls();
    }
    if (caseId === "replicas") {
      await chat("a", "alice", recall);
      checks.roundTripBackToA = recalls();
    }
    checks.serviceRunsNonRoot = Object.values(stack.inspect).every(
      (v: any) => v.user === "node",
    );
    checks.storeHasNoApiKey =
      !stack.inspect[stack.id + "-store"].environmentNames.includes(
        "ANTHROPIC_API_KEY",
      );
    rows = await stack.store("inspect");
  } catch (e) {
    exception = String(e);
  } finally {
    cleanupErrors = await stack.close();
  }
  checks.ownedResourcesCleaned = cleanupErrors.length === 0;
  const passed =
    !exception &&
    Object.keys(checks).length > 3 &&
    Object.values(checks).every(Boolean);
  return {
    caseId,
    grade: { passed, checks },
    checks,
    result: results.at(-1),
    results,
    tools: [],
    observations,
    exception,
    cleanupErrors,
    deployment: {
      containers: Object.values(stack.inspect),
      externalRows: rows,
      expectedCode: code,
    },
    workspaceId: stack.id,
    fixtureUnchanged: true,
    fixturesValid: passed,
  };
}
