export interface BinaryAsset {
    readonly assetName: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
}

export const getBinaryAsset = (): BinaryAsset | null => {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === "darwin" && arch === "arm64") {
        return { assetName: "ye-macos", platform, arch };
    }
    if (platform === "linux" && arch === "x64") {
        return { assetName: "ye-linux", platform, arch };
    }
    if (platform === "win32" && arch === "x64") {
        return { assetName: "ye-windows.exe", platform, arch };
    }
    return null;
};
