/**
 * ppserver Provider 的共享身份与端点常量。
 *
 * ppserver 是**任务路由器**：客户端只提交 `templateId` + `payload`，由服务端挑供应商
 * （CRUN / Novita / …）并执行。所以这里没有任何厂商密钥，也没有厂商模型名——只有路由端点。
 *
 * 端点表取自 PS 插件 `sdpppx-services` 的 `DEFAULT_ENDPOINTS`（线上实际调用方）。
 * 注意 `create` 与 `create_stream` 是两个入口：当前部署里 `/tasks/create` 不存在（404），
 * 只有 `/tasks/create_stream` 在（401 未鉴权）。所以执行只走流式入口。
 *
 * 本文件不含执行实现、网络或秘密。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const PPSERVER_PLUGIN_ID = "ppserver-provider";

export const PPSERVER_PROVIDER_ID = "ppserver";

/** 线上任务路由器。权威取值来自 `banners/sixi/config.json` 的 `taskrouterBaseUrl`，这里只是缺省。 */
export const DEFAULT_PPSERVER_BASE_URL = "https://sdpppx.zombee.tech/ppserver";

/** 模板参数表单（GET，query 带 `templateId`）。 */
export const PPSERVER_DESCRIBE_PATH = "/tasks/describe";
/** 创建任务并流式接收状态（POST，SSE）。当前部署只有这一个创建入口。 */
export const PPSERVER_CREATE_STREAM_PATH = "/tasks/create_stream";
/** 查询任务状态（POST，body 带 `taskId`）。 */
export const PPSERVER_STATUS_PATH = "/tasks/status";
/** 取任务结果（POST，body 带 `taskId`）。 */
export const PPSERVER_RESULT_PATH = "/tasks/result";
/** 取消任务（POST，body 带 `taskId`）。 */
export const PPSERVER_CANCEL_PATH = "/tasks/cancel";

/** 模板 locator 的 scheme。pptask 用 locator 表达「资源在哪」，服务端只认这个前缀。 */
export const PPSERVER_LOCATOR_SCHEME = "sdpppx";

export const PPSERVER_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: PPSERVER_PLUGIN_ID,
  name: "ppserver Provider",
  description:
    "ppserver 任务路由器。填写模板 ID（UUID）后按模板执行生图 / 生视频，供应商由服务端路由。模板的参数表单由 /tasks/describe 提供。",
  version: "1.0.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "ppserver-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};

/** 去掉末尾斜杠。各端点自己带路径。 */
export function ppserverOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** `sdpppx://template/<uuid>`，与服务端和 PS 插件一致。 */
export function templateLocator(templateId: string): string {
  return `${PPSERVER_LOCATOR_SCHEME}://template/${templateId.trim()}`;
}

/** 从 locator 里取回 templateId；传进来的已经是裸 id 时原样返回。 */
export function templateIdFromLocator(value: string): string {
  const trimmed = value.trim();
  const prefix = `${PPSERVER_LOCATOR_SCHEME}://template/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

/**
 * 模板 ID 是 UUID。
 *
 * 不校验版本位（`[1-5]`）也不校验 variant 位：ppserver 自己的 `tasks_template.id` 是普通
 * uuid 列，但未来可能用 uuid v7。只要求「看起来是 uuid」，真正是否存在由服务端回答。
 */
const TEMPLATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTemplateId(value: string): boolean {
  return TEMPLATE_ID_PATTERN.test(value.trim());
}

export type ParsedTemplateList =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

/**
 * 解析配置里的模板名单：逗号、空白或换行分隔。
 *
 * **整份拒绝**而不是跳过坏项：少一个模板是「某个模型不见了」，用户很难自己发现；
 * 拒绝并说明哪几个不合法，比静默丢更安全。重复项只留一个。
 */
export function parseTemplateIds(value: string | undefined, max = 64): ParsedTemplateList {
  const ids: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const part of (value ?? "").split(/[\s,]+/)) {
    const id = templateIdFromLocator(part);
    if (!id || seen.has(id)) continue;
    if (!isTemplateId(id)) invalid.push(id);
    else {
      seen.add(id);
      ids.push(id.toLowerCase());
    }
  }
  if (invalid.length > 0) {
    return { ok: false, message: `模板 ID 必须是 UUID：${invalid.slice(0, 3).join("、")}` };
  }
  if (ids.length > max) return { ok: false, message: `一次最多接入 ${max} 个模板` };
  return { ok: true, ids };
}
