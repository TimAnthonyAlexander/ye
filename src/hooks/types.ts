export type HookEventName =
    | "PreToolUse"
    | "PostToolUse"
    | "UserPromptSubmit"
    | "Stop"
    | "SubagentStop"
    | "PreCompact"
    | "SessionStart";

export interface HookEntry {
    readonly type: "command";
    readonly command: string;
    readonly timeout?: number; // seconds, default 60
}

export interface MatcherGroup {
    readonly matcher?: string; // regex, only for tool events
    readonly hooks: readonly HookEntry[];
}

export interface HooksConfig {
    readonly PreToolUse?: readonly MatcherGroup[];
    readonly PostToolUse?: readonly MatcherGroup[];
    readonly UserPromptSubmit?: readonly MatcherGroup[];
    readonly Stop?: readonly MatcherGroup[];
    readonly SubagentStop?: readonly MatcherGroup[];
    readonly PreCompact?: readonly MatcherGroup[];
    readonly SessionStart?: readonly MatcherGroup[];
}

export interface HookEventPayload {
    readonly event: HookEventName;
    readonly tool_name?: string;
    readonly tool_args?: unknown;
    readonly file_paths?: readonly string[];
    readonly prompt?: string;
    readonly project_dir: string;
}

export interface HookResult {
    readonly action: "continue" | "block";
    readonly stdout: string;
    readonly stderr: string;
}

export const blockExitCode = (code: number): boolean => code === 2;
