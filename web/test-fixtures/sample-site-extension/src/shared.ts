/**
 * 样例插件的共享身份与配置校验
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.3 / design D2）。
 *
 * 前后端均可导入；只含身份、metadata 与纯配置校验，不含运行时实现、网络调用或秘密。
 * 生产后端宿主为 `application`。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const SAMPLE_SITE_EXTENSION_ID = "sample-site-extension";

export const SAMPLE_SITE_EXTENSION_METADATA: ApplicationExtensionMetadata = {
  extensionId: SAMPLE_SITE_EXTENSION_ID,
  name: "样例站点插件",
  description: "测试用的前后端扩展样例：typed capability、受控 handler 与 draining 工作。",
  version: "1.0.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "sample-site-config", schemaVersion: 1 },
  dependencies: [{ id: "sample.fixture.runtime", required: true }],
  capabilities: [
    { id: "sample.fixture.action", kind: "capability", description: "样例能力" },
    { id: "sample.fixture.echo", kind: "handler", description: "样例受保护操作", auth: "authenticated" },
    { id: "sample.fixture.loop", kind: "background-resource", description: "样例后台循环" }
  ]
};

/** 样例配置校验：只接受数字 threshold（0..100）。 */
export function validateSampleSiteConfig(values: Record<string, unknown>): string | null {
  const threshold = values.threshold;
  if (threshold === undefined) return null;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    return "threshold 必须是 0..100 的数字";
  }
  return null;
}
