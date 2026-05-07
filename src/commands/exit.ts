import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const ExitCommand: SlashCommand = {
  name: "exit",
  aliases: ["quit"],
  description: "Exit Ye cleanly.",
  execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
    ctx.exitApp();
    return { kind: "ok" };
  },
};
