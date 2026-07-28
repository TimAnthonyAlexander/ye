import { $ } from "bun";
import type { Config } from "../config/index.ts";
import type { SessionState } from "./state.ts";

export interface GitStatusInjection {
    readonly content: string;
    readonly hash: string;
}

const GIT_STATUS_UNCHANGED =
    "<system-reminder>git status unchanged since last turn</system-reminder>";

const runGitStatus = async (cwd: string, maxLines: number): Promise<string | null> => {
    try {
        const proc = await $`git -C ${cwd} status --porcelain`.quiet();
        if (proc.exitCode !== 0) return null;
        const text = proc.stdout.toString();
        if (text.trim().length === 0) return "";
        const lines = text.trim().split("\n");
        if (lines.length > maxLines) {
            return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines truncated)`;
        }
        return lines.join("\n");
    } catch {
        return null;
    }
};

export const injectGitStatus = async (
    state: SessionState,
    config: Config,
): Promise<void> => {
    const enabled = config.gitStatus?.enabled ?? true;
    if (!enabled) return;
    const maxLines = config.gitStatus?.maxLines ?? 30;

    const output = await runGitStatus(state.projectRoot, maxLines);
    if (output === null) return;

    if (output.length === 0) {
        state.history.push({
            role: "user",
            content: "<system-reminder>working tree clean (no uncommitted changes)</system-reminder>",
        });
        state.lastGitStatusHash = "";
        return;
    }

    const hash = Bun.hash(output).toString(16);

    if (hash === state.lastGitStatusHash && state.lastGitStatusHash !== undefined) {
        state.history.push({ role: "user", content: GIT_STATUS_UNCHANGED });
        return;
    }

    state.lastGitStatusHash = hash;

    const body = `git status --porcelain (${maxLines} line limit):\n${output}`;
    state.history.push({
        role: "user",
        content: `<system-reminder>\n${body}\n</system-reminder>`,
    });
};
