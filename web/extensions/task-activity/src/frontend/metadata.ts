/**
 * task-activity extension 纯前端 metadata
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.2 / design D4）。
 *
 * 画布常驻必需能力；只导出 JSON 可序列化数据。`index.ts` 的 descriptor 复用本 metadata。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import {
  TASK_ACTIVITY_DESCRIPTION,
  TASK_ACTIVITY_LABEL,
  TASK_ACTIVITY_PLUGIN_ID
} from "../shared.js";

export const TASK_ACTIVITY_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: TASK_ACTIVITY_PLUGIN_ID,
  version: "0.1.0",
  label: TASK_ACTIVITY_LABEL,
  description: TASK_ACTIVITY_DESCRIPTION,
  icon: "activity",
  activation: "always",
  configScope: "site",
  required: true,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
