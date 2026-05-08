import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import { _wipeSessionCheckpoints } from "../../storage/checkpoints.ts";
import { getTurnCheckpointDir } from "../../storage/paths.ts";
import { ReadTool } from "../read/index.ts";
import type { ToolContext } from "../types.ts";
import { WriteTool } from "./index.ts";

const PROJECT_ID = "write-test-project";
const SESSION_ID = "write-test-session";

const stubProvider: Provider = {
    id: "stub",
    capabilities: { promptCache: false, toolUse: true, vision: false, serverSideWebSearch: false },
    async *stream() {
        // no-op
    },
    async getContextSize() {
        return 100_000;
    },
};

const stubConfig: Config = {
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
};

let workDir: string;

const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    cwd: workDir,
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
    ...overrides,
});

const readInto = async (ctx: ToolContext, path: string): Promise<void> => {
    const r = await ReadTool.execute({ path }, ctx);
    if (!r.ok) throw new Error(`Read failed: ${r.error}`);
};

interface ManifestShape {
    readonly turnIndex: number;
    readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly snapshotName: string | null;
    }>;
}

const loadManifest = async (turnIndex: number): Promise<ManifestShape> => {
    const turnDir = getTurnCheckpointDir(PROJECT_ID, SESSION_ID, turnIndex);
    const raw = await readFile(join(turnDir, "manifest.json"), "utf8");
    return JSON.parse(raw) as ManifestShape;
};

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-write-test-"));
});

afterEach(async () => {
    await _wipeSessionCheckpoints(PROJECT_ID, SESSION_ID);
    await rm(workDir, { recursive: true, force: true });
});

describe("WriteTool", () => {
    test("W1 rejects relative path", async () => {
        const ctx = makeCtx();
        const r = await WriteTool.execute({ path: "rel/path.txt", content: "x" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("path must be absolute");
    });

    test("W2 rejects overwrite without prior Read", async () => {
        const path = join(workDir, "existing.txt");
        await writeFile(path, "old", "utf8");
        const ctx = makeCtx();
        const r = await WriteTool.execute({ path, content: "new" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("Read");
            expect(r.error).toContain("before overwriting it.");
        }
        // Original on disk must be untouched.
        expect(await readFile(path, "utf8")).toBe("old");
    });

    test("W3 rejects overwrite when file changed since Read (hash mismatch)", async () => {
        const path = join(workDir, "drift.txt");
        await writeFile(path, "v0", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        await writeFile(path, "v0-drifted", "utf8");
        const r = await WriteTool.execute({ path, content: "v1" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("has been modified since you last Read it");
    });

    test("W4 new file does NOT require prior Read", async () => {
        const path = join(workDir, "new.txt");
        const ctx = makeCtx();
        const r = await WriteTool.execute({ path, content: "fresh content" }, ctx);
        expect(r.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("fresh content");
    });

    test("W5 new-file checkpoint records null-snapshot marker", async () => {
        const path = join(workDir, "fresh.txt");
        const ctx = makeCtx();
        const r = await WriteTool.execute({ path, content: "xxx" }, ctx);
        expect(r.ok).toBe(true);
        const manifest = await loadManifest(0);
        expect(manifest.entries.length).toBe(1);
        expect(manifest.entries[0]?.path).toBe(path);
        expect(manifest.entries[0]?.snapshotName).toBeNull();
    });

    test("W6 overwrite checkpoint copies the original content", async () => {
        const path = join(workDir, "ow.txt");
        await writeFile(path, "ORIGINAL", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await WriteTool.execute({ path, content: "REPLACED" }, ctx);
        expect(r.ok).toBe(true);
        const manifest = await loadManifest(0);
        expect(manifest.entries.length).toBe(1);
        const snapshotName = manifest.entries[0]?.snapshotName;
        expect(snapshotName).not.toBeNull();
        const snap = await readFile(
            join(getTurnCheckpointDir(PROJECT_ID, SESSION_ID, 0), snapshotName!),
            "utf8",
        );
        expect(snap).toBe("ORIGINAL");
        // And the live file has the new content.
        expect(await readFile(path, "utf8")).toBe("REPLACED");
    });

    test("W7 overwrite refreshes readFiles hash to the new content", async () => {
        const path = join(workDir, "rh.txt");
        await writeFile(path, "v0", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const beforeHash = ctx.turnState.readFiles.get(path)?.hash;
        const r = await WriteTool.execute({ path, content: "v1" }, ctx);
        expect(r.ok).toBe(true);
        const afterHash = ctx.turnState.readFiles.get(path)?.hash;
        expect(afterHash).toBeDefined();
        expect(afterHash).not.toBe(beforeHash);
        // A subsequent Write in the same turn should not error on hash drift.
        const second = await WriteTool.execute({ path, content: "v2" }, ctx);
        expect(second.ok).toBe(true);
    });

    test("W8 checkpointFile is idempotent within a turn (manifest stays one entry)", async () => {
        const path = join(workDir, "idem.txt");
        await writeFile(path, "v0", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);

        const r1 = await WriteTool.execute({ path, content: "v1" }, ctx);
        expect(r1.ok).toBe(true);
        const r2 = await WriteTool.execute({ path, content: "v2" }, ctx);
        expect(r2.ok).toBe(true);

        const manifest = await loadManifest(0);
        expect(manifest.entries.length).toBe(1);
        // Snapshot must still hold the original-original ("v0"), not "v1".
        const snapshotName = manifest.entries[0]?.snapshotName;
        expect(snapshotName).not.toBeNull();
        const snap = await readFile(
            join(getTurnCheckpointDir(PROJECT_ID, SESSION_ID, 0), snapshotName!),
            "utf8",
        );
        expect(snap).toBe("v0");
        expect(existsSync(path)).toBe(true);
        expect(await readFile(path, "utf8")).toBe("v2");
    });
});
