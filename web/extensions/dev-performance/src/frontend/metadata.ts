import { EXTENSION_SDK_ABI_VERSION, type ExtensionFrontendMetadata } from "@woohaa3/contracts";

export const metadata: ExtensionFrontendMetadata = {
  extensionId: "dev-performance",
  version: "0.1.0",
  label: "性能读数",
  description: "画布工具栏显示 FPS 与 3D Draw Call 小字；桌面分发版常驻，浏览器仅开发构建启用，可在插件设置中关闭。",
  icon: "performance",
  activation: "browser-local",
  configScope: "browser-local",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
