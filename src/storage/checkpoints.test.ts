import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    _wipeSessionCheckpoints,
    checkpointFile,
    listSessionCheckpoints,
    rewindToTurn,
} from "./checkpoints.ts";

let workDir: string;
const projectId = "checkpoint-test";
const sessionId = "session-x";

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-cp-test-"));
});

afterEach(async () => {
    await _wipeSessionCheckpoints(projectId, sessionId);
    await rm(workDir, { recursive: true, force: true });
});

describe("checkpoints", () => {
    test("captures pre-edit content and rewinds restores it", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "v0", "utf8");

        await checkpointFile({ projectId, sessionId, turnIndex: 0, path });
        await writeFile(path, "v1", "utf8");

        const snapshots = await listSessionCheckpoints(projectId, sessionId);
        expect(snapshots.length).toBe(1);
        expect(snapshots[0]?.entryCount).toBe(1);

        const out = await rewindToTurn(projectId, sessionId, 0);
        expect(out.restored).toBe(1);
        const restored = await readFile(path, "utf8");
        expect(restored).toBe("v0");
    });

    test("multiple checkpoints in one turn dedupe by path", async () => {
        const path = join(workDir, "b.txt");
        await writeFile(path, "original", "utf8");

        await checkpointFile({ projectId, sessionId, turnIndex: 0, path });
        await writeFile(path, "edit-1", "utf8");
        await checkpointFile({ projectId, sessionId, turnIndex: 0, path });
        await writeFile(path, "edit-2", "utf8");

        const out = await rewindToTurn(projectId, sessionId, 0);
        // Single restore — dedup keeps the original-original.
        expect(out.restored).toBe(1);
        const restored = await readFile(path, "utf8");
        expect(restored).toBe("original");
    });

    test("rewinding past a Write that created a file deletes it", async () => {
        const path = join(workDir, "created.txt");
        // Pre-checkpoint: file does not exist.
        expect(existsSync(path)).toBe(false);

        await checkpointFile({ projectId, sessionId, turnIndex: 0, path });
        await writeFile(path, "newly-created", "utf8");
        expect(existsSync(path)).toBe(true);

        await rewindToTurn(projectId, sessionId, 0);
        expect(existsSync(path)).toBe(false);
    });

    test("rewinds across multiple turns in reverse order", async () => {
        const path = join(workDir, "multi.txt");
        await writeFile(path, "v0", "utf8");

        await checkpointFile({ projectId, sessionId, turnIndex: 0, path });
        await writeFile(path, "v1", "utf8");

        await checkpointFile({ projectId, sessionId, turnIndex: 1, path });
        await writeFile(path, "v2", "utf8");

        await checkpointFile({ projectId, sessionId, turnIndex: 2, path });
        await writeFile(path, "v3", "utf8");

        // rewindToTurn(N) restores files to the state right before turn N
        // started, undoing turns N..latest. Pre-turn-1 ⇒ v1.
        await rewindToTurn(projectId, sessionId, 1);
        let restored = await readFile(path, "utf8");
        expect(restored).toBe("v1");

        // Going further back to pre-turn-0 ⇒ v0.
        await rewindToTurn(projectId, sessionId, 0);
        restored = await readFile(path, "utf8");
        expect(restored).toBe("v0");
    });

    test("rewindToTurn on empty session is a no-op", async () => {
        const out = await rewindToTurn(projectId, sessionId, 0);
        expect(out.restored).toBe(0);
    });
});
