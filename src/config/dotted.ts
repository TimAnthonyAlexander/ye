export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const segmentsOf = (path: string): readonly string[] => path.split(".");

export const getAt = (obj: Record<string, unknown>, segments: readonly string[]): unknown => {
    let cursor: unknown = obj;
    for (const segment of segments) {
        if (!isRecord(cursor)) return undefined;
        cursor = cursor[segment];
    }
    return cursor;
};

export const hasAt = (obj: Record<string, unknown>, segments: readonly string[]): boolean => {
    let cursor: unknown = obj;
    for (const segment of segments) {
        if (!isRecord(cursor) || !(segment in cursor)) return false;
        cursor = cursor[segment];
    }
    return true;
};

export const setAt = (
    obj: Record<string, unknown>,
    segments: readonly string[],
    value: unknown,
): Record<string, unknown> => {
    const [head, ...rest] = segments;
    if (head === undefined) return obj;
    if (rest.length === 0) return { ...obj, [head]: value };
    const child = obj[head];
    return { ...obj, [head]: setAt(isRecord(child) ? child : {}, rest, value) };
};

// Removes the leaf and any parent object the removal emptied — a config left
// with `"verify": {}` after clearing its last key is noise the user did not ask
// for.
export const deleteAt = (
    obj: Record<string, unknown>,
    segments: readonly string[],
): Record<string, unknown> => {
    const [head, ...rest] = segments;
    if (head === undefined || !(head in obj)) return obj;
    const next = { ...obj };
    if (rest.length === 0) {
        delete next[head];
        return next;
    }
    const child = obj[head];
    if (!isRecord(child)) return obj;
    const pruned = deleteAt(child, rest);
    if (Object.keys(pruned).length === 0) {
        delete next[head];
        return next;
    }
    next[head] = pruned;
    return next;
};
