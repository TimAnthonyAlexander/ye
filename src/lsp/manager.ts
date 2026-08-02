import type { Config, LspServerConfig } from "../config/types.ts";
import { LspClient } from "./client.ts";
import { extensionOf, languageForPath } from "./languages.ts";

export interface LanguageServerTarget {
    // Key under `lsp.servers` that supplied this server.
    readonly configKey: string;
    readonly languageId: string;
    readonly server: LspServerConfig;
}

export type ServerLookup =
    | { readonly ok: true; readonly target: LanguageServerTarget }
    | { readonly ok: false; readonly reason: "disabled" }
    | { readonly ok: false; readonly reason: "unmapped"; readonly extension: string }
    | {
          readonly ok: false;
          readonly reason: "unconfigured";
          readonly languageId: string;
          readonly configKeys: readonly string[];
      };

export const isLspEnabled = (config: Config): boolean =>
    config.lsp?.enabled === true && Object.keys(config.lsp.servers ?? {}).length > 0;

export const configuredTargets = (config: Config): readonly LanguageServerTarget[] =>
    Object.entries(config.lsp?.servers ?? {}).map(([configKey, server]) => ({
        configKey,
        languageId: configKey,
        server,
    }));

export const resolveServerForFile = (config: Config, path: string): ServerLookup => {
    if (!isLspEnabled(config)) return { ok: false, reason: "disabled" };

    const mapping = languageForPath(path);
    if (mapping === undefined)
        return { ok: false, reason: "unmapped", extension: extensionOf(path) };

    const servers = config.lsp?.servers ?? {};
    for (const configKey of mapping.configKeys) {
        const server = servers[configKey];
        if (server !== undefined) {
            return { ok: true, target: { configKey, languageId: mapping.languageId, server } };
        }
    }
    return {
        ok: false,
        reason: "unconfigured",
        languageId: mapping.languageId,
        configKeys: mapping.configKeys,
    };
};

const starting = new Map<string, Promise<LspClient>>();
const live = new Set<LspClient>();
let exitHookInstalled = false;

// Language servers are children of this process; without an exit hook they
// outlive the CLI as orphans holding a whole project's index in memory.
const installExitHook = (): void => {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once("exit", () => {
        for (const client of live) client.kill();
    });
};

const cacheKey = (root: string, configKey: string): string => `${root}\u0000${configKey}`;

export const getClient = async (
    target: LanguageServerTarget,
    root: string,
    requestTimeoutMs?: number,
): Promise<LspClient> => {
    const key = cacheKey(root, target.configKey);

    const existing = starting.get(key);
    if (existing !== undefined) {
        const client = await existing.catch(() => undefined);
        if (client !== undefined && client.alive) return client;
        if (client !== undefined) live.delete(client);
        starting.delete(key);
    }

    const launch = (async () => {
        const client = new LspClient({
            command: target.server.command,
            args: target.server.args ?? [],
            rootPath: root,
            ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        });
        await client.start();
        live.add(client);
        return client;
    })();

    starting.set(key, launch);
    installExitHook();

    try {
        return await launch;
    } catch (error) {
        starting.delete(key);
        throw error;
    }
};

export const disposeClients = async (): Promise<void> => {
    const clients = [...starting.values()];
    starting.clear();
    live.clear();
    await Promise.all(
        clients.map(async (pending) => {
            const client = await pending.catch(() => undefined);
            await client?.dispose();
        }),
    );
};
