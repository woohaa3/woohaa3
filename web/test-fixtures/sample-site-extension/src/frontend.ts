/**
 * 样例插件前端入口
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.3 / design D2；
 *  change: 2026-10-10-unify-extension-frontend-entry，任务 2.1：升级为完整 Cordis plugin；
 *  change: 2026-10-12-build-and-load-extensions-independently，任务 4.6：入口改为
 *  metadata + 异步 loadDescriptor，验证与生产相同契约）。
 *
 * 只依赖公共契约类型与 shared；验证进入/释放生命周期，只在测试清单中使用。
 * 不导入任何宿主内部实现或后端代码。
 */
import type { ApplicationExtensionFrontendAsyncEntry, ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { SAMPLE_SITE_EXTENSION_ID } from "./shared.js";

export type SampleFrontendProbe = {
  entered: number;
  disposed: number;
};

export const SAMPLE_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: SAMPLE_SITE_EXTENSION_ID,
  version: "1.0.0",
  label: "样例站点插件",
  description: "用于测试的前后端扩展样例。",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: 1
};

export function createSampleFrontendEntry(probe: SampleFrontendProbe): ApplicationExtensionFrontendAsyncEntry {
  return {
    metadata: { ...SAMPLE_FRONTEND_METADATA },
    async loadDescriptor() {
      const plugin = () => {
        probe.entered += 1;
        return () => {
          probe.disposed += 1;
        };
      };
      Object.defineProperty(plugin, "name", { value: SAMPLE_SITE_EXTENSION_ID, configurable: true });
      return {
        extensionId: SAMPLE_SITE_EXTENSION_ID,
        configScope: "site",
        activation: "server-active",
        plugin: () => plugin
      };
    }
  };
}
