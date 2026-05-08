import pkg from "../../package.json" with { type: "json" };

export const CURRENT_VERSION: string = pkg.version;
