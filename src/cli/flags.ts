import { PROVIDER_IDS } from "../providers/index.ts";
import { OUTPUT_FORMATS, type OutputFormat } from "./output.ts";

export interface CliFlags {
    readonly resume: boolean;
    readonly resumeSessionId: string | null;
    readonly continueSession: boolean;
    readonly update: boolean;
    readonly prompt: string | null;
    readonly mode: string | null;
    readonly model: string | null;
    readonly provider: string | null;
    readonly maxBudgetUsd: number | null;
    readonly outputFormat: OutputFormat;
    readonly help: boolean;
    readonly version: boolean;
}

export type ParseFlagsResult =
    | { readonly ok: true; readonly flags: CliFlags }
    | { readonly ok: false; readonly error: string };

export const HELP_TEXT = `Usage: ye [options]
       ye [options] < prompt.txt
       echo "prompt" | ye [options]

Options:
  -p, --prompt <text>             Run one turn headlessly and exit
      --output-format <fmt>       Headless output: text (default), json, stream-json
      --mode <AUTO|NORMAL|PLAN>   Permission mode for the session
      --model <id>                Use this model for this run only (never saved)
      --provider <id>             Use this provider for this run only (never saved)
      --resume [sessionId]        Resume the most recent session, or a specific one
      --continue                  Resume the most recent session without picking
      --max-budget-usd <n>        Stop the session once it has spent this much (USD)
      --update, --upgrade         Download and install the latest release binary
  -h, --help                      Show this help
  -v, --version                   Show version

With no -p/--prompt and stdin piped or redirected, the prompt is read from
stdin (10MB max) and the run is headless. json buffers the run and prints one
object; stream-json prints one JSON object per line as events happen.
`;

export const parseFlags = (argv: readonly string[]): ParseFlagsResult => {
    let resume = false;
    let resumeSessionId: string | null = null;
    let continueSession = false;
    let update = false;
    let prompt: string | null = null;
    let mode: string | null = null;
    let model: string | null = null;
    let provider: string | null = null;
    let maxBudgetUsd: number | null = null;
    let outputFormat: OutputFormat = "text";
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
        } else if (a === "--continue") {
            continueSession = true;
        } else if (a === "--model") {
            const next = argv[i + 1];
            if (!next) {
                return { ok: false, error: "ye: --model requires a value" };
            }
            model = next;
            i += 1;
        } else if (a === "--provider") {
            const next = argv[i + 1];
            if (!next) {
                return {
                    ok: false,
                    error: `ye: --provider requires ${PROVIDER_IDS.join(", ")}`,
                };
            }
            if (!PROVIDER_IDS.includes(next)) {
                return {
                    ok: false,
                    error: `ye: unknown provider "${next}" — must be ${PROVIDER_IDS.join(", ")}`,
                };
            }
            provider = next;
            i += 1;
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
        } else if (a === "--output-format") {
            const next = argv[i + 1];
            if (!next) {
                return {
                    ok: false,
                    error: `ye: --output-format requires ${OUTPUT_FORMATS.join(", ")}`,
                };
            }
            const found = OUTPUT_FORMATS.find((f) => f === next);
            if (found === undefined) {
                return {
                    ok: false,
                    error: `ye: invalid --output-format "${next}" — must be ${OUTPUT_FORMATS.join(", ")}`,
                };
            }
            outputFormat = found;
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
    if (continueSession && resume) {
        return {
            ok: false,
            error: "ye: --continue and --resume are mutually exclusive — pick one",
        };
    }
    return {
        ok: true,
        flags: {
            resume,
            resumeSessionId,
            continueSession,
            update,
            prompt,
            mode,
            model,
            provider,
            maxBudgetUsd,
            outputFormat,
            help,
            version,
        },
    };
};
