#!/usr/bin/env bun
import "./patch-stdin.ts";
import { render } from "ink";
import { App } from "./components/app.tsx";
import { HELP_TEXT, parseFlags } from "./cli/flags.ts";
import { ConfigValidationError, loadConfig } from "./config/index.ts";
import { runHeadless } from "./pipeline/headless.ts";
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

const main = async (): Promise<void> => {
    try {
        const parsed = parseFlags(process.argv.slice(2));
        if (!parsed.ok) {
            process.stderr.write(`${parsed.error}\n`);
            process.exit(1);
        }
        const flags = parsed.flags;
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
        await cleanupWindowsOldBinary();
        const config = await loadConfig();
        if (flags.prompt !== null) {
            await runHeadless(config, flags.prompt);
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
