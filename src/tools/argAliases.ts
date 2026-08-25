// Claude models call these tools with Claude Code's parameter names whatever
// schema they are handed, and repeat the wrong name after an error that spells
// out the right one — Read was called with `file_path` four times in one turn.
// Where our name differs from Claude Code's, theirs is folded onto ours before
// the permission gate or the tool reads the args. Tools whose names already
// agree (Bash, Glob, WebFetch, WebSearch, TaskOutput, KillAgent) are absent; an
// extra key Claude Code has and we don't is dropped by validateArgs.
const ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    Read: { file_path: "path" },
    Edit: { file_path: "path" },
    Write: { file_path: "path" },
    Grep: { "-i": "case_insensitive" },
    Task: { subagent_type: "kind" },
    Skill: { skill: "command" },
    BashOutput: { shell_id: "bash_id", task_id: "bash_id" },
    KillShell: { shell_id: "bash_id", task_id: "bash_id" },
};

export const applyArgAliases = <T extends { readonly name: string; readonly args: unknown }>(
    call: T,
): T => {
    const table = ALIASES[call.name];
    if (table === undefined) return call;
    const args = call.args;
    if (typeof args !== "object" || args === null) return call;

    let next: Record<string, unknown> | undefined;
    for (const [alias, canonical] of Object.entries(table)) {
        const current = next ?? (args as Record<string, unknown>);
        if (!(alias in current) || canonical in current) continue;
        next = { ...current };
        next[canonical] = next[alias];
        delete next[alias];
    }
    return next === undefined ? call : { ...call, args: next };
};
