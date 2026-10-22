import { EXTENSION_SDK_ABI_VERSION, type ExtensionFrontendMetadata } from "@woohaa3/contracts";

export const metadata: ExtensionFrontendMetadata = {
  extensionId: "dev-performance",
  version: "0.1.0",
  label: "开发性能面板",
  description: "仅开发模式在画布工具栏显示 FPS 与 3D Draw Call 小字，可在浏览器插件设置中关闭。",
  icon: "performance",
  activation: "browser-local",
  configScope: "browser-local",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
