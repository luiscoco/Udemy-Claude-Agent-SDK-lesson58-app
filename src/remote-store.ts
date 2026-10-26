import type {
  SessionStore,
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
export class RemoteStore implements SessionStore {
  constructor(
    readonly base: string,
    readonly token: string,
    readonly notify: (kind: string, detail: any) => void = () => {},
  ) {}
  async call(op: string, input: any = {}) {
    const r = await fetch(this.base + "/" + op, {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("External store " + op + " HTTP " + r.status);
    return r.json();
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]) {
    await this.call("append", { key, entries });
    this.notify("store-append", {
      sessionId: key.sessionId,
      count: entries.length,
    });
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const entries = await this.call("load", { key });
    this.notify("store-load", {
      sessionId: key.sessionId,
      count: entries?.length ?? null,
    });
    return entries;
  }
  listSubkeys(key: { projectKey: string; sessionId: string }) {
    return this.call("subkeys", { key });
  }
}
