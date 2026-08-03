import { listProjectSessions } from "../storage/index.ts";

export interface ResumeTarget {
    readonly sessionId: string;
    readonly path: string;
}

export type ResolveResumeResult =
    | { readonly ok: true; readonly target: ResumeTarget }
    | { readonly ok: false; readonly error: string };

// Resolves --resume/--continue to a concrete transcript before anything is
// opened. A named session that does not exist must say so rather than replay
// an ENOENT, and a bare resume with no history must never fall through to a
// fresh session — the caller asked to continue something.
export const resolveResumeTarget = async (
    projectId: string,
    sessionId: string | null,
): Promise<ResolveResumeResult> => {
    const summaries = await listProjectSessions(projectId);
    if (sessionId === null) {
        const latest = summaries[0];
        if (!latest) {
            return { ok: false, error: "no previous session to resume in this project" };
        }
        return { ok: true, target: { sessionId: latest.sessionId, path: latest.path } };
    }
    const found = summaries.find((s) => s.sessionId === sessionId);
    if (!found) return { ok: false, error: `session not found: ${sessionId}` };
    return { ok: true, target: { sessionId: found.sessionId, path: found.path } };
};
