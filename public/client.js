import { renderMarkdown } from "./markdown.js";
const $ = (id) => document.getElementById(id);
let data = {}, rows = [], events = [];
function json(id, value) {
    $(id).textContent = JSON.stringify(value, null, 2);
    window.Prism?.highlightElement($(id));
}
function table(id, records) {
    $(id).replaceChildren(...records.map((values) => {
        const tr = document.createElement("tr");
        for (const v of values) {
            const td = document.createElement("td");
            td.textContent = String(v ?? "");
            tr.append(td);
        }
        return tr;
    }));
}
function draw() {
    $("span-count").textContent = data.workerProcess
        ? String(data.workerProcess.exitCode)
        : "Pending";
    $("metric-count").textContent = String(data.results?.length || 0);
    $("log-count").textContent = String((data.observations || []).filter((o) => o.kind === 'http-response').length);
    const obs = data.observations || [];
    table("trace-history", obs
        .filter((o) => ['http-response', 'store-load', 'store-append', 'mirror-error'].includes(o.kind))
        .map((o) => [
        o.kind,
        o.detail.status ?? o.detail.count ?? o.detail.subtype,
        JSON.stringify(o.detail),
    ]));
    table("metric-history", (data.report?.groups || []).map((g) => [
        g.caseId,
        `${g.passed}/${g.runs} (${(100 * g.passRate).toFixed(0)}%)`,
        JSON.stringify({
            avgCostUsd: g.avgCostUsd,
            avgTurns: g.avgTurns,
            wilson95: g.wilson95,
        }),
    ]));
    const filter = $("user-filter").value.trim();
    table("log-history", obs
        .filter((o) => !filter || o.kind === filter)
        .map((o) => [o.kind, JSON.stringify(o.detail)]));
    json("telemetry", obs);
    json("requests", data.tools || []);
}
$("user-filter").addEventListener("input", draw);
$("run").onclick = async () => {
    const button = $("run");
    button.disabled = true;
    data = {};
    rows = [];
    events = [];
    draw();
    $("conversation").replaceChildren();
    $("diff").textContent = "Waiting for the actual job.";
    json("process", {});
    json("evidence", {});
    $("status").textContent = "Running real Docker deployment experiments...";
    try {
        const response = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: $("mode").value }),
        });
        if (!response.ok)
            throw new Error(await response.text());
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = "", text = "";
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let n;
            while ((n = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, n);
                buffer = buffer.slice(n + 2);
                if (!frame.startsWith("data: "))
                    continue;
                const e = JSON.parse(frame.slice(6));
                events.push(e);
                if (e.type === "text") {
                    text += e.text + "\n\n";
                    renderMarkdown($("conversation"), text);
                }
                if (e.type === "observation") {
                    rows.push(e.observation);
                    data.observations = rows;
                    if (e.observation.kind === "configuration")
                        json("options", e.observation.detail);
                    if (e.observation.kind === "native-tool")
                        (data.tools ||= []).push(e.observation.detail);
                    if (e.observation.kind === "tool-result" &&
                        e.observation.detail.tool === "Bash")
                        (data.commands ||= []).push(e.observation.detail);
                    draw();
                }
                if (e.type === "result") {
                    if (e.result.structured_output) {
                        text +=
                            "\n\n```json\n" +
                                JSON.stringify(e.result.structured_output, null, 2) +
                                "\n```\n";
                        renderMarkdown($("conversation"), text);
                    }
                    (data.results ||= []).push(e.result);
                    json("native-result", e.result);
                    draw();
                }
                if (e.type === "evidence") {
                    data = e.evidence;
                    draw();
                    json("evidence", data);
                    $("boundary-summary").textContent = data.scope;
                    json("process", {
                        actualJobProcess: data.workerProcess,
                        reportedExitMatchesActual: data.reportedExitMatchesActual,
                        complete: data.complete,
                        report: data.report,
                        pipelineExitCode: data.pipelineExitCode,
                    });
                    json("storage", {
                        fixturesValid: data.fixturesValid,
                        fixtureUnchanged: data.fixtureUnchanged,
                        runs: data.runs?.map((r) => ({
                            caseId: r.caseId,
                            workspaceId: r.workspaceId,
                            externalRows: r.deployment.externalRows,
                            cleanupErrors: r.cleanupErrors,
                            deploymentChecks: r.checks,
                        })),
                        scope: data.scope,
                    });
                    json("diagnostics", {
                        exception: data.exception,
                        runs: data.runs?.map((r) => ({
                            caseId: r.caseId,
                            exception: r.exception,
                            grade: r.grade,
                            resultSubtype: r.result?.subtype,
                        })),
                        workerStderr: data.workerStderr,
                    });
                    $("diff").textContent = JSON.stringify(data.runs?.map((r) => r.deployment), null, 2);
                    window.Prism?.highlightElement($("diff"));
                    json("host-checks", data.runs?.map((r) => ({
                        caseId: r.caseId,
                        grade: r.grade,
                        checks: r.checks,
                    })));
                }
                if (e.type === "error")
                    throw new Error(e.text);
            }
        }
        $("status").textContent =
            data.workerProcess?.exitCode === 0
                ? "Deployment checks passed: actual process exit 0."
                : "Deployment checks failed or stopped: actual process exit " +
                    String(data.workerProcess?.exitCode) +
                    ". Inspect the native result and gate evidence.";
    }
    catch (e) {
        $("status").textContent = String(e);
    }
    finally {
        button.disabled = false;
    }
};
$("download").onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(events, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lesson58-pipeline-evidence.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
fetch("/api/config")
    .then((r) => r.json())
    .then((c) => {
    $("configuration").textContent = c.ready
        ? "Ready: " +
            c.model +
            ". Actual Docker SDK services, external session storage and authenticated loopback requests."
        : "Configure your private API key in .env and restart. Open How to run.";
    $("run").disabled = !c.ready;
});
draw();
