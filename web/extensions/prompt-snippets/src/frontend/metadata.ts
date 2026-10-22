/**
 * prompt-snippets extension 纯前端 metadata
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.2 / design D4）。
 *
 * browser-local optional；只导出 JSON 可序列化数据。`index.ts` 的 descriptor 复用本 metadata。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import {
  PROMPT_SNIPPETS_DESCRIPTION,
  PROMPT_SNIPPETS_LABEL,
  PROMPT_SNIPPETS_PLUGIN_ID
} from "../shared.js";

export const PROMPT_SNIPPETS_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: PROMPT_SNIPPETS_PLUGIN_ID,
  version: "0.1.0",
  label: PROMPT_SNIPPETS_LABEL,
  description: PROMPT_SNIPPETS_DESCRIPTION,
  icon: "prompt",
  activation: "browser-local",
  configScope: "browser-local",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
