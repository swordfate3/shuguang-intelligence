import { TavilySearch } from "./tavily.ts";
import type { SearchPort } from "./port.ts";
import { parseSearchConfig, type SearchFileConfig } from "../../runtime/search-config.ts";

export type SearchProviderFactory = (config: SearchFileConfig, apiKey: string) => SearchPort;
/** Trusted code registry, not dynamic import, plugin code or model-selected endpoint. */
export const SEARCH_PROVIDERS: Readonly<Record<string, SearchProviderFactory>> = Object.freeze({
  tavily: (config: SearchFileConfig, apiKey: string) => new TavilySearch({ apiKey, timeoutMs: config.timeoutMs }),
});
export function createSearchProvider(
  config: SearchFileConfig, authorizedProvider: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  factories: Readonly<Record<string, SearchProviderFactory>> = SEARCH_PROVIDERS,
): SearchPort {
  config = parseSearchConfig(config);
  if (config.provider !== authorizedProvider || !Object.hasOwn(factories, config.provider)) {
    throw new Error("Search provider is unsupported or differs from the explicit task authorization");
  }
  // Read only this independent, explicitly selected variable, after provider/authorization checks.
  const key = environment[config.credentialEnv];
  if (!key) throw new Error("Independent search credential unavailable");
  return factories[config.provider]!(config, key);
}
