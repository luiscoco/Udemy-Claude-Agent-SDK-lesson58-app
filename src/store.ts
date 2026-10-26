import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  foldSessionSummary,
  type SessionStore,
  type SessionKey,
  type SessionStoreEntry,
  type SessionSummaryEntry,
} from "@anthropic-ai/claude-agent-sdk";
type Row = {
  key: SessionKey;
  entries: SessionStoreEntry[];
  mtime: number;
  summary?: SessionSummaryEntry;
};
const same = (a: SessionKey, b: SessionKey) =>
  a.projectKey === b.projectKey &&
  a.sessionId === b.sessionId &&
  a.subpath === b.subpath;
/** Single-writer classroom adapter. Use transactions/CAS for concurrent hosts. */
export class FileSessionStore implements SessionStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private async read(): Promise<Row[]> {
    try {
      return JSON.parse(
        await readFile(join(this.directory, "store.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  private async commit(rows: Row[]) {
    await mkdir(this.directory, { recursive: true });
    const temp = join(this.directory, randomUUID() + ".tmp");
    await writeFile(temp, JSON.stringify(rows), { mode: 0o600 });
    await rename(temp, join(this.directory, "store.json"));
  }
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const snapshot = structuredClone(entries),
      savedKey = structuredClone(key);
    return this.serial(async () => {
      if (!snapshot.length) return;
      const rows = await this.read();
      let row = rows.find((r) => same(r.key, savedKey));
      if (!row) {
        row = { key: savedKey, entries: [], mtime: 0 };
        rows.push(row);
      }
      const seen = new Set(
        row.entries.flatMap((e) =>
          typeof e.uuid === "string" ? [e.uuid] : [],
        ),
      );
      const accepted = snapshot.filter((e) => {
        if (typeof e.uuid !== "string") return true;
        if (seen.has(e.uuid)) return false;
        seen.add(e.uuid);
        return true;
      });
      row.entries.push(...accepted);
      row.mtime = Math.max(Date.now(), ...rows.map((r) => r.mtime + 1));
      if (!key.subpath)
        row.summary = foldSessionSummary(row.summary, savedKey, accepted, {
          mtime: row.mtime,
        });
      await this.commit(rows);
    });
  }
  load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.serial(
      async () =>
        (await this.read()).find((r) => same(r.key, key))?.entries ?? null,
    );
  }
  listSessions(projectKey: string) {
    return this.serial(async () =>
      (await this.read())
        .filter((r) => r.key.projectKey === projectKey && !r.key.subpath)
        .map((r) => ({ sessionId: r.key.sessionId, mtime: r.mtime })),
    );
  }
  listSessionSummaries(projectKey: string) {
    return this.serial(async () =>
      (await this.read())
        .filter(
          (r) => r.key.projectKey === projectKey && !r.key.subpath && r.summary,
        )
        .map((r) => r.summary!),
    );
  }
  delete(key: SessionKey): Promise<void> {
    return this.serial(async () => {
      const rows = await this.read();
      await this.commit(
        rows.filter(
          (r) =>
            !(
              r.key.projectKey === key.projectKey &&
              r.key.sessionId === key.sessionId &&
              (!key.subpath || r.key.subpath === key.subpath)
            ),
        ),
      );
    });
  }
  listSubkeys(key: { projectKey: string; sessionId: string }) {
    return this.serial(async () =>
      (await this.read())
        .filter(
          (r) =>
            r.key.projectKey === key.projectKey &&
            r.key.sessionId === key.sessionId &&
            r.key.subpath,
        )
        .map((r) => r.key.subpath!),
    );
  }
  inspect() {
    return this.serial(() => this.read());
  }
}
