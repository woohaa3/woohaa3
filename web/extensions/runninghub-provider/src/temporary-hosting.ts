/**
 * RunningHub 临时图床（change: 2026-11-07-add-runninghub-llm-and-provider-temporary-hosting）。
 *
 * 使用官方**新版**二进制上传接口 `POST /openapi/v2/media/upload/binary`（Bearer + multipart
 * `file`），只把经结构校验的 `data.download_url` 当作外链；旧工作流上传返回的 `fileName`
 * 是 RunningHub 内部引用，**不**能拼成公开地址，二者语义严格分开。
 *
 * 官方说明下载地址有效期一天且不是文件存储服务，所以：
 * - 只承诺临时传递；能从签名参数确认到期时间时取「签名到期 / 文档上限」的较早值并留余量；
 * - 无法确认到期时间时不跨请求缓存；
 * - 缓存按画布作用域、内容身份、来源 owner 与凭据 epoch 隔离；同一对象并发上传合并为一次；
 * - 失败立即清除进行中项，下一次独立请求重新上传；不承诺远端恰好上传一次或续期。
 */
import { assertPublicHttpsUrl } from "@woohaa3/provider-sdk";
import type { HostStorageService, StorageExposeInput, StorageExposer } from "@woohaa3/contracts";
import { RUNNINGHUB_PLUGIN_ID } from "./shared/identity.js";

/** 稳定的 exposerId：自动路由的提供商候选。 */
export const RUNNINGHUB_TEMPORARY_EXPOSER_ID = "runninghub-temporary";
export const RUNNINGHUB_TEMPORARY_LABEL = "RunningHub 临时图床";
/** 官方新版上传端点；固定写死在插件内。 */
export const RUNNINGHUB_UPLOAD_URL = "https://www.runninghub.ai/openapi/v2/media/upload/binary";
/** 官方文档的链接上限：一天；不是续期承诺。 */
export const RUNNINGHUB_TEMPORARY_VALIDITY_SECONDS = 24 * 60 * 60;
/** 计算到期时间时保留的安全余量（上限 5 分钟）。 */
const SAFETY_MARGIN_MS = 5 * 60 * 1000;
/** 对外承诺的安全窗口：文档上限减去余量，避免把「刚好一天」当成保证。 */
export const RUNNINGHUB_TEMPORARY_SAFE_VALIDITY_SECONDS = RUNNINGHUB_TEMPORARY_VALIDITY_SECONDS - SAFETY_MARGIN_MS / 1000;

export type RunningHubUploadSuccess = {
  ok: true;
  url: string;
  filename?: string;
  /** 从签名参数或文档上限推算出的绝对到期时间（毫秒）。 */
  expiresAt: number;
};

export type RunningHubUploadFailure = { ok: false; message: string };
export type RunningHubUploadResult = RunningHubUploadSuccess | RunningHubUploadFailure;

/** 解析官方上传响应：code 0 / 200 且必须带真实的 https 下载地址。 */
export function parseRunningHubUploadResponse(
  payload: unknown,
  options: { now?: number; expectedMediaKind?: string } = {}
): RunningHubUploadSuccess | RunningHubUploadFailure {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "RunningHub 上传响应不是对象" };
  }
  const record = payload as Record<string, unknown>;
  if (record.success === false) {
    return { ok: false, message: messageOf(record, "RunningHub 上传失败") };
  }
  const code = record.code;
  if (code !== 0 && code !== 200 && code !== "0" && code !== "200") {
    return { ok: false, message: messageOf(record, `RunningHub 上传失败（code ${String(code ?? "missing")}）`) };
  }
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, message: "RunningHub 上传响应缺少 data" };
  }
  const entry = data as Record<string, unknown>;
  const rawUrl = typeof entry.download_url === "string" ? entry.download_url.trim() : "";
  if (!rawUrl) {
    // 只有 fileName / filename 是内部引用，不能当外链成功。
    return { ok: false, message: "RunningHub 上传未返回 download_url（只有内部文件引用不算临时图床成功）" };
  }
  let url: string;
  try {
    assertPublicHttpsUrl(rawUrl);
    url = rawUrl;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "下载地址不符合网络边界" };
  }
  const now = options.now ?? Date.now();
  const declared = typeof entry.type === "string" ? entry.type : undefined;
  if (options.expectedMediaKind && declared && declared !== "file" && declared !== options.expectedMediaKind) {
    // 上游把文件类型标成别的东西时不能假装成功：调用方请求的是图片/视频/音频之一。
    if (!declared.includes(options.expectedMediaKind)) {
      return { ok: false, message: `RunningHub 上传返回的类型是 ${declared}，与请求的 ${options.expectedMediaKind} 不符` };
    }
  }
  return {
    ok: true,
    url,
    ...(typeof entry.filename === "string" ? { filename: entry.filename } : typeof entry.fileName === "string" ? { filename: entry.fileName } : {}),
    expiresAt: expiryOf(url, now)
  };
}

/** 能确认签名到期就取较早值；不能确认时按官方文档一天上限留余量。 */
export function expiryOf(url: string, now: number): number {
  const parsed = urlExpiry(url);
  const documented = now + RUNNINGHUB_TEMPORARY_VALIDITY_SECONDS * 1000;
  const deadline = parsed === undefined ? documented : Math.min(parsed, documented);
  return deadline - safetyMargin(deadline - now);
}

function safetyMargin(windowMs: number): number {
  return Math.max(0, Math.min(SAFETY_MARGIN_MS, Math.floor(windowMs * 0.1)));
}

function urlExpiry(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  for (const name of ["q-sign-time", "q-key-time", "Expires"]) {
    const value = parsed.searchParams.get(name);
    if (!value) continue;
    const parts = value.split(";");
    const candidate = name === "Expires" ? Number(parts[0]) : Number(parts[1] ?? parts[0]);
    if (Number.isFinite(candidate) && candidate > 0) {
      // COS 的 q-sign-time 是秒；Expires 也是秒。
      return candidate * 1000;
    }
  }
  return undefined;
}

export type RunningHubUploadInput = {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  uploadUrl?: string;
  signal?: AbortSignal;
  now?: number;
  expectedMediaKind?: string;
};

/** 调官方新版上传；失败只返回可定位消息，不把内部文件名当外链。 */
export async function uploadRunningHubMedia(input: RunningHubUploadInput): Promise<RunningHubUploadSuccess | RunningHubUploadFailure> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const form = new FormData();
  const blob = new Blob([new Uint8Array(input.bytes) as unknown as BlobPart], { type: input.contentType });
  form.append("file", blob, input.filename);
  let response: Response;
  try {
    response = await fetchImpl(input.uploadUrl ?? RUNNINGHUB_UPLOAD_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}`, accept: "application/json" },
      body: form,
      ...(input.signal ? { signal: input.signal } : {})
    });
  } catch (error) {
    return { ok: false, message: `连接 RunningHub 上传接口失败：${error instanceof Error ? error.message : String(error)}` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, message: `RunningHub 上传返回非 JSON 响应（HTTP ${response.status}）` };
  }
  if (!response.ok) {
    const parsed = parseRunningHubUploadResponse(payload, { now: input.now });
    return { ok: false, message: parsed.ok ? `RunningHub 上传 HTTP ${response.status}` : parsed.message };
  }
  return parseRunningHubUploadResponse(payload, {
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.expectedMediaKind ? { expectedMediaKind: input.expectedMediaKind } : {})
  });
}

type CacheEntry = {
  url: string;
  expiresAt: number;
  identity: string;
};

export type RunningHubTemporaryExposerOptions = {
  storage: HostStorageService;
  /** 按请求读取当前 Key；Key 被替换/清除后自动退出候选。 */
  getApiKey: () => string | undefined;
  /** 凭据修订：用于隔离缓存与冻结一次请求。 */
  getCredentialEpoch?: () => number;
  fetchImpl?: typeof globalThis.fetch;
  uploadUrl?: string;
  /** 测试可注入时钟。 */
  now?: () => number;
  /** 上传实现（测试可替换）；返回成功/失败结构。 */
  upload?: (input: RunningHubUploadInput) => Promise<RunningHubUploadSuccess | RunningHubUploadFailure>;
};

export function createRunningHubTemporaryExposer(options: RunningHubTemporaryExposerOptions): StorageExposer {
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<string>>();
  const now = options.now ?? Date.now;
  const upload = options.upload ?? uploadRunningHubMedia;
  const epoch = () => options.getCredentialEpoch?.() ?? 0;

  const exposer: StorageExposer = {
    exposerId: RUNNINGHUB_TEMPORARY_EXPOSER_ID,
    label: RUNNINGHUB_TEMPORARY_LABEL,
    ownerExtensionId: RUNNINGHUB_PLUGIN_ID,
    requiresReplica: false,
    temporaryHosting: {
      category: "provider",
      priority: 10,
      constraints: { mediaKinds: ["image", "video", "audio"] },
      validitySeconds: RUNNINGHUB_TEMPORARY_SAFE_VALIDITY_SECONDS,
      ready: () => Boolean(options.getApiKey()?.trim()),
      credentialEpoch: epoch
    },
    async expose(input: StorageExposeInput) {
      const apiKey = options.getApiKey()?.trim();
      if (!apiKey) throw new Error("RunningHub 临时图床未配置 API Key");
      const signal = input.request?.signal;
      if (signal?.aborted) throw abortError();
      const required = input.request?.requiredValiditySeconds ?? input.expiresSeconds ?? 0;
      if (required > RUNNINGHUB_TEMPORARY_SAFE_VALIDITY_SECONDS) {
        throw new Error(`RunningHub 临时图床只承诺一天内的临时地址，无法满足 ${required} 秒的有效窗口`);
      }

      const bucket = options.storage.bucket(input.namespace, input.scope);
      const stat = await bucket.head(input.key);
      const contentType = input.request?.contentType ?? stat?.contentType ?? "application/octet-stream";
      const size = input.request?.sizeBytes ?? stat?.size ?? 0;
      const mediaKind = input.request?.mediaKind ?? mediaKindOf(contentType);
      const identity = [
        input.scope?.canvasId ?? "",
        `${input.namespace}/${input.key}`,
        String(size),
        contentType,
        exposer.ownerExtensionId ?? "",
        String(epoch())
      ].join("\u0000");

      const cached = cache.get(identity);
      if (cached && cached.expiresAt - now() > required * 1000 + SAFETY_MARGIN_MS) {
        return cached.url;
      }
      if (cached) cache.delete(identity);

      const current = pending.get(identity);
      if (current) return current;

      const work = (async () => {
        const object = await bucket.get(input.key);
        if (signal?.aborted) throw abortError();
        const result = await upload({
          bytes: object.bytes,
          contentType: object.contentType ?? contentType,
          filename: filenameFor(input.key, object.contentType ?? contentType),
          apiKey,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.uploadUrl ? { uploadUrl: options.uploadUrl } : {}),
          ...(signal ? { signal } : {}),
          now: now(),
          ...(mediaKind ? { expectedMediaKind: mediaKind } : {})
        });
        if (signal?.aborted) throw abortError();
        if (!result.ok) throw new Error(result.message);
        const remaining = result.expiresAt - now();
        if (required > 0 && remaining < required * 1000) {
          throw new Error(`RunningHub 返回的临时地址有效窗口不足 ${required} 秒`);
        }
        // 无法确认安全窗口时（例如到期时间不可靠）不建立跨请求缓存。
        if (remaining > SAFETY_MARGIN_MS) {
          cache.set(identity, { url: result.url, expiresAt: result.expiresAt, identity });
        }
        return result.url;
      })();
      pending.set(identity, work);
      try {
        return await work;
      } finally {
        // 失败也清除进行中项：下一次独立请求可以重新尝试。
        pending.delete(identity);
      }
    }
  };
  return exposer;
}

function filenameFor(key: string, contentType: string): string {
  const base = key.split("/").pop() || "upload";
  if (/\.[a-z0-9]+$/i.test(base)) return base;
  const extension = contentType.startsWith("image/png") ? "png"
    : contentType.startsWith("image/jpeg") ? "jpg"
      : contentType.startsWith("image/webp") ? "webp"
        : contentType.startsWith("video/") ? "mp4"
          : contentType.startsWith("audio/") ? "mp3"
            : "bin";
  return `${base}.${extension}`;
}

export function mediaKindOf(contentType: string): string | undefined {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return undefined;
}

function messageOf(record: Record<string, unknown>, fallback: string): string {
  const message = record.message ?? record.msg;
  return typeof message === "string" && message.trim() !== "" ? message : fallback;
}

function abortError(): Error {
  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}
