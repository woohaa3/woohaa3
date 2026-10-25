import type { MediaFormatValidator } from "@woohaa3/contracts";
import type { ApplicationBackendHost } from "./contract.js";
import type { OwnerState } from "./host-types.js";
/** A registration is already live during activate, so rollback owns it immediately. */
export function installMediaFormatRegistration(
  host: ApplicationBackendHost,
  owner: Pick<OwnerState, "startedResources">,
  register: ((format: MediaFormatValidator) => () => void) | undefined
): void {
  if (!register) return;
  host.registerMediaFormat = format => {
    const dispose = register(format);
    try {
      const resource = { id: `media-format:${format.contentType}`, stop: dispose };
      host.registerResource(resource);
      owner.startedResources.push(resource);
    } catch (error) { dispose(); throw error; }
  };
}
