import type { ToolResult } from "./types.ts";

// Minimal hand-rolled validator. v1 supports the subset of JSON Schema
// we actually use in our tool definitions: type, required, properties,
// and per-property type. Anything richer (oneOf, enum, etc.) is added
// when a tool needs it.

interface PropertySchema {
    readonly type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
    readonly enum?: readonly unknown[];
    readonly items?: ObjectSchema;
}

interface ObjectSchema {
    readonly type: "object";
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, PropertySchema>>;
}

const checkType = (value: unknown, type: PropertySchema["type"]): boolean => {
    switch (type) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number";
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value);
        case "array":
            return Array.isArray(value);
        case undefined:
            return true;
    }
};

const describe = (value: unknown): string => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
};

const parseJson = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
};

// Enum values differing only in case or separators are the same value: a model
// that read `explore` in the schema and wrote `Explore` meant the one that
// exists.
const enumKey = (value: string): string => value.toLowerCase().replace(/[-_\s]/g, "");

// Repair the shapes models actually produce. The expensive one is a JSON array
// or object arriving as a *string* holding it — seen live on every TodoWrite
// call of a session, four in a row, each rejected. Nothing downstream can tell
// the difference once it is parsed, and refusing it only burns turns.
const coerce = (value: unknown, prop: PropertySchema): unknown => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();

    if (prop.type === "array" || prop.type === "object") {
        const parsed = parseJson(trimmed);
        return parsed !== undefined && checkType(parsed, prop.type) ? parsed : value;
    }
    if (prop.type === "number" || prop.type === "integer") {
        const n = Number(trimmed);
        return trimmed.length > 0 && checkType(n, prop.type) ? n : value;
    }
    if (prop.type === "boolean") {
        if (trimmed.toLowerCase() === "true") return true;
        if (trimmed.toLowerCase() === "false") return false;
        return value;
    }
    if (prop.enum && !prop.enum.includes(value)) {
        const match = prop.enum.find(
            (e) => typeof e === "string" && enumKey(e) === enumKey(trimmed),
        );
        return match ?? value;
    }
    return value;
};

const placeholder = (prop: PropertySchema): unknown => {
    if (prop.enum) return prop.enum.join("|");
    if (prop.type === "array") return [prop.items ? skeleton(prop.items) : "…"];
    if (prop.type === "object") return {};
    return prop.type ?? "…";
};

// A one-line example of the call the schema wants, appended to the errors a
// model is most likely to read after guessing wrong. Required keys only —
// this answers "how do I call this", not "what else can I pass".
const skeleton = (schema: ObjectSchema): Record<string, unknown> => {
    const props = schema.properties ?? {};
    const keys = schema.required?.length ? schema.required : Object.keys(props);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        const prop = props[key];
        if (prop) out[key] = placeholder(prop);
    }
    return out;
};

const expected = (schema: ObjectSchema): string => {
    const shape = skeleton(schema);
    return Object.keys(shape).length > 0 ? `. Expected ${JSON.stringify(shape)}` : "";
};

export const validateArgs = <T>(args: unknown, schema: object): ToolResult<T> => {
    const obj = schema as ObjectSchema;
    if (obj.type !== "object") {
        return { ok: false, error: "schema must be type=object" };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { ok: false, error: "args must be an object" };
    }
    const a = { ...(args as Record<string, unknown>) };

    for (const key of obj.required ?? []) {
        if (!(key in a)) {
            // Naming what did arrive is what lets a model that guessed the wrong
            // key correct itself instead of retrying the same call.
            const got = Object.keys(a);
            const received = got.length > 0 ? ` (received: ${got.join(", ")})` : " (received none)";
            return { ok: false, error: `missing required arg: ${key}${received}${expected(obj)}` };
        }
    }

    for (const [key, prop] of Object.entries(obj.properties ?? {})) {
        if (!(key in a)) continue;
        a[key] = coerce(a[key], prop);
        if (!checkType(a[key], prop.type)) {
            return {
                ok: false,
                error: `arg ${key} must be ${prop.type} (got ${describe(a[key])})${expected(obj)}`,
            };
        }
        if (prop.enum && !prop.enum.includes(a[key])) {
            return { ok: false, error: `arg ${key} must be one of: ${prop.enum.join(", ")}` };
        }
        if (prop.items && Array.isArray(a[key])) {
            const items = a[key] as readonly unknown[];
            const coerced: unknown[] = [];
            for (let i = 0; i < items.length; i++) {
                const item = validateArgs<unknown>(items[i], prop.items);
                if (!item.ok) return { ok: false, error: `arg ${key}[${i}]: ${item.error}` };
                coerced.push(item.value);
            }
            a[key] = coerced;
        }
    }

    return { ok: true, value: a as T };
};
