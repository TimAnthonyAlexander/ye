#!/usr/bin/env bun
import "./patch-stdin.ts";
import { render } from "ink";
import { App } from "./components/app.tsx";
import { HELP_TEXT, parseFlags } from "./cli/flags.ts";
import { errorSummary, writeSummary, type OutputFormat } from "./cli/output.ts";
import { readStdinPrompt } from "./cli/stdin.ts";
import { ConfigValidationError, loadConfig, type LoadResult } from "./config/index.ts";
import { runHeadless } from "./pipeline/headless.ts";
import { resolveBudgetCap } from "./pipeline/stop.ts";
import { refreshUpdateStatus } from "./update/check.ts";
import { cleanupWindowsOldBinary, runSelfUpdate, UpdateError } from "./update/install.ts";
import { CURRENT_VERSION } from "./update/version.ts";

const runUpdateCommand = async (): Promise<void> => {
    try {
        const result = await runSelfUpdate();
        if (!result.changed) {
            process.stdout.write(`ye ${result.from} is already the latest version.\n`);
        } else {
            process.stdout.write(`ye ${result.from} → ${result.to} updated.\n`);
            if (process.platform === "win32") {
                process.stdout.write("Restart your shell to pick up the new binary.\n");
            }
        }
        process.exit(0);
    } catch (err) {
        if (err instanceof UpdateError) {
            process.stderr.write(`update failed: ${err.message}\n`);
            process.exit(1);
        }
        throw err;
    }
};

const startedAt = Date.now();

// Machine formats promise a parseable object on stdout even when the run never
// reaches the pipeline (bad config, unreadable stdin).
const abort = async (
    format: OutputFormat,
    message: string,
    stderrText: string = message,
): Promise<never> => {
    process.stderr.write(`${stderrText}\n`);
    await writeSummary(format, errorSummary(message, { durationMs: Date.now() - startedAt }));
    process.exit(1);
};

const readPipedPrompt = async (format: OutputFormat): Promise<string> => {
    const read = await readStdinPrompt(Bun.stdin.stream());
    if (!read.ok) await abort(format, read.error, `ye: ${read.error}`);
    const text = read.ok ? read.text : "";
    if (text.length === 0) await abort(format, "no prompt on stdin", "ye: no prompt on stdin");
    return text;
};

const main = async (): Promise<void> => {
    const parsed = parseFlags(process.argv.slice(2));
    if (!parsed.ok) {
        process.stderr.write(`${parsed.error}\n`);
        process.exit(1);
    }
    const flags = parsed.flags;
    const format = flags.outputFormat;
    try {
        if (flags.help) {
            process.stdout.write(HELP_TEXT);
            process.exit(0);
        }
        if (flags.version) {
            process.stdout.write(`${CURRENT_VERSION}\n`);
            process.exit(0);
        }
        if (flags.update) {
            await runUpdateCommand();
            return;
        }
        // Read before loading config so a piped run never blocks on a prompt
        // the TUI would have owned.
        const headlessPrompt =
            flags.prompt ?? (process.stdin.isTTY ? null : await readPipedPrompt(format));
        await cleanupWindowsOldBinary();
        const loaded = await loadConfig();
        const budgetCap = resolveBudgetCap(flags.maxBudgetUsd, loaded.config.budget?.maxUsd);
        const config: LoadResult =
            budgetCap === loaded.config.budget?.maxUsd
                ? loaded
                : { ...loaded, config: { ...loaded.config, budget: { maxUsd: budgetCap } } };
        if (headlessPrompt !== null) {
            await runHeadless(config, headlessPrompt, format);
            process.exit(0);
        }
        // Background update check — fire-and-forget; status surfaces in StatusBar.
        void refreshUpdateStatus().catch(() => undefined);
        // App owns Ctrl+C handling: clear input → abort stream → no-op.
        const { waitUntilExit } = render(
            <App
                config={config}
                resumeOnStart={flags.resume}
                resumeSessionId={flags.resumeSessionId}
                modeOnStart={flags.mode}
            />,
            { exitOnCtrlC: false },
        );
        await waitUntilExit();
    } catch (error) {
        if (error instanceof ConfigValidationError) {
            await abort(format, error.message);
        }
        if (format !== "text") {
            const message = error instanceof Error ? error.message : String(error);
            await abort(format, message, `ye: ${message}`);
        }
        throw error;
    }
};

await main();
// Ink's useApp().exit() unmounts the renderer but stdin's raw-mode handle
// can keep the event loop alive — force release back to the parent shell.
process.exit(0);
