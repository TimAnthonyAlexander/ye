import { describe, expect, it } from "bun:test";
import { checkDomain } from "./domainGate.ts";

describe("checkDomain", () => {
    it("allows by default", () => {
        expect(checkDomain({ host: "example.com" }).ok).toBe(true);
    });

    it("blocks built-in entries", () => {
        expect(checkDomain({ host: "phishtank.com" }).ok).toBe(false);
        expect(checkDomain({ host: "sub.phishtank.com" }).ok).toBe(false);
    });

    it("user allow lifts a built-in block", () => {
        const r = checkDomain({
            host: "phishtank.com",
            config: { allowedDomains: ["phishtank.com"] },
        });
        expect(r.ok).toBe(true);
    });

    it("user block wins over absent allow-list", () => {
        const r = checkDomain({
            host: "evil.example.com",
            config: { blockedDomains: ["evil.example.com"] },
        });
        expect(r.ok).toBe(false);
    });

    it("allow-list restricts to listed hosts", () => {
        const r1 = checkDomain({
            host: "github.com",
            config: { allowedDomains: ["github.com"] },
        });
        expect(r1.ok).toBe(true);
        const r2 = checkDomain({
            host: "google.com",
            config: { allowedDomains: ["github.com"] },
        });
        expect(r2.ok).toBe(false);
    });

    it("subdomain matching", () => {
        const r = checkDomain({
            host: "api.github.com",
            config: { blockedDomains: ["github.com"] },
        });
        expect(r.ok).toBe(false);
    });

    it("per-call block layered on top of config", () => {
        const r = checkDomain({
            host: "example.com",
            blockList: ["example.com"],
        });
        expect(r.ok).toBe(false);
    });
});
