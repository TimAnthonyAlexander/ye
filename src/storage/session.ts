import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getProjectSessionsDir } from "./paths.ts";

export interface SessionEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly path: string;
  appendEvent(event: SessionEvent): Promise<void>;
  close(): Promise<void>;
}

export const openSession = async (projectId: string): Promise<SessionHandle> => {
  const sessionId = crypto.randomUUID();
  const dir = getProjectSessionsDir(projectId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  // Touch the file so consumers can stat it before any event is appended.
  await appendFile(path, "");

  let closed = false;

  return {
    sessionId,
    path,
    async appendEvent(event: SessionEvent): Promise<void> {
      if (closed) throw new Error("session closed");
      const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
      await appendFile(path, line);
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
};
