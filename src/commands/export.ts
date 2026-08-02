import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Message } from "../providers/index.ts";
import { getProjectDir } from "../storage/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const renderMessage = (msg: Message): string => {
    const body = msg.content ?? "";
    if (msg.role === "tool") {
        return `--- tool result (${msg.tool_call_id ?? "?"}) ---\n${body}`;
    }
    const calls = (msg.tool_calls ?? [])
        .map((tc) => `--- tool call: ${tc.function.name} ---\n${tc.function.arguments}`)
        .join("\n\n");
    const header = `=== ${msg.role} ===`;
    const parts = [header];
    if (body.length > 0) parts.push(body);
    if (calls.length > 0) parts.push(calls);
    return parts.join("\n");
};

export const renderTranscript = (history: readonly Message[]): string =>
    `${history.map(renderMessage).join("\n\n")}\n`;

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

export const ExportCommand: SlashCommand = {
    name: "export",
    description: "Write the conversation transcript to a plain text file.",
    usage: "/export [path]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const history = ctx.getHistory();
        if (history.length === 0) {
            return { kind: "error", message: "Nothing to export — the conversation is empty." };
        }

        const requested = args.trim();
        const dest =
            requested.length > 0
                ? isAbsolute(requested)
                    ? requested
                    : resolve(ctx.cwd, requested)
                : join(getProjectDir(ctx.projectId), "exports", `${ctx.sessionId}-${stamp()}.txt`);

        try {
            await mkdir(dirname(dest), { recursive: true });
            await writeFile(dest, renderTranscript(history), "utf8");
        } catch (e) {
            return {
                kind: "error",
                message: `Export failed: ${e instanceof Error ? e.message : String(e)}`,
            };
        }

        ctx.addSystemMessage(`Exported ${history.length} messages to ${dest}`);
        return { kind: "ok" };
    },
};
