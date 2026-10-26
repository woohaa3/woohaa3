import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const FIXTURE_ECHO_PLUGIN_ID = "fixture-echo-provider";
export const FIXTURE_ECHO_PROVIDER_ID = "fixture-echo";
/** 同步文本模型：doGenerate 直接回显 prompt。 */
export const FIXTURE_ECHO_TEXT_MODEL = "echo-text";
/** 异步图片模型：走 pptask jobs（start → 轮询 status → 结果），返回一张 1×1 PNG。 */
export const FIXTURE_ECHO_IMAGE_MODEL = "echo-image";
/** 模型刷新路由（扩展前缀下，受管扩展允许）。 */
export const FIXTURE_ECHO_REFRESH_PATH = "/api/extensions/fixture-echo-provider/refresh";

export const FIXTURE_ECHO_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: FIXTURE_ECHO_PLUGIN_ID,
  name: "市场测试 Provider",
  description: "扩展市场测试 fixture：真实走 doGenerate 与 jobs 的回显 Provider，后端运行在 Extension Host 子进程。",
  version: "1.0.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "fixture-echo-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};
