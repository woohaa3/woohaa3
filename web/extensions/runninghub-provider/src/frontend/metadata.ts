/**
 * RunningHub provider extension 纯前端 metadata
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.2 / design D4）。
 *
 * 只导出 JSON 可序列化数据；`index.ts` 的 descriptor 复用本 metadata。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { RUNNINGHUB_PLUGIN_ID } from "../shared/identity.js";

export const RUNNINGHUB_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: RUNNINGHUB_PLUGIN_ID,
  version: "2.2.2",
  label: "RunningHub App 交互",
  description: "RunningHub App 工作流的模型交互面板（随服务端 Provider 实际状态装配）。",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
