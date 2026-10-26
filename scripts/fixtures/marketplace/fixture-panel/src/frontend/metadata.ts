/**
 * 纯前端 fixture 的 metadata：只用 type-only 导入，构建时不需要解析 contracts 运行时。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";

export const metadata: ExtensionFrontendMetadata = {
  extensionId: "fixture-panel",
  version: "1.0.0",
  label: "市场测试面板",
  description: "扩展市场测试 fixture：纯前端站点扩展。",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: 1
};
