/** 从可信扩展读取片场转换能力；提供方决定个人凭据 owner。 */
import type { ApplicationExtensionHost } from "@woohaa3/application-service";
import { isFilmSetConversionCapabilityId, isFilmSetConversionProviderShape, type FilmSetConversionProvider } from "@woohaa3/contracts";

export function createFilmSetConversionBridge(resolveHost: () => ApplicationExtensionHost) {
  const providers = (): readonly FilmSetConversionProvider[] => {
    const host = resolveHost();
    const found: FilmSetConversionProvider[] = [];
    const seen = new Set<string>();
    for (const registration of host.snapshot()) {
      for (const id of registration.capabilities) {
        if (!isFilmSetConversionCapabilityId(id) || seen.has(id)) continue;
        seen.add(id);
        const value = host.resolveCapability(id);
        if (isFilmSetConversionProviderShape(value)) found.push(value);
      }
    }
    return found;
  };
  return {
    providers,
    resolveOwner(input: { subject?: string; cookie?: string }) {
      for (const provider of providers()) {
        const owner = provider.resolveOwner?.(input);
        if (owner) return owner;
      }
      return null;
    }
  };
}
