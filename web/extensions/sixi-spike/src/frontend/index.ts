/**
 * 四喜迁移 spike 前端入口（扫描约定入口）。`plugin()` 无副作用，宿主按需装配。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { SIXI_SPIKE_FRONTEND_METADATA } from "./metadata.js";
import { sixiSpikeExtension } from "./plugin.js";
import "./style.css";

export const descriptor: ExtensionFrontendDescriptor = {
  ...SIXI_SPIKE_FRONTEND_METADATA,
  plugin: () => sixiSpikeExtension()
};
