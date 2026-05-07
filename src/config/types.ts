export type ProviderId = "openrouter" | (string & {});

export type OpenRouterProviderSlug =
  | "DeepSeek"
  | "GMICloud"
  | "AtlasCloud"
  | "Venice"
  | "SiliconFlow"
  | "Parasail";

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
}

export interface ModelSetting {
  readonly provider: ProviderId;
  readonly model: string;
  readonly providerOrder?: readonly string[];
  readonly allowFallbacks?: boolean;
}

export interface Config {
  readonly defaultProvider: ProviderId;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly defaultModel: ModelSetting;
}
