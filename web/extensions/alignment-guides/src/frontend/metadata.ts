import { EXTENSION_SDK_ABI_VERSION, type ExtensionFrontendMetadata } from "@woohaa3/contracts";

export const metadata: ExtensionFrontendMetadata = {
  extensionId: "alignment-guides",
  version: "0.1.0",
  label: "辅助对齐线",
  description: "拖动节点时与其它对象做轴对齐吸附，并显示虚线参考线：中心线更淡、边线更实；不需要时在插件面板关闭扩展即可。",
  icon: "canvas",
  activation: "browser-local",
  configScope: "browser-local",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
