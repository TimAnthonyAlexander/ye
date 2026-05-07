import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const INIT_PROMPT = `[Internal /init request — explore the project, then write or update its onboarding notes file (CLAUDE.md or YE.md). The user does not see this message; respond with the actual work, no preamble.]

Steps:

1. Check whether CLAUDE.md or YE.md exists at the project root. If one does, read it.
2. Explore the codebase thoroughly. At minimum: README, package.json (or equivalent build manifest), top-level config files, scripts/, and a representative slice of the source tree. The notes file you produce should reflect what you actually found — not a generic template.
3. Write the notes file:
   - If a notes file already existed, update it in place. Preserve sections the human personalized; refresh stale claims; replace placeholder bullets like "(Add X here.)" with concrete values pulled from the code.
   - If neither file existed, create YE.md.
4. Keep the file short and high-signal. Short bullets, no marketing language. Required sections at minimum: Conventions, Build & test, Notes. Add others only if the project clearly warrants them.

Work without asking clarifying questions — make reasonable judgment calls based on the code.`;

export const InitCommand: SlashCommand = {
    name: "init",
    description: "Explore the project and create or refresh CLAUDE.md / YE.md.",
    execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
        ctx.sendHiddenPrompt(INIT_PROMPT);
        return { kind: "ok" };
    },
};
