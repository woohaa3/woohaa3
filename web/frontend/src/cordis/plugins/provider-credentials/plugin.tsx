/** Legacy entry forwards to the single AI assistant; it owns no credential UI or store. */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";

export const PROVIDER_CREDENTIALS_PLUGIN_ID = "provider-credentials";
export { PROVIDER_CREDENTIALS_DIALOG_ID } from "./dialogs.js";

export function providerCredentialsExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const open = () => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: {} });
      const host = globalThis as unknown as { __openProviderCredentials?: unknown };
      host.__openProviderCredentials = open;
      ctx.effect(() => () => {
        if (host.__openProviderCredentials === open) delete host.__openProviderCredentials;
      }, "provider-credentials-compatibility");
    },
    { name: PROVIDER_CREDENTIALS_PLUGIN_ID, inject: ["canvasNavigation"] }
  );
}
