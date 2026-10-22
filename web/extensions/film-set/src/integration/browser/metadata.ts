/**
 * film-set extension 纯前端 metadata
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.2 / design D4）。
 *
 * 只导出 JSON 可序列化数据；identity 复用 `../shared.js` 的稳定常量。
 * `index.ts` 的 descriptor 复用本 metadata。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { FILM_SET_EXTENSION_ID, FILM_SET_LABEL } from "../../state/shared/identity.js";

export const FILM_SET_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: FILM_SET_EXTENSION_ID,
  version: "0.1.0",
  label: FILM_SET_LABEL,
  description: "片场：管理素材对象、动画片段、镜头与影片导出。",
  icon: "film",
  activation: "always",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
