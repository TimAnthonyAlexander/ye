import { chmod, rename, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { refreshUpdateStatus } from "./check.ts";
import { getBinaryAsset } from "./platform.ts";
import { CURRENT_VERSION } from "./version.ts";

export class UpdateError extends Error {}

const isCompiledBinary = (): boolean => {
    const name = basename(process.execPath).toLowerCase();
    return name !== "bun" && name !== "bun.exe";
};

const downloadToFile = async (url: string, dest: string): Promise<void> => {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
        throw new UpdateError(`download failed: ${res.status} ${res.statusText}`);
    }
    if (!res.body) {
        throw new UpdateError("download returned empty body");
    }
    await Bun.write(dest, res);
};

export interface UpdateResult {
    readonly from: string;
    readonly to: string;
    readonly changed: boolean;
}

export const runSelfUpdate = async (): Promise<UpdateResult> => {
    if (!isCompiledBinary()) {
        throw new UpdateError("ye is running from source. Use `git pull` to update the checkout.");
    }
    const asset = getBinaryAsset();
    if (!asset) {
        throw new UpdateError(
            `unsupported platform: ${process.platform}/${process.arch}. No prebuilt binary available — see https://github.com/TimAnthonyAlexander/ye/releases.`,
        );
    }
    const status = await refreshUpdateStatus(true);
    if (!status) {
        throw new UpdateError(
            "could not check for updates (network error or rate limit). Try again later.",
        );
    }
    if (!status.hasUpdate) {
        return { from: status.current, to: status.latest, changed: false };
    }

    const url = `https://github.com/TimAnthonyAlexander/ye/releases/latest/download/${asset.assetName}`;
    const target = process.execPath;
    const newPath = `${target}.new`;

    try {
        await downloadToFile(url, newPath);
    } catch (err) {
        try {
            await unlink(newPath);
        } catch {
            /* ignore */
        }
        if (err instanceof UpdateError) throw err;
        throw new UpdateError(`download failed: ${(err as Error).message}`);
    }

    if (asset.platform !== "win32") {
        try {
            await chmod(newPath, 0o755);
            await rename(newPath, target);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            try {
                await unlink(newPath);
            } catch {
                /* ignore */
            }
            if (code === "EACCES" || code === "EPERM") {
                throw new UpdateError(
                    `permission denied writing to ${target}. Try: sudo ye --update`,
                );
            }
            throw new UpdateError(`replace failed: ${(err as Error).message}`);
        }
    } else {
        const oldPath = `${target}.old`;
        try {
            await unlink(oldPath);
        } catch {
            /* ignore */
        }
        try {
            await rename(target, oldPath);
            await rename(newPath, target);
        } catch (err) {
            throw new UpdateError(`replace failed: ${(err as Error).message}`);
        }
    }

    return { from: CURRENT_VERSION, to: status.latest, changed: true };
};

export const cleanupWindowsOldBinary = async (): Promise<void> => {
    if (process.platform !== "win32") return;
    if (!isCompiledBinary()) return;
    const oldPath = `${process.execPath}.old`;
    try {
        await unlink(oldPath);
    } catch {
        /* ignore — first run after install, or already removed */
    }
};
