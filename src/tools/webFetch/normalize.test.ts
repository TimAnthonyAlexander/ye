import { describe, expect, it } from "bun:test";
import { normalizeUrl } from "./normalize.ts";

describe("normalizeUrl", () => {
    it("upgrades http to https", () => {
        const r = normalizeUrl("http://example.com/foo");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.url).toBe("https://example.com/foo");
            expect(r.host).toBe("example.com");
        }
    });

    it("strips credentials", () => {
        const r = normalizeUrl("https://user:pass@example.com/x");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.url).not.toContain("user:pass");
    });

    it("rejects empty", () => {
        expect(normalizeUrl("").ok).toBe(false);
    });

    it("rejects oversized URL", () => {
        const huge = "https://example.com/" + "a".repeat(2100);
        expect(normalizeUrl(huge).ok).toBe(false);
    });

    it("rejects file: and javascript: schemes", () => {
        expect(normalizeUrl("file:///etc/passwd").ok).toBe(false);
        expect(normalizeUrl("javascript:alert(1)").ok).toBe(false);
    });

    it("rejects malformed URLs", () => {
        expect(normalizeUrl("not a url").ok).toBe(false);
        expect(normalizeUrl("//no-scheme.com").ok).toBe(false);
    });
});
