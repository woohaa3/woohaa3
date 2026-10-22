import { EXTENSION_SDK_ABI_VERSION, type ExtensionFrontendMetadata } from "@woohaa3/contracts";
export const CREATURE_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: "creature-video-assets", version: "0.1.0", label: "生物资产制作", description: "画布内八步制作与逐步验收。", icon: "game", activation: "server-active", configScope: "site", required: false, sdkAbi: EXTENSION_SDK_ABI_VERSION
};
