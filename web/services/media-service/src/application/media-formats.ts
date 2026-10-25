import { isAllowedMediaType } from "@woohaa3/contracts";
import type { MediaFormatRegistry, MediaFormatValidator } from "@woohaa3/contracts";
/** Each service owns its registry; uninstalled formats have no write path. */
export function createMediaFormatRegistry(): MediaFormatRegistry {
  const formats = new Map<string, MediaFormatValidator>();
  return {
    get: type => formats.get(type),
    register(format) {
      if (!/^application\/[a-z0-9][a-z0-9.+-]{0,126}$/.test(format.contentType)
        || isAllowedMediaType(format.contentType)
        || !Number.isSafeInteger(format.maxBytes) || format.maxBytes <= 0 || typeof format.validate !== "function") {
        throw new Error("Invalid editable media format");
      }
      if (formats.has(format.contentType)) throw new Error(`Media format already registered: ${format.contentType}`);
      const registered = { ...format };
      formats.set(format.contentType, registered);
      return () => { if (formats.get(format.contentType) === registered) formats.delete(format.contentType); };
    }
  };
}
