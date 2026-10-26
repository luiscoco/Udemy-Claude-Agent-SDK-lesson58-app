import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./processes.js";
export const IMAGE = "claude-sdk-lesson58:local";
export function runtimeFlags(name: string, network: string) {
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
  ];
}
export class Deployment {
  readonly id = "sdk58-" + randomUUID();
  readonly network = this.id + "-net";
  readonly volume = this.id + "-data";
  readonly token = randomUUID();
  readonly storeToken = randomUUID();
  names = new Set<string>();
  ports: Record<string, string> = {};
  inspect: Record<string, any> = {};
  private folder = "";
  constructor(
    readonly observe: (kind: string, detail: any) => void,
    readonly signal: AbortSignal,
  ) {}
  async docker(args: string[], ignore = false) {
    const r = await runProcess("docker", args, {
      cwd: process.cwd(),
      env: process.env,
      signal: ignore ? undefined : this.signal,
    });
    if (r.exitCode && !ignore)
      throw new Error(
        "Docker " + args[0] + " failed: " + r.stderr.slice(-1000),
      );
    return r;
  }
  async start() {
    await this.docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"]);
    this.folder = await mkdtemp(join(tmpdir(), "sdk58-env-"));
    // Values go in a private temporary env file, never Docker command arguments or build layers.
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
    await this.replica("b");
  }
  async launched(name: string, args: string[]) {
    this.names.add(name);
    await this.docker([
      "run",
      "-d",
      ...runtimeFlags(name, this.network),
      ...args,
      IMAGE,
    ]);
    const raw = JSON.parse((await this.docker(["inspect", name])).stdout)[0];
    const policy = {
      container: name,
      id: raw.Id,
      user: raw.Config.User,
      readOnly: raw.HostConfig.ReadonlyRootfs,
      memoryBytes: raw.HostConfig.Memory,
      nanoCpus: raw.HostConfig.NanoCpus,
      pids: raw.HostConfig.PidsLimit,
      capDrop: raw.HostConfig.CapDrop,
      securityOpt: raw.HostConfig.SecurityOpt,
      network: raw.HostConfig.NetworkMode,
      mounts: raw.Mounts.map((m: any) => ({
        destination: m.Destination,
        type: m.Type,
        rw: m.RW,
      })),
      image: raw.Image,
      environmentNames: raw.Config.Env.map((e: string) => e.split("=")[0]),
    };
    if (
      policy.user !== "node" ||
      !policy.readOnly ||
      policy.pids !== 200 ||
      !policy.capDrop.includes("ALL")
    )
      throw new Error("Unexpected actual container boundary.");
    this.inspect[name] = policy;
    const port = raw.NetworkSettings.Ports["8080/tcp"][0].HostPort;
    this.ports[name] = "http://127.0.0.1:" + port;
    for (let i = 0; i < 100; i++) {
      if (this.signal.aborted) throw new Error("Cancelled");
      try {
        const r = await fetch(this.ports[name] + "/health");
        if (r.ok) {
          this.observe("container-ready", policy);
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("Container health timed out.");
  }
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
  async replica(label: string) {
    await this.launched(this.id + "-" + label, [
      "-p",
      "127.0.0.1::8080",
      "--env-file",
      join(this.folder, "agent.env"),
      "-e",
      "REPLICA=" + label,
    ]);
  }
  url(label: string) {
    return this.ports[this.id + "-" + label];
  }
  async remove(label: string) {
    const name = this.id + "-" + label;
    await this.docker(["rm", "-f", name]);
    this.names.delete(name);
    this.observe("container-removed", { name });
  }
  async store(op: string, input: any = {}) {
    const r = await fetch(this.url("store") + "/" + op, {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.storeToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("Store HTTP " + r.status);
    return r.json();
  }
  async chat(
    label: string,
    tenant: string,
    message: string,
    emit: (e: any) => void,
    authorized = true,
  ) {
    const r = await fetch(this.url(label) + "/chat", {
      method: "POST",
      headers: {
        authorization: "Bearer " + (authorized ? this.token : "invalid"),
        "x-classroom-user": tenant,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message }),
      signal: this.signal,
    });
    const events: any[] = [];
    if (!r.ok) return { httpStatus: r.status, events };
    let buffer = "";
    const reader = r.body!.getReader(),
      decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let n: number;
      while ((n = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, n);
        buffer = buffer.slice(n + 2);
        if (frame.startsWith("data: ")) {
          const e = JSON.parse(frame.slice(6));
          events.push(e);
          emit(e);
        }
      }
    }
    return { httpStatus: r.status, events };
  }
  async close() {
    const errors: string[] = [];
    for (const name of this.names) {
      const r = await this.docker(["rm", "-f", name], true);
      if (r.exitCode) errors.push("container cleanup failed");
    }
    for (const args of [
      ["volume", "rm", this.volume],
      ["network", "rm", this.network],
    ]) {
      const r = await this.docker(args, true);
      if (r.exitCode) errors.push(args[0] + " cleanup failed");
    }
    if (this.folder)
      await rm(this.folder, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    return errors;
  }
}
