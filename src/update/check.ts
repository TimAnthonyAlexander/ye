import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../config/paths.ts";
import { CURRENT_VERSION } from "./version.ts";

const CACHE_FILE = join(CONFIG_DIR, "update-check.json");
const TTL_MS = 24 * 60 * 60 * 1000;
const RELEASES_URL = "https://api.github.com/repos/TimAnthonyAlexander/ye/releases/latest";

interface CacheEntry {
    readonly checkedAt: number;
    readonly latest: string;
}

export interface UpdateStatus {
    readonly current: string;
    readonly latest: string;
    readonly hasUpdate: boolean;
}

const parsePart = (s: string | undefined): number => {
    if (!s) return 0;
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
};

const isNewer = (latest: string, current: string): boolean => {
    const a = latest.split(".");
    const b = current.split(".");
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const x = parsePart(a[i]);
        const y = parsePart(b[i]);
        if (x > y) return true;
        if (x < y) return false;
    }
    return false;
};

const readCache = async (): Promise<CacheEntry | null> => {
    try {
        const raw = await readFile(CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw) as { checkedAt?: unknown; latest?: unknown };
        if (typeof parsed.checkedAt === "number" && typeof parsed.latest === "string") {
            return { checkedAt: parsed.checkedAt, latest: parsed.latest };
        }
        return null;
    } catch {
        return null;
    }
};

const writeCache = async (entry: CacheEntry): Promise<void> => {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(entry), "utf8");
};

const fetchLatest = async (): Promise<string | null> => {
    try {
        const res = await fetch(RELEASES_URL, {
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "ye-cli",
            },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { tag_name?: unknown };
        if (typeof json.tag_name !== "string") return null;
        return json.tag_name.replace(/^v/, "");
    } catch {
        return null;
    }
};

const buildStatus = (latest: string): UpdateStatus => ({
    current: CURRENT_VERSION,
    latest,
    hasUpdate: isNewer(latest, CURRENT_VERSION),
});

export const getCachedUpdateStatus = async (): Promise<UpdateStatus | null> => {
    const cache = await readCache();
    if (!cache) return null;
    return buildStatus(cache.latest);
};

export const refreshUpdateStatus = async (force = false): Promise<UpdateStatus | null> => {
    if (!force) {
        const cache = await readCache();
        if (cache && Date.now() - cache.checkedAt < TTL_MS) {
            return buildStatus(cache.latest);
        }
    }
    const latest = await fetchLatest();
    if (!latest) {
        const cache = await readCache();
        return cache ? buildStatus(cache.latest) : null;
    }
    await writeCache({ checkedAt: Date.now(), latest });
    return buildStatus(latest);
};
