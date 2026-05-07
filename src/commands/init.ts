import { basename } from "node:path";
import { getProjectNotesFile } from "../memory/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const buildTemplate = (projectName: string): string =>
  `# ${projectName}

Project notes that the agent reads on every session. Keep it short and current.

## Conventions

- (Add coding conventions here.)

## Build & test

- (Build / install / run commands.)
- (Test commands.)

## Notes

- (Anything else worth remembering.)
`;

export const InitCommand: SlashCommand = {
  name: "init",
  description: "Bootstrap a CLAUDE.md or YE.md template if neither exists yet.",
  execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
    const notes = getProjectNotesFile(ctx.projectRoot);
    if (notes.existed) {
      ctx.addSystemMessage(`Project notes already exist at ${notes.path}. Edit that file directly.`);
      return { kind: "ok" };
    }
    const projectName = basename(ctx.projectRoot);
    await Bun.write(notes.path, buildTemplate(projectName));
    ctx.addSystemMessage(`Wrote ${notes.path}. Edit it to capture project conventions.`);
    return { kind: "ok" };
  },
};
