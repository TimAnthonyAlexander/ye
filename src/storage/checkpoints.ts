import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionCheckpointsDir, getTurnCheckpointDir } from "./paths.ts";

// On-disk checkpoint format:
//   ~/.ye/projects/<hash>/checkpoints/<sessionId>/<turnIndex>/
//     ├── manifest.json   — list of CheckpointEntry
//     └── file-N.snap     — raw bytes of each captured original
//
// snapshotName === null signals "file did not exist before this turn"; rewinding
// past such an entry deletes the file rather than restoring it.

export interface CheckpointEntry {
    readonly path: string;
    readonly snapshotName: string | null;
    readonly ts: string;
}

interface Manifest {
    readonly turnIndex: number;
    readonly entries: readonly CheckpointEntry[];
}

const manifestPath = (projectId: string, sessionId: string, turnIndex: number): string =>
    join(getTurnCheckpointDir(projectId, sessionId, turnIndex), "manifest.json");

const isNotFoundError = (err: unknown): boolean =>
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";

const loadManifest = async (
    projectId: string,
    sessionId: string,
    turnIndex: number,
): Promise<Manifest> => {
    try {
        const raw = await readFile(manifestPath(projectId, sessionId, turnIndex), "utf8");
        return JSON.parse(raw) as Manifest;
    } catch (err) {
        if (isNotFoundError(err)) return { turnIndex, entries: [] };
        throw err;
    }
};

const writeManifest = async (
    projectId: string,
    sessionId: string,
    manifest: Manifest,
): Promise<void> => {
    const dir = getTurnCheckpointDir(projectId, sessionId, manifest.turnIndex);
    await mkdir(dir, { recursive: true });
    await writeFile(
        manifestPath(projectId, sessionId, manifest.turnIndex),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
};

export interface CheckpointInput {
    readonly projectId: string;
    readonly sessionId: string;
    readonly turnIndex: number;
    readonly path: string;
}

// Snapshot a file before a state-modifying tool writes to it. No-op if the
// same path was already checkpointed in this turn (preserves the original-
// original across multi-Edit-per-turn flows). When the file doesn't exist on
// disk (Write creating a new file), records snapshotName: null so /rewind can
// delete the created file.
export const checkpointFile = async (input: CheckpointInput): Promise<void> => {
    const dir = getTurnCheckpointDir(input.projectId, input.sessionId, input.turnIndex);
    await mkdir(dir, { recursive: true });

    const manifest = await loadManifest(input.projectId, input.sessionId, input.turnIndex);
    if (manifest.entries.some((e) => e.path === input.path)) return;

    let snapshotName: string | null = null;
    if (existsSync(input.path)) {
        snapshotName = `file-${manifest.entries.length}.snap`;
        await copyFile(input.path, join(dir, snapshotName));
    }

    const entry: CheckpointEntry = {
        path: input.path,
        snapshotName,
        ts: new Date().toISOString(),
    };
    await writeManifest(input.projectId, input.sessionId, {
        turnIndex: input.turnIndex,
        entries: [...manifest.entries, entry],
    });
};

export interface SessionCheckpoint {
    readonly turnIndex: number;
    readonly entryCount: number;
    readonly ts: string;
}

// Lists turn-level checkpoint summaries for a session, oldest first. Each entry
// represents one turn's worth of file modifications captured at the start of
// the turn. Returns an empty list when the session has no checkpoints yet.
export const listSessionCheckpoints = async (
    projectId: string,
    sessionId: string,
): Promise<readonly SessionCheckpoint[]> => {
    const dir = getSessionCheckpointsDir(projectId, sessionId);
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch (err) {
        if (isNotFoundError(err)) return [];
        throw err;
    }
    const out: SessionCheckpoint[] = [];
    for (const name of entries) {
        const turnIndex = Number.parseInt(name, 10);
        if (!Number.isInteger(turnIndex) || turnIndex < 0) continue;
        const manifest = await loadManifest(projectId, sessionId, turnIndex);
        if (manifest.entries.length === 0) continue;
        const ts = manifest.entries[0]?.ts ?? "";
        out.push({ turnIndex, entryCount: manifest.entries.length, ts });
    }
    out.sort((a, b) => a.turnIndex - b.turnIndex);
    return out;
};

// Restore project files to their pre-turn-N state by walking checkpoints from
// the latest turn back down to turnIndex (inclusive) and reverting each turn's
// captured originals. Files created in turns >= turnIndex are deleted.
export const rewindToTurn = async (
    projectId: string,
    sessionId: string,
    turnIndex: number,
): Promise<{ restored: number }> => {
    const checkpoints = await listSessionCheckpoints(projectId, sessionId);
    let restored = 0;
    for (let i = checkpoints.length - 1; i >= 0; i--) {
        const cp = checkpoints[i];
        if (!cp || cp.turnIndex < turnIndex) break;
        const manifest = await loadManifest(projectId, sessionId, cp.turnIndex);
        for (const entry of manifest.entries) {
            if (entry.snapshotName === null) {
                await rm(entry.path, { force: true });
            } else {
                const snapPath = join(
                    getTurnCheckpointDir(projectId, sessionId, cp.turnIndex),
                    entry.snapshotName,
                );
                if (!existsSync(snapPath)) continue;
                await copyFile(snapPath, entry.path);
            }
            restored += 1;
        }
    }
    return { restored };
};

// Test-only: best-effort cleanup of a session's checkpoint tree.
export const _wipeSessionCheckpoints = async (
    projectId: string,
    sessionId: string,
): Promise<void> => {
    const dir = getSessionCheckpointsDir(projectId, sessionId);
    try {
        await stat(dir);
    } catch {
        return;
    }
    await rm(dir, { recursive: true, force: true });
};
