import { EXTENSION_SDK_ABI_VERSION, type ExtensionFrontendMetadata } from "@woohaa3/contracts";

export const metadata: ExtensionFrontendMetadata = {
  extensionId: "canvas-tidy",
  version: "0.1.0",
  label: "一键整理",
  description: "多选后画布上浮出一个整理按钮：按连线方向从左到右分层排布（左侧输入、右侧输出成一条有层级的流程），顺带消除重叠、把过大的卡片等比缩回标准尺寸，一次可撤销。",
  icon: "canvas",
  activation: "browser-local",
  configScope: "browser-local",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
