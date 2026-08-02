import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ToolCall } from "./types.ts";

// Pattern syntax:
//   "Tool"                -> blanket rule, matches every call to that tool
//   "Tool(<pattern>)"     -> matches <pattern> against the tool's *subject* argument
//
// Subject selection is an explicit per-tool map (SUBJECTS). Tools outside the
// map fall back to the first string-valued argument in Object.values() order —
// the v1 behaviour, kept so existing configs keep their meaning.
//
// Matching per subject kind:
//   path    -> glob (`**`, `*`, `?`) after `~` expansion and absolute-path
//              normalisation of both sides; literal patterns compare exactly
//   command -> `*`/`?` wildcards, evaluated per chained segment (see matchesPattern)
//   text    -> `*`/`?` wildcards over the whole value
//
// Legacy escape hatch: a pattern ending in `:*` keeps v1 prefix semantics
// (`Bash(rm:*)` matches any command starting with `rm`), because under glob
// rules that string would otherwise become an exact match and silently stop
// matching what the user's existing config matched.

export interface ParsedPattern {
    readonly tool: string;
    readonly inner: string | null;
}

export const parsePattern = (raw: string): ParsedPattern => {
    const open = raw.indexOf("(");
    if (open === -1) return { tool: raw, inner: null };
    const close = raw.lastIndexOf(")");
    if (close === -1 || close < open) return { tool: raw, inner: null };
    return { tool: raw.slice(0, open), inner: raw.slice(open + 1, close) };
};

type SubjectKind = "path" | "command" | "text";

interface SubjectSpec {
    readonly arg: string;
    readonly kind: SubjectKind;
    // Glob/Grep search the cwd when `path` is omitted, so the cwd *is* the
    // subject of such a call — without this, a patterned rule could never
    // match the most common form of the call.
    readonly cwdWhenAbsent?: boolean;
}

const SUBJECTS: Readonly<Record<string, SubjectSpec>> = {
    Read: { arg: "path", kind: "path" },
    Edit: { arg: "path", kind: "path" },
    Write: { arg: "path", kind: "path" },
    Glob: { arg: "path", kind: "path", cwdWhenAbsent: true },
    Grep: { arg: "path", kind: "path", cwdWhenAbsent: true },
    Bash: { arg: "command", kind: "command" },
    WebFetch: { arg: "url", kind: "text" },
    WebSearch: { arg: "query", kind: "text" },
    Skill: { arg: "command", kind: "text" },
    Task: { arg: "kind", kind: "text" },
};

export interface Subject {
    readonly value: string;
    readonly kind: SubjectKind;
}

const namedStringArg = (args: unknown, name: string): string | null => {
    if (typeof args !== "object" || args === null) return null;
    const value = (args as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
};

const firstStringArg = (args: unknown): string | null => {
    if (args === null || args === undefined) return null;
    if (typeof args === "string") return args;
    if (typeof args === "object") {
        for (const value of Object.values(args)) {
            if (typeof value === "string") return value;
        }
    }
    return null;
};

export const subjectOf = (toolCall: ToolCall): Subject | null => {
    const spec = SUBJECTS[toolCall.name];
    if (spec === undefined) {
        const fallback = firstStringArg(toolCall.args);
        return fallback === null ? null : { value: fallback, kind: "text" };
    }
    const named = namedStringArg(toolCall.args, spec.arg);
    if (named !== null) return { value: named, kind: spec.kind };
    return spec.cwdWhenAbsent === true ? { value: process.cwd(), kind: spec.kind } : null;
};

const expandTilde = (p: string): string => {
    if (p === "~") return homedir();
    if (p.startsWith("~/")) return join(homedir(), p.slice(2));
    return p;
};

const toAbsolute = (p: string): string => {
    const expanded = expandTilde(p);
    return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
};

const GLOB_CHARS = /[*?[\]{}]/;

export const matchPath = (pattern: string, subject: string): boolean => {
    const p = toAbsolute(pattern);
    const s = toAbsolute(subject);
    return GLOB_CHARS.test(p) ? new Bun.Glob(p).match(s) : p === s;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const matchWildcard = (pattern: string, subject: string): boolean =>
    new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`).test(
        subject,
    );

// Quote-aware split on shell chaining operators. Quoted separators stay inside
// their segment so `echo "a && b"` is one command, matching how
// heuristics.ts treats quoted text as data rather than code.
export const splitCommandSegments = (command: string): readonly string[] => {
    const segments: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i]!;
        if (quote !== null) {
            if (ch === "\\" && quote === '"') {
                current += ch + (command[i + 1] ?? "");
                i++;
                continue;
            }
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") {
            if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
                i++;
            }
            segments.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    segments.push(current);
    return segments.map((s) => s.trim()).filter((s) => s.length > 0);
};

// `$(...)` / backticks run a second command the pattern never saw, so a segment
// carrying one can never be vouched for by a pattern that doesn't mention it.
const SUBSTITUTION = /\$\(|`/;

export const matchesPattern = (
    inner: string,
    toolCall: ToolCall,
    effect: "allow" | "deny",
): boolean => {
    const subject = subjectOf(toolCall);
    if (subject === null) return false;

    const legacyPrefix = inner.endsWith(":*") ? inner.slice(0, -2) : null;
    const test =
        legacyPrefix !== null
            ? (value: string) => value.startsWith(legacyPrefix)
            : subject.kind === "path"
              ? (value: string) => matchPath(inner, value)
              : (value: string) => matchWildcard(inner, value);

    if (subject.kind !== "command") return test(subject.value);

    const segments = splitCommandSegments(subject.value);
    if (segments.length === 0) return false;

    // Asymmetric on purpose. An allow must hold for EVERY chained segment,
    // otherwise `Bash(git status)` would green-light `git status && rm -rf /`
    // on the strength of the harmless half. A deny fires on ANY segment, so
    // burying a denied command in a chain cannot launder it.
    if (effect === "deny") return segments.some(test);
    if (!SUBSTITUTION.test(inner) && segments.some((s) => SUBSTITUTION.test(s))) return false;
    return segments.every(test);
};
