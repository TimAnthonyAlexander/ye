export interface CliFlags {
    readonly resume: boolean;
    readonly resumeSessionId: string | null;
    readonly update: boolean;
    readonly prompt: string | null;
    readonly mode: string | null;
    readonly maxBudgetUsd: number | null;
    readonly help: boolean;
    readonly version: boolean;
}

export type ParseFlagsResult =
    | { readonly ok: true; readonly flags: CliFlags }
    | { readonly ok: false; readonly error: string };

export const HELP_TEXT = `Usage: ye [options]

Options:
  -p, --prompt <text>             Run one turn headlessly and exit
      --mode <AUTO|NORMAL|PLAN>   Permission mode for the session
      --resume [sessionId]        Resume the most recent session, or a specific one
      --max-budget-usd <n>        Stop the session once it has spent this much (USD)
      --update, --upgrade         Download and install the latest release binary
  -h, --help                      Show this help
  -v, --version                   Show version
`;

export const parseFlags = (argv: readonly string[]): ParseFlagsResult => {
    let resume = false;
    let resumeSessionId: string | null = null;
    let update = false;
    let prompt: string | null = null;
    let mode: string | null = null;
    let maxBudgetUsd: number | null = null;
    let help = false;
    let version = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === undefined) continue;
        if (a === "--resume") {
            resume = true;
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                resumeSessionId = next;
                i += 1;
            }
        } else if (a === "--update" || a === "--upgrade") {
            update = true;
        } else if (a === "-p" || a === "--prompt") {
            const next = argv[i + 1];
            if (!next) {
                return { ok: false, error: "ye: -p/--prompt requires a value" };
            }
            prompt = next;
            i += 1;
        } else if (a === "--mode") {
            const next = argv[i + 1];
            if (!next) {
                return { ok: false, error: "ye: --mode requires AUTO, NORMAL, or PLAN" };
            }
            const upper = next.toUpperCase();
            if (upper !== "AUTO" && upper !== "NORMAL" && upper !== "PLAN") {
                return {
                    ok: false,
                    error: `ye: invalid mode "${next}" — must be AUTO, NORMAL, or PLAN`,
                };
            }
            mode = upper;
            i += 1;
        } else if (a === "--max-budget-usd") {
            const next = argv[i + 1];
            if (!next) {
                return { ok: false, error: "ye: --max-budget-usd requires a value" };
            }
            const parsed = Number(next);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return {
                    ok: false,
                    error: `ye: invalid --max-budget-usd "${next}" — must be a positive number`,
                };
            }
            maxBudgetUsd = parsed;
            i += 1;
        } else if (a === "-h" || a === "--help") {
            help = true;
        } else if (a === "-v" || a === "--version") {
            version = true;
        } else if (a.startsWith("-")) {
            return {
                ok: false,
                error: `ye: unknown option "${a}"\nTry "ye --help" for usage.`,
            };
        }
    }
    return {
        ok: true,
        flags: { resume, resumeSessionId, update, prompt, mode, maxBudgetUsd, help, version },
    };
};
