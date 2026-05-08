import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getProjectSessionsDir, getSidechainSessionsDir } from "./paths.ts";

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

const openSessionInDir = async (dir: string): Promise<SessionHandle> => {
    const sessionId = crypto.randomUUID();
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

export const openSession = (projectId: string): Promise<SessionHandle> =>
    openSessionInDir(getProjectSessionsDir(projectId));

export const openSidechainSession = (
    projectId: string,
    parentSessionId: string,
): Promise<SessionHandle> => openSessionInDir(getSidechainSessionsDir(projectId, parentSessionId));

// Re-open an existing session JSONL in append mode. Used by --resume / /resume
// so the resumed conversation continues writing to the same transcript.
export const openExistingSession = async (
    projectId: string,
    sessionId: string,
): Promise<SessionHandle> => {
    const dir = getProjectSessionsDir(projectId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
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
