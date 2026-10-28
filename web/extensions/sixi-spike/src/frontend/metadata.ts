/**
 * 四喜迁移 spike 的纯前端 metadata（browser-local：由当前 origin 的本地偏好决定是否装配）。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { SIXI_SPIKE_DESCRIPTION, SIXI_SPIKE_ID, SIXI_SPIKE_LABEL } from "../shared.js";

export const SIXI_SPIKE_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: SIXI_SPIKE_ID,
  version: "0.1.0",
  label: SIXI_SPIKE_LABEL,
  description: SIXI_SPIKE_DESCRIPTION,
  icon: "prompt",
  activation: "browser-local",
  configScope: "browser-local",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
