import type { Config } from "../../config/index.ts";
import { createAnthropicProvider } from "../anthropic/index.ts";
import { resolveApiKey } from "../apiKey.ts";
import type { Provider } from "../types.ts";
import { DARIO_CONTEXT_SIZES } from "./models.ts";

export const DARIO_PROVIDER_ID = "dario";
export const DARIO_BASE_URL = "http://localhost:3456";

// dario ignores the client key unless the operator set DARIO_API_KEY on the
// proxy, but the header has to carry something — its own docs use "dario".
const PLACEHOLDER_KEY = "dario";

// Keyless like Ollama: the credential is the subscriber's OAuth token, held by
// the proxy. There is no MissingKeyError to throw and nothing to prompt for.
export const buildDarioFromConfig = (config: Config): Provider => {
    const provCfg = config.providers[DARIO_PROVIDER_ID];
    if (!provCfg) {
        throw new Error("dario provider missing from config.providers");
    }
    return createAnthropicProvider({
        apiKey: resolveApiKey(provCfg) ?? PLACEHOLDER_KEY,
        baseUrl: provCfg.baseUrl,
        id: DARIO_PROVIDER_ID,
        contextSizes: DARIO_CONTEXT_SIZES,
        capabilities: {
            promptCache: true,
            toolUse: true,
            vision: true,
            // The OAuth path has no web_search server tool, so WebSearch falls
            // through to Ye's own Brave/DuckDuckGo engines.
            serverSideWebSearch: false,
        },
    });
};
