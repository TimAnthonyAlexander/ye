import type { OutputSink, PickerPayload } from "../commands/types.ts";
import { DARIO_BASE_URL } from "../providers/dario/index.ts";
import {
    DARIO_PACKAGE,
    type DarioInstallResult,
    installDario,
    isDarioInstalled,
    loginDario,
    probeDario,
    type ProbeResult,
    renderInstallCommand,
    type SpawnedProxy,
    startDarioProxy,
} from "./install.ts";

const PROXY_WAIT_MS = 20_000;
const PROXY_POLL_MS = 500;

export interface DarioSurface {
    pick(payload: PickerPayload): Promise<string | null>;
    addSystemMessage(text: string): void;
    streamOutput(): OutputSink;
    // Hands the terminal over so an OAuth flow can print and read on the real
    // tty; Ink neither paints over it nor steals its keystrokes.
    suspendTty<T>(fn: () => T): T;
}

export interface DarioRuntime {
    isInstalled(): boolean;
    installCommand(): string;
    install(onProgress: (line: string) => void): Promise<DarioInstallResult>;
    probe(baseUrl: string): Promise<ProbeResult>;
    startProxy(): SpawnedProxy;
    login(): { ok: boolean; error?: string };
    sleep(ms: number): Promise<void>;
}

export const defaultRuntime: DarioRuntime = {
    isInstalled: () => isDarioInstalled(),
    installCommand: () => renderInstallCommand(),
    install: (onProgress) => installDario({ onProgress }),
    probe: (baseUrl) => probeDario(baseUrl),
    startProxy: () => startDarioProxy(),
    login: () => loginDario(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface DarioReady {
    readonly ok: boolean;
    // Shown after a successful switch. Advisory: a proxy that is not up yet
    // fails on the first request, it does not make the switch wrong.
    readonly note?: string;
    readonly error?: string;
}

const DISCLOSURE = [
    "dario is an independent, third-party proxy — not an Anthropic product.",
    "Using a Claude subscription from tools other than Claude Code is outside what",
    "Anthropic's own client does, and only Anthropic can say whether that risks",
    "account action.",
].join(" ");

const tail = (output: string, count = 20): readonly string[] => {
    const lines = output.split("\n").filter((line) => line.length > 0);
    return lines.length <= count ? lines : lines.slice(lines.length - count);
};

const confirmInstall = async (surface: DarioSurface, rt: DarioRuntime): Promise<boolean> => {
    const command = rt.installCommand();
    surface.addSystemMessage(
        [
            "Anthropic (Subscription) needs the dario proxy.",
            `  command  ${command}`,
            "  scope    your global npm prefix, not ~/.ye — the `dario` command has to be",
            "           on your PATH for it to be usable outside Ye",
            `  removal  npm uninstall -g ${DARIO_PACKAGE}`,
            "",
            DISCLOSURE,
        ].join("\n"),
    );
    const choice = await surface.pick({
        title: "Install dario now?",
        options: [
            { id: "install", label: "Yes, install it", description: command },
            { id: "cancel", label: "Cancel", description: "nothing is installed" },
        ],
        initialId: "cancel",
    });
    return choice === "install";
};

const runInstall = async (surface: DarioSurface, rt: DarioRuntime): Promise<DarioReady> => {
    const sink = surface.streamOutput();
    let result: DarioInstallResult;
    try {
        result = await rt.install((line) => sink.write(line));
    } finally {
        sink.close();
    }
    if (!result.ok) {
        surface.addSystemMessage(
            [`Install failed: ${result.error ?? "unknown error"}`, ...tail(result.output)].join(
                "\n",
            ),
        );
        return { ok: false, error: result.error ?? "dario install failed" };
    }
    surface.addSystemMessage(`Installed dario at ${result.path}.`);
    return { ok: true };
};

const waitForProxy = async (
    baseUrl: string,
    rt: DarioRuntime,
    budgetMs = PROXY_WAIT_MS,
): Promise<ProbeResult> => {
    let waited = 0;
    let last: ProbeResult = { status: "unreachable" };
    while (waited < budgetMs) {
        last = await rt.probe(baseUrl);
        if (last.status !== "unreachable") return last;
        await rt.sleep(PROXY_POLL_MS);
        waited += PROXY_POLL_MS;
    }
    return last;
};

const offerStart = async (
    baseUrl: string,
    surface: DarioSurface,
    rt: DarioRuntime,
): Promise<ProbeResult> => {
    const choice = await surface.pick({
        title: "The dario proxy is not running. Start it now?",
        options: [
            {
                id: "start",
                label: "Yes, start it in the background",
                description: "`dario proxy` — keeps running after Ye exits",
            },
            { id: "skip", label: "Not now", description: "start it yourself later" },
        ],
        initialId: "start",
    });
    if (choice !== "start") return { status: "unreachable" };

    const spawned = rt.startProxy();
    if (!spawned.ok) {
        surface.addSystemMessage(`Could not start the dario proxy: ${spawned.error}`);
        return { status: "unreachable" };
    }
    surface.addSystemMessage("Starting the dario proxy…");
    return waitForProxy(baseUrl, rt);
};

const offerLogin = async (
    baseUrl: string,
    surface: DarioSurface,
    rt: DarioRuntime,
    detail: string | undefined,
): Promise<ProbeResult> => {
    const choice = await surface.pick({
        title: detail
            ? `The dario proxy is up but cannot serve (${detail}). Log in now?`
            : "The dario proxy is up but has no usable Claude account. Log in now?",
        options: [
            {
                id: "login",
                label: "Yes, log in",
                description: "`dario login` — hands the terminal over, then returns here",
            },
            { id: "skip", label: "Not now", description: "run `dario login` yourself later" },
        ],
        initialId: "login",
    });
    if (choice !== "login") return { status: "degraded", ...(detail ? { detail } : {}) };

    const result = surface.suspendTty(() => rt.login());
    if (!result.ok) {
        surface.addSystemMessage(`dario login failed: ${result.error}`);
        return { status: "degraded", ...(detail ? { detail } : {}) };
    }
    // The proxy picks up new accounts without a restart, but not instantly.
    return waitForProxy(baseUrl, rt, 5_000);
};

// Consent is explicit at every step: nothing is installed, started or
// authenticated without a yes. Only a declined install aborts the switch —
// everything past that is advisory, matching how Ollama treats a dead daemon.
export const ensureDarioReady = async (
    surface: DarioSurface,
    rt: DarioRuntime = defaultRuntime,
    baseUrl: string = DARIO_BASE_URL,
): Promise<DarioReady> => {
    if (!rt.isInstalled()) {
        if (!(await confirmInstall(surface, rt))) {
            return { ok: false, error: "dario is not installed; switch cancelled" };
        }
        const installed = await runInstall(surface, rt);
        if (!installed.ok) return installed;
    }

    let probe = await rt.probe(baseUrl);
    if (probe.status === "unreachable") probe = await offerStart(baseUrl, surface, rt);
    if (probe.status === "degraded") probe = await offerLogin(baseUrl, surface, rt, probe.detail);

    if (probe.status === "running") return { ok: true, note: "dario proxy reachable." };
    if (probe.status === "degraded") {
        return {
            ok: true,
            note: probe.detail
                ? `dario proxy is running but cannot serve (${probe.detail}). Run \`dario login\`.`
                : "dario proxy is running but has no usable account. Run `dario login`.",
        };
    }
    return { ok: true, note: "dario proxy is not running. Start it with `dario proxy`." };
};
