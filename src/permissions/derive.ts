import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { PermissionRule } from "../config/index.ts";
import { classifyBashCommand } from "./heuristics.ts";
import { expandTilde, splitCommandSegments, subjectOf } from "./match.ts";
import type { ToolCall } from "./types.ts";

// Turns one approved call into the narrowest rule that would have allowed it,
// for the "always allow" prompt response. Everything here is deliberately
// pessimistic: when the call cannot be generalised without granting more than
// the user is looking at, we refuse and the caller falls back to a
// session-only grant.

export type Derivation =
    | { readonly kind: "rule"; readonly rule: PermissionRule; readonly text: string }
    | { readonly kind: "none"; readonly reason: string };

const none = (reason: string): Derivation => ({ kind: "none", reason });

const derived = (tool: string, inner: string): Derivation => {
    const text = `${tool}(${inner})`;
    return { kind: "rule", rule: { effect: "allow", tool, pattern: text }, text };
};

// First token generalisation is only meaningful when that token decides what
// runs. These hand the decision to their argument instead.
const WRAPPERS: ReadonlySet<string> = new Set([
    ".",
    "bash",
    "command",
    "dash",
    "doas",
    "env",
    "eval",
    "exec",
    "fish",
    "nohup",
    "sh",
    "source",
    "su",
    "sudo",
    "time",
    "xargs",
    "zsh",
]);

// Tools whose path argument is already a directory — dirname() would climb one
// level too far and widen the grant.
const DIRECTORY_SUBJECTS: ReadonlySet<string> = new Set(["Glob", "Grep"]);

const SUBSTITUTION = /\$\(|`/;
const PROGRAM_TOKEN = /^[A-Za-z0-9._/-]+$/;
const GLOB_CHARS = /[*?[\]{}]/;
const WIDENING_CHARS = /[*?()\n]/;
const MAX_LITERAL = 200;

const isTooBroad = (dir: string): boolean => {
    const home = homedir();
    if (dir === "/" || dir === home) return true;
    if (home.startsWith(`${dir}/`)) return true;
    return dir.split("/").filter((s) => s.length > 0).length < 2;
};

const fromCommand = (tool: string, command: string): Derivation => {
    if (SUBSTITUTION.test(command)) return none("it contains a shell substitution");
    const segments = splitCommandSegments(command);
    if (segments.length !== 1) return none("it chains more than one command");
    const first = segments[0]!.split(/\s+/)[0] ?? "";
    if (!PROGRAM_TOKEN.test(first)) return none("it does not start with a plain program name");
    if (WRAPPERS.has(basename(first))) return none(`${first} can run anything`);
    if (classifyBashCommand(command).kind === "prompt")
        return none("a safety heuristic flagged it");
    return derived(tool, `${first} *`);
};

const fromPath = (tool: string, raw: string): Derivation => {
    if (GLOB_CHARS.test(raw)) return none("the path contains a wildcard");
    const absolute = resolve(expandTilde(raw));
    const dir = DIRECTORY_SUBJECTS.has(tool) ? absolute : dirname(absolute);
    if (isTooBroad(dir)) return none(`${dir} covers too much`);
    return derived(tool, `${dir}/**`);
};

const fromText = (tool: string, value: string): Derivation => {
    if (value.length === 0) return none("the argument is empty");
    if (value.length > MAX_LITERAL) return none("the argument is too long to pin down");
    if (WIDENING_CHARS.test(value)) return none("the argument contains pattern characters");
    return derived(tool, value);
};

export const deriveAlwaysRule = (toolCall: ToolCall): Derivation => {
    const subject = subjectOf(toolCall);
    if (subject === null) return none("this call has no argument to narrow on");
    if (subject.kind === "command") return fromCommand(toolCall.name, subject.value);
    if (subject.kind === "path") return fromPath(toolCall.name, subject.value);
    return fromText(toolCall.name, subject.value);
};
