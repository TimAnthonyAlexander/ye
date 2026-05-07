interface Entry {
    readonly content: string;
    readonly expiresAt: number;
}

// Module-level cache. Lives for the process lifetime — no on-disk persistence.
// Matches Claude Code's 15-min default; the TTL is config-driven so tests and
// power users can override it.
const cache = new Map<string, Entry>();

export const cacheGet = (url: string, now: number = Date.now()): string | null => {
    const entry = cache.get(url);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
        cache.delete(url);
        return null;
    }
    return entry.content;
};

export const cacheSet = (url: string, content: string, ttlMs: number): void => {
    cache.set(url, { content, expiresAt: Date.now() + ttlMs });
};

export const cacheClear = (): void => {
    cache.clear();
};

export const __cacheSize = (): number => cache.size;
