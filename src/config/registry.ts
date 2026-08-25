import { getAt, segmentsOf } from "./dotted.ts";

export type ConfigValue = string | number | boolean;

export type FieldSpec =
    | { readonly kind: "boolean" }
    | { readonly kind: "enum"; readonly options: readonly string[] }
    | {
          readonly kind: "number";
          readonly min: number;
          readonly max: number;
          readonly step: number;
          readonly integer: boolean;
      }
    | { readonly kind: "string" };

export interface ConfigField {
    readonly path: string;
    readonly section: string;
    readonly label: string;
    readonly description: string;
    readonly spec: FieldSpec;
    // Effective value when the key is absent from the config file and nothing
    // was detected. Absent means "unset" is itself a valid state for the field.
    readonly defaultValue?: ConfigValue;
}

export const SECTION_ORDER: readonly string[] = [
    "model",
    "permissions",
    "compact",
    "verify",
    "format",
    "lsp",
    "recovery",
    "webTools",
    "budget",
    "suggestions",
    "maxTurns",
    "gitStatus",
    "hooks",
    "autoDetect",
];

const bool = (): FieldSpec => ({ kind: "boolean" });
const str = (): FieldSpec => ({ kind: "string" });
const options = (...values: readonly string[]): FieldSpec => ({ kind: "enum", options: values });
const int = (min: number, max: number, step: number): FieldSpec => ({
    kind: "number",
    min,
    max,
    step,
    integer: true,
});
const fraction = (): FieldSpec => ({
    kind: "number",
    min: 0.05,
    max: 1,
    step: 0.05,
    integer: false,
});

const MB = 1024 * 1024;

export const CONFIG_FIELDS: readonly ConfigField[] = [
    {
        path: "defaultModel.routing",
        section: "model",
        label: "routing",
        description: "OpenRouter sub-provider routing strategy.",
        spec: options("cheapest", "fastest", "latency", "sticky"),
        defaultValue: "cheapest",
    },
    {
        path: "defaultModel.providerSort",
        section: "model",
        label: "providerSort",
        description: "Advanced OpenRouter sort. Overrides routing when set.",
        spec: options("price", "throughput", "latency"),
    },
    {
        path: "defaultModel.allowFallbacks",
        section: "model",
        label: "allowFallbacks",
        description: "Let OpenRouter serve the model from another sub-provider.",
        spec: bool(),
        defaultValue: true,
    },

    {
        path: "permissions.defaultMode",
        section: "permissions",
        label: "defaultMode",
        description: "Permission mode a new session starts in.",
        spec: options("AUTO", "NORMAL", "PLAN"),
        defaultValue: "NORMAL",
    },
    {
        path: "permissions.heuristicGating",
        section: "permissions",
        label: "heuristicGating",
        description: "Prompt for risky shell commands even under AUTO.",
        spec: bool(),
        defaultValue: true,
    },
    {
        path: "permissions.persistSessionRules",
        section: "permissions",
        label: "persistSessionRules",
        description: "Replay session grants when a session is resumed.",
        spec: bool(),
        defaultValue: true,
    },

    {
        path: "compact.threshold",
        section: "compact",
        label: "threshold",
        description: "Context fraction at which the shaper chain starts.",
        spec: fraction(),
        defaultValue: 0.5,
    },
    {
        path: "compact.defaultMaxTokens",
        section: "compact",
        label: "defaultMaxTokens",
        description: "Reply token budget requested from the model.",
        spec: int(512, 131_072, 1024),
        defaultValue: 16_384,
    },
    {
        path: "compact.minReplyTokens",
        section: "compact",
        label: "minReplyTokens",
        description: "Floor below which budget reduction gives up.",
        spec: int(128, 16_384, 128),
        defaultValue: 1024,
    },
    {
        path: "compact.snipThreshold",
        section: "compact",
        label: "snipThreshold",
        description: "Context fraction at which the snip shaper runs.",
        spec: fraction(),
        defaultValue: 0.35,
    },
    {
        path: "compact.snipFloor",
        section: "compact",
        label: "snipFloor",
        description: "Context fraction snipping stops at.",
        spec: fraction(),
        defaultValue: 0.3,
    },
    {
        path: "compact.snipProtectedTail",
        section: "compact",
        label: "snipProtectedTail",
        description: "Trailing messages the snip shaper never touches.",
        spec: int(1, 64, 1),
        defaultValue: 8,
    },
    {
        path: "compact.snipMaxPerTurn",
        section: "compact",
        label: "snipMaxPerTurn",
        description: "Most tool results snipped in one turn.",
        spec: int(1, 50, 1),
        defaultValue: 10,
    },
    {
        path: "compact.microcompactThreshold",
        section: "compact",
        label: "microcompactThreshold",
        description: "Context fraction at which microcompact runs.",
        spec: fraction(),
        defaultValue: 0.42,
    },
    {
        path: "compact.microcompactHotTail",
        section: "compact",
        label: "microcompactHotTail",
        description: "Trailing messages microcompact never touches.",
        spec: int(1, 64, 1),
        defaultValue: 6,
    },
    {
        path: "compact.microcompactMinBytes",
        section: "compact",
        label: "microcompactMinBytes",
        description: "Smallest tool result worth microcompacting.",
        spec: int(128, 65_536, 128),
        defaultValue: 1024,
    },
    {
        path: "compact.collapseThreshold",
        section: "compact",
        label: "collapseThreshold",
        description: "Context fraction at which context collapse runs.",
        spec: fraction(),
        defaultValue: 0.48,
    },
    {
        path: "compact.collapsePreserveRecent",
        section: "compact",
        label: "collapsePreserveRecent",
        description: "Recent messages context collapse keeps verbatim.",
        spec: int(1, 64, 1),
        defaultValue: 12,
    },

    {
        path: "verify.enabled",
        section: "verify",
        label: "enabled",
        description: "Run the verify loop after a chain that wrote files.",
        spec: bool(),
        defaultValue: false,
    },
    {
        path: "verify.typecheck",
        section: "verify",
        label: "typecheck",
        description: "Typecheck command. First step of the verify loop.",
        spec: str(),
    },
    {
        path: "verify.lint",
        section: "verify",
        label: "lint",
        description: "Lint command. Runs after typecheck passes.",
        spec: str(),
    },
    {
        path: "verify.test",
        section: "verify",
        label: "test",
        description: "Test command. Never detected — set it yourself or it never runs.",
        spec: str(),
    },
    {
        path: "verify.timeoutMs",
        section: "verify",
        label: "timeoutMs",
        description: "Per-step timeout for verify commands.",
        spec: int(5000, 600_000, 5000),
        defaultValue: 120_000,
    },

    {
        path: "format.enabled",
        section: "format",
        label: "enabled",
        description: "Run the configured formatter after every Edit and Write.",
        spec: bool(),
        defaultValue: false,
    },

    {
        path: "lsp.enabled",
        section: "lsp",
        label: "enabled",
        description: "Offer the LSP navigation tools when a server resolves.",
        spec: bool(),
        defaultValue: false,
    },
    {
        path: "lsp.autoInstall",
        section: "lsp",
        label: "autoInstall",
        description: "Allow Ye to offer to install a missing language server.",
        spec: bool(),
        defaultValue: true,
    },

    {
        path: "recovery.maxRetries",
        section: "recovery",
        label: "maxRetries",
        description: "Retries per turn for retryable provider errors.",
        spec: int(0, 10, 1),
        defaultValue: 3,
    },
    {
        path: "recovery.backoffBaseMs",
        section: "recovery",
        label: "backoffBaseMs",
        description: "First retry wait. Doubles up to backoffMaxMs.",
        spec: int(100, 10_000, 100),
        defaultValue: 500,
    },
    {
        path: "recovery.backoffMaxMs",
        section: "recovery",
        label: "backoffMaxMs",
        description: "Ceiling on the retry backoff.",
        spec: int(1000, 120_000, 1000),
        defaultValue: 8000,
    },
    {
        path: "recovery.rateLimitMaxRetries",
        section: "recovery",
        label: "rateLimitMaxRetries",
        description: "Retries for HTTP 429, budgeted separately.",
        spec: int(0, 20, 1),
        defaultValue: 10,
    },
    {
        path: "recovery.rateLimitBackoffBaseMs",
        section: "recovery",
        label: "rateLimitBackoffBaseMs",
        description: "Base wait for rate-limit retries.",
        spec: int(100, 10_000, 100),
        defaultValue: 1000,
    },
    {
        path: "recovery.rateLimitBackoffMaxMs",
        section: "recovery",
        label: "rateLimitBackoffMaxMs",
        description: "Ceiling on the rate-limit backoff.",
        spec: int(1000, 300_000, 1000),
        defaultValue: 60_000,
    },

    {
        path: "webTools.cacheTtlMs",
        section: "webTools",
        label: "cacheTtlMs",
        description: "How long WebFetch reuses a fetched page.",
        spec: int(60_000, 3_600_000, 60_000),
        defaultValue: 900_000,
    },
    {
        path: "webTools.maxFetchBytes",
        section: "webTools",
        label: "maxFetchBytes",
        description: "Largest response WebFetch will download.",
        spec: int(MB, 100 * MB, MB),
        defaultValue: 10 * MB,
    },
    {
        path: "webTools.maxContentChars",
        section: "webTools",
        label: "maxContentChars",
        description: "Characters of page text kept after conversion.",
        spec: int(10_000, 1_000_000, 10_000),
        defaultValue: 100_000,
    },
    {
        path: "webTools.searchFallback",
        section: "webTools",
        label: "searchFallback",
        description: "Engine used when the provider has no server-side search.",
        spec: options("duckduckgo", "off"),
        defaultValue: "duckduckgo",
    },
    {
        path: "webTools.summarizeModel",
        section: "webTools",
        label: "summarizeModel",
        description: "Model that summarises fetched pages. Unset uses cheapModel.",
        spec: str(),
    },

    {
        path: "budget.maxUsd",
        section: "budget",
        label: "maxUsd",
        description: "Session spend cap. Unset means no cap.",
        spec: { kind: "number", min: 0.5, max: 500, step: 0.5, integer: false },
    },

    {
        path: "suggestions.enabled",
        section: "suggestions",
        label: "enabled",
        description: "Predict the next prompt as ghost text in an empty input.",
        spec: bool(),
        defaultValue: false,
    },

    {
        path: "maxTurns.master",
        section: "maxTurns",
        label: "master",
        description: "Turn ceiling for the main chain.",
        spec: int(1, 500, 5),
        defaultValue: 100,
    },
    {
        path: "maxTurns.subagent",
        section: "maxTurns",
        label: "subagent",
        description: "Turn ceiling nothing else can raise for a subagent.",
        spec: int(1, 200, 5),
        defaultValue: 25,
    },

    {
        path: "gitStatus.enabled",
        section: "gitStatus",
        label: "enabled",
        description: "Include git status in the system prompt.",
        spec: bool(),
        defaultValue: true,
    },
    {
        path: "gitStatus.maxLines",
        section: "gitStatus",
        label: "maxLines",
        description: "Lines of git status before it is truncated.",
        spec: int(5, 500, 5),
        defaultValue: 30,
    },

    {
        path: "autoDetect",
        section: "autoDetect",
        label: "enabled",
        description: "Detect verify, format and lsp settings from the project.",
        spec: bool(),
        defaultValue: true,
    },
];

const BY_PATH: ReadonlyMap<string, ConfigField> = new Map(
    CONFIG_FIELDS.map((field) => [field.path, field]),
);

export const fieldByPath = (path: string): ConfigField | undefined => BY_PATH.get(path);

export type RowOrigin = "configured" | "detected" | "default";

export interface HeaderRow {
    readonly kind: "header";
    readonly label: string;
}

export interface FieldRow {
    readonly kind: "field";
    readonly field: ConfigField;
    readonly value: ConfigValue | undefined;
    readonly origin: RowOrigin;
}

// A block this editor deliberately does not own: providers, hooks, rule lists,
// formatter maps, server maps and model pairs are all shapes that a one-line
// widget would misrepresent.
export interface InfoRow {
    readonly kind: "info";
    readonly section: string;
    readonly label: string;
    readonly value: string;
    readonly note: string;
}

export type ConfigRow = HeaderRow | FieldRow | InfoRow;

export const isSelectableRow = (row: ConfigRow): row is FieldRow => row.kind === "field";

const coerce = (raw: unknown, spec: FieldSpec): ConfigValue | undefined => {
    switch (spec.kind) {
        case "boolean":
            return typeof raw === "boolean" ? raw : undefined;
        case "number":
            return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
        case "enum":
            return typeof raw === "string" && spec.options.includes(raw) ? raw : undefined;
        case "string":
            return typeof raw === "string" ? raw : undefined;
    }
};

export const resolveField = (
    field: ConfigField,
    raw: Record<string, unknown>,
    detected: Readonly<Record<string, ConfigValue>>,
): FieldRow => {
    const present = coerce(getAt(raw, segmentsOf(field.path)), field.spec);
    if (present !== undefined)
        return { kind: "field", field, value: present, origin: "configured" };
    const found = detected[field.path];
    if (found !== undefined) return { kind: "field", field, value: found, origin: "detected" };
    return { kind: "field", field, value: field.defaultValue, origin: "default" };
};

export const buildRows = (
    raw: Record<string, unknown>,
    detected: Readonly<Record<string, ConfigValue>>,
    infos: readonly InfoRow[],
): readonly ConfigRow[] => {
    const rows: ConfigRow[] = [];
    for (const section of SECTION_ORDER) {
        const fields = CONFIG_FIELDS.filter((field) => field.section === section);
        const sectionInfos = infos.filter((info) => info.section === section);
        if (fields.length === 0 && sectionInfos.length === 0) continue;
        rows.push({ kind: "header", label: section });
        for (const field of fields) rows.push(resolveField(field, raw, detected));
        rows.push(...sectionInfos);
    }
    return rows;
};

const enumValues = (
    field: ConfigField,
    spec: {
        readonly options: readonly string[];
    },
): readonly (string | undefined)[] =>
    field.defaultValue === undefined ? [undefined, ...spec.options] : spec.options;

const round = (value: number, integer: boolean): number =>
    integer ? Math.round(value) : Number(value.toFixed(6));

// A hand-written value off the step grid snaps onto it in the direction of the
// arrow before it starts stepping, so ← never jumps past the nearest grid point.
const stepFrom = (current: number, step: number, direction: 1 | -1, integer: boolean): number => {
    const grid = round(Math.round(current / step) * step, integer);
    if (direction > 0) return grid > current ? grid : round(grid + step, integer);
    return grid < current ? grid : round(grid - step, integer);
};

// ←/→ on the current line. Strings are unreachable by arrows — they only open
// under Enter.
export const adjust = (
    field: ConfigField,
    current: ConfigValue | undefined,
    direction: 1 | -1,
): ConfigValue | undefined => {
    const spec = field.spec;
    if (spec.kind === "boolean") return !(current === true);
    if (spec.kind === "enum") {
        const values = enumValues(field, spec);
        const index = values.indexOf(typeof current === "string" ? current : undefined);
        if (index < 0) return values[0];
        return values[(index + direction + values.length) % values.length];
    }
    if (spec.kind === "number") {
        if (typeof current !== "number") return direction > 0 ? spec.min : undefined;
        const next = stepFrom(current, spec.step, direction, spec.integer);
        if (next > spec.max) return spec.max;
        if (next < spec.min) return field.defaultValue === undefined ? undefined : spec.min;
        return next;
    }
    return current;
};

export type ParsedInput =
    | { readonly ok: true; readonly value: ConfigValue | undefined }
    | { readonly ok: false; readonly message: string };

export const parseInput = (field: ConfigField, text: string): ParsedInput => {
    const trimmed = text.trim();
    const spec = field.spec;
    if (spec.kind === "string") {
        return { ok: true, value: trimmed.length === 0 ? undefined : trimmed };
    }
    if (spec.kind === "number") {
        if (trimmed.length === 0) {
            return field.defaultValue === undefined
                ? { ok: true, value: undefined }
                : { ok: false, message: `${field.path} needs a number` };
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) {
            return { ok: false, message: `"${trimmed}" is not a number` };
        }
        const clamped = Math.min(spec.max, Math.max(spec.min, parsed));
        return { ok: true, value: spec.integer ? Math.round(clamped) : clamped };
    }
    return { ok: false, message: `${field.path} is not typed in` };
};

export const isTypeable = (field: ConfigField): boolean =>
    field.spec.kind === "string" || field.spec.kind === "number";

export const formatValue = (value: ConfigValue | undefined): string =>
    value === undefined ? "unset" : typeof value === "string" ? value : String(value);
