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

export const validateArgs = <T>(args: unknown, schema: object): ToolResult<T> => {
    const obj = schema as ObjectSchema;
    if (obj.type !== "object") {
        return { ok: false, error: "schema must be type=object" };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { ok: false, error: "args must be an object" };
    }
    const a = args as Record<string, unknown>;

    for (const key of obj.required ?? []) {
        if (!(key in a)) {
            // Naming what did arrive is what lets a model that guessed the wrong
            // key correct itself instead of retrying the same call.
            const got = Object.keys(a);
            const received = got.length > 0 ? ` (received: ${got.join(", ")})` : " (received none)";
            return { ok: false, error: `missing required arg: ${key}${received}` };
        }
    }

    for (const [key, prop] of Object.entries(obj.properties ?? {})) {
        if (!(key in a)) continue;
        if (!checkType(a[key], prop.type)) {
            return { ok: false, error: `arg ${key} must be ${prop.type}` };
        }
        if (prop.enum && !prop.enum.includes(a[key])) {
            return { ok: false, error: `arg ${key} must be one of: ${prop.enum.join(", ")}` };
        }
        if (prop.items && Array.isArray(a[key])) {
            const items = a[key] as readonly unknown[];
            for (let i = 0; i < items.length; i++) {
                const item = validateArgs<unknown>(items[i], prop.items);
                if (!item.ok) return { ok: false, error: `arg ${key}[${i}]: ${item.error}` };
            }
        }
    }

    return { ok: true, value: a as T };
};
