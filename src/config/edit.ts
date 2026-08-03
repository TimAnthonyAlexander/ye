import { deleteAt, getAt, isRecord, segmentsOf, setAt } from "./dotted.ts";
import { writeAtomic } from "./loader.ts";
import { CONFIG_FILE } from "./paths.ts";
import { fieldByPath, type ConfigValue, type FieldRow } from "./registry.ts";

export interface ConfigEdit {
    readonly path: string;
    // `undefined` removes the key.
    readonly value: ConfigValue | undefined;
}

// A key that already exists keeps existing even when the user lands back on the
// default; a key that does not exist is never written just to restate a default.
export const editFor = (row: FieldRow, next: ConfigValue | undefined): ConfigEdit => {
    if (next === undefined) return { path: row.field.path, value: undefined };
    if (next === row.field.defaultValue && row.origin !== "configured") {
        return { path: row.field.path, value: undefined };
    }
    return { path: row.field.path, value: next };
};

export const applyEdits = (
    root: Record<string, unknown>,
    edits: readonly ConfigEdit[],
): Record<string, unknown> => {
    let out = root;
    for (const edit of edits) {
        const segments = segmentsOf(edit.path);
        out = edit.value === undefined ? deleteAt(out, segments) : setAt(out, segments, edit.value);
    }
    return out;
};

// validate.ts rejects a block that exists without its required keys, so writing
// one optional leaf into a block the file did not have has to carry them along.
const REQUIRED: readonly (readonly [string, readonly string[]])[] = [
    ["compact", ["compact.threshold"]],
    ["maxTurns", ["maxTurns.master", "maxTurns.subagent"]],
    ["permissions", ["permissions.defaultMode"]],
];

export const ensureInvariants = (root: Record<string, unknown>): Record<string, unknown> => {
    let out = root;
    for (const [block, paths] of REQUIRED) {
        if (!isRecord(out[block])) continue;
        for (const path of paths) {
            const segments = segmentsOf(path);
            if (getAt(out, segments) !== undefined) continue;
            const fallback = fieldByPath(path)?.defaultValue;
            if (fallback === undefined) continue;
            out = setAt(out, segments, fallback);
        }
    }
    const permissions = out["permissions"];
    if (isRecord(permissions) && !Array.isArray(permissions["rules"])) {
        out = setAt(out, ["permissions", "rules"], []);
    }
    return out;
};

export const readRawConfig = async (
    path: string = CONFIG_FILE,
): Promise<Record<string, unknown>> => {
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    const raw: unknown = await file.json();
    return isRecord(raw) ? raw : {};
};

// Re-reads the file rather than serialising the in-memory Config: validate.ts
// drops top-level keys it does not model, and round-tripping through it would
// silently delete anything the user hand-wrote.
export const applyConfigEdits = async (
    edits: readonly ConfigEdit[],
    path: string = CONFIG_FILE,
): Promise<void> => {
    const root = await readRawConfig(path);
    const next = ensureInvariants(applyEdits(root, edits));
    await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
};
