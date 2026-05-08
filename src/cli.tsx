#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./components/app.tsx";
import { ConfigValidationError, loadConfig } from "./config/index.ts";
import { refreshUpdateStatus } from "./update/check.ts";
import { cleanupWindowsOldBinary, runSelfUpdate, UpdateError } from "./update/install.ts";

interface CliFlags {
    readonly resume: boolean;
    readonly resumeSessionId: string | null;
    readonly update: boolean;
}

const parseFlags = (argv: readonly string[]): CliFlags => {
    let resume = false;
    let resumeSessionId: string | null = null;
    let update = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--resume") {
            resume = true;
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                resumeSessionId = next;
                i += 1;
            }
        } else if (a === "--update" || a === "--upgrade") {
            update = true;
        }
    }
    return { resume, resumeSessionId, update };
};

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

const main = async (): Promise<void> => {
    try {
        const flags = parseFlags(process.argv.slice(2));
        if (flags.update) {
            await runUpdateCommand();
            return;
        }
        await cleanupWindowsOldBinary();
        const config = await loadConfig();
        // Background update check — fire-and-forget; status surfaces in StatusBar.
        void refreshUpdateStatus().catch(() => undefined);
        // App owns Ctrl+C handling: clear input → abort stream → no-op.
        const { waitUntilExit } = render(
            <App
                config={config}
                resumeOnStart={flags.resume}
                resumeSessionId={flags.resumeSessionId}
            />,
            { exitOnCtrlC: false },
        );
        await waitUntilExit();
    } catch (error) {
        if (error instanceof ConfigValidationError) {
            process.stderr.write(`${error.message}\n`);
            process.exit(1);
        }
        throw error;
    }
};

await main();
// Ink's useApp().exit() unmounts the renderer but stdin's raw-mode handle
// can keep the event loop alive — force release back to the parent shell.
process.exit(0);
