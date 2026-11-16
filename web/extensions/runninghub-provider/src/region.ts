/**
 * RunningHub 站点区域（change: 2026-11-17-add-runninghub-region-detection）。
 *
 * RunningHub 国内站与国际站是两套独立账号体系：路径一致，只有 Host 不同，API Key 不能跨站。
 * 这里集中定义两站的受控地址与一次鉴权探测，所有上游调用都从区域派生地址，不在各模块重复
 * 拼 Host。
 *
 * 探测使用 `POST /openapi/v2/media/upload/binary` 的空文件 multipart：它不创建任务、不落文件，
 * 且与真正会失败的上传能力走同一条鉴权路径。正确站点会返回“file is required”等参数错误，
 * 错站返回 `API Key不存在` / `ApiKey verification failed`。
 *
 * 不能改用 `/uc/openapi/accountStatus`、`/openapi/v2/query`、`/openapi/v2/api-key/list` 或
 * `/openapi/v2/queue/status`：实测这些接口在两个站点是镜像的，国内站 Key 在 `.ai` 也返回
 * code 0 与同一份账户数据，无法判断归属。文字站的 `/v1/models` 也对假 Key 公开返回 200。
 */

export type RunningHubRegion = "ai" | "cn";

const REGION_SITES: Readonly<Record<RunningHubRegion, { site: string; wwwHost: string }>> = {
  ai: { site: "runninghub.ai", wwwHost: "www.runninghub.ai" },
  cn: { site: "runninghub.cn", wwwHost: "www.runninghub.cn" }
};

/** 未确认区域时保持与历史实现一致的国际站默认。 */
export const DEFAULT_RUNNINGHUB_REGION: RunningHubRegion = "ai";

export const RUNNINGHUB_REGIONS: readonly RunningHubRegion[] = ["ai", "cn"] as const;

export function isRunningHubRegion(value: unknown): value is RunningHubRegion {
  return value === "ai" || value === "cn";
}

export function runningHubRegionLabel(region: RunningHubRegion): string {
  return region === "cn" ? "国内站" : "国际站";
}

/** 站点 origin（`https://www.runninghub.{ai|cn}`）。 */
export function runningHubOrigin(region: RunningHubRegion): string {
  return `https://${REGION_SITES[region].wwwHost}`;
}

/** 媒体任务 API base（`/openapi/v2`）。 */
export function runningHubApiBaseURL(region: RunningHubRegion): string {
  return `${runningHubOrigin(region)}/openapi/v2`;
}

/** 新版二进制上传端点。 */
export function runningHubUploadURL(region: RunningHubRegion): string {
  return `${runningHubApiBaseURL(region)}/media/upload/binary`;
}

/** 标准模型目录页；只作为“站点仍在售”的正向证据。 */
export function runningHubCatalogURL(region: RunningHubRegion): string {
  return `${runningHubOrigin(region)}/call-api/standard-api`;
}

/** 账户余额／鉴权信息接口。 */
export function runningHubAccountStatusURL(region: RunningHubRegion): string {
  return `${runningHubOrigin(region)}/uc/openapi/accountStatus`;
}

/** 文字模型独立端点（`llm.runninghub.{ai|cn}/v1`）。 */
export function runningHubLLMBaseURL(region: RunningHubRegion): string {
  return `https://llm.${REGION_SITES[region].site}/v1`;
}

/** 文字模型目录。 */
export function runningHubLLMCatalogURL(region: RunningHubRegion): string {
  return `${runningHubLLMBaseURL(region)}/models`;
}

/** 设置页“获取 Key”入口；保留既有邀请链接。 */
export function runningHubKeyPageURL(region: RunningHubRegion): string {
  return region === "cn"
    ? "https://www.runninghub.cn/zh-cn/call-api/bill-task?tab=keys&type=shared"
    : "https://www.runninghub.ai/zh-cn/call-api/bill-task?tab=keys&type=shared&inviteCode=rh-v1272";
}

export type RunningHubProbeOutcome = "success" | "wrong-region" | "present-but-rejected" | "unknown";

export type RunningHubRegionProbe = {
  region: RunningHubRegion;
  outcome: RunningHubProbeOutcome;
  /** 上游 HTTP 状态；网络失败时缺省。 */
  status?: number;
  /** 上游业务码；无法解析时缺省。 */
  code?: number;
  /** 可定位的短消息；不回传完整响应体。 */
  message?: string;
};

export type RunningHubRegionDetection =
  | {
      ok: true;
      region: RunningHubRegion;
      /** `ready` 表示账户接口成功；`rejected` 表示站点识别到了 Key，但当前 Key 被拒绝。 */
      accountState: "ready" | "rejected";
      probes: RunningHubRegionProbe[];
    }
  | {
      ok: false;
      reason: "missing" | "credentials-invalid" | "unreachable" | "ambiguous";
      message: string;
      probes: RunningHubRegionProbe[];
    };

const REGION_DETECTION_TIMEOUT_MS = 5_000;
const WRONG_REGION_CODES = new Set([802, 806, 1002]);
const PRESENT_BUT_REJECTED_CODES = new Set([801, 811, 812]);
const UNKNOWN_CODES = new Set([1000, 1003, 1005, 1010, 1011, 1012]);
const WRONG_REGION_MESSAGES = [
  "APIKEY_USER_NOT_FOUND",
  "API Key不存在",
  "API Key 不存在",
  "ApiKey verification failed",
  "Invalid API Key"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function messageOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  for (const key of ["msg", "errorMessage"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * 空文件上传的响应分类。
 *
 * - 鉴权失败（key 不存在/未授权）→ wrong-region；
 * - `file is required` 等参数错误 → success，说明该站认出了 Key；
 * - 801/811/812 等 Key 类型/额度错误 → present-but-rejected；
 * - 1001 Invalid URL 与瞬时错误 → unknown（不能据此判断区域）；
 * - 非 JSON / 网络 / 5xx → unknown。
 */
function classifyUploadProbe(payload: unknown): RunningHubProbeOutcome {
  if (!isRecord(payload)) return "unknown";
  const code = numericCode(payload.code) ?? numericCode(payload.errorCode);
  const message = messageOf(payload) ?? "";
  if (code === 0) return "success";
  if (code === 1001) return "unknown";
  if ((code !== undefined && WRONG_REGION_CODES.has(code)) || WRONG_REGION_MESSAGES.some((fragment) => message.includes(fragment))) {
    return "wrong-region";
  }
  if (code !== undefined && PRESENT_BUT_REJECTED_CODES.has(code)) return "present-but-rejected";
  if (code !== undefined && UNKNOWN_CODES.has(code)) return "unknown";
  if (code !== undefined || message !== "") return "success";
  return "unknown";
}

async function probeRunningHubRegion(
  region: RunningHubRegion,
  apiKey: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number
): Promise<RunningHubRegionProbe> {
  const form = new FormData();
  // 空文件：正确站点会返回 “file is required”，错站先返回 Key 不存在；不会真的落一个文件。
  form.append("file", new Blob([], { type: "text/plain" }), "region-probe.txt");
  let response: Response;
  try {
    response = await fetchImpl(runningHubUploadURL(region), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json"
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    return { region, outcome: "unknown", message: `无法连接 ${runningHubOrigin(region)}` };
  }

  const payload: unknown = await response.json().catch(() => null);
  const message = messageOf(payload);
  const code = isRecord(payload) ? numericCode(payload.code) ?? numericCode(payload.errorCode) : undefined;
  const base = {
    region,
    status: response.status,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message })
  };

  if (!response.ok) {
    // 网关级 401/403 也视为“这个站不认这个 Key”；其余非 2xx 不据此判断区域。
    if (response.status === 401 || response.status === 403) {
      return { ...base, outcome: "wrong-region" };
    }
    return { ...base, outcome: "unknown" };
  }

  return { ...base, outcome: classifyUploadProbe(payload) };
}

/**
 * 用同一把 Key 并行探测两个站，返回唯一可确认的区域。
 *
 * - 唯一 success：区域确定，上传鉴权路径接受该 Key。
 * - 唯一 present-but-rejected：区域确定但 Key 被上传能力拒绝（例如免费 Key 不支持）。
 * - 两个 wrong-region：Key 无效。
 * - 其余：无法确认（网络、歧义或未知业务码），调用方保留旧值或回退国际站。
 */
export async function detectRunningHubRegion(options: {
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<RunningHubRegionDetection> {
  const apiKey = (options.apiKey ?? "").trim();
  if (apiKey === "") {
    return { ok: false, reason: "missing", message: "未配置 RunningHub API Key", probes: [] };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REGION_DETECTION_TIMEOUT_MS;
  const probes = await Promise.all(
    RUNNINGHUB_REGIONS.map((region) => probeRunningHubRegion(region, apiKey, fetchImpl, timeoutMs))
  );

  const successful = probes.filter((probe) => probe.outcome === "success");
  if (successful.length === 1) {
    return { ok: true, region: successful[0]!.region, accountState: "ready", probes };
  }
  if (successful.length > 1) {
    return { ok: false, reason: "ambiguous", message: "RunningHub API Key 同时匹配国际站与国内站", probes };
  }

  const rejected = probes.filter((probe) => probe.outcome === "present-but-rejected");
  if (rejected.length === 1) {
    return { ok: true, region: rejected[0]!.region, accountState: "rejected", probes };
  }
  if (rejected.length > 1) {
    return { ok: false, reason: "ambiguous", message: "RunningHub API Key 在两个站点都存在但均被拒绝", probes };
  }

  const wrong = probes.filter((probe) => probe.outcome === "wrong-region");
  if (wrong.length === probes.length) {
    return {
      ok: false,
      reason: "credentials-invalid",
      message: "RunningHub API Key 在国内外站均无效或未授权",
      probes
    };
  }

  return {
    ok: false,
    reason: "unreachable",
    message: "无法确认 RunningHub API Key 的站点区域（网络不可达或上游异常）",
    probes
  };
}
