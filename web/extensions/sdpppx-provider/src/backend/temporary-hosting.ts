/**
 * SDPPPX 临时图床来源（change: 2026-11-09-add-sdpppx-media-temporary-hosting）。
 *
 * 职责边界：
 * - 稳定来源身份 `sdpppx-temporary`（category=provider、priority=10、图片/视频、20 MiB）；
 * - 从宿主存储读稳定素材，调用独立 `/media/upload` 适配器，再做匿名有界读取核验；
 * - 就绪只看「部署配置完整 + 当前登录会话可用」，模板目录状态不参与；
 * - 并发按 画布/内容/实际大小与类型/owner/SDPPPX 账号/授权代次/baseUrl 合并；首版**不缓存**
 *   跨请求地址（上游没有 TTL，不能把宿主缺省一天当成承诺）；
 * - 登出、换号、来源撤销、全部等待者取消都会丢弃迟到结果。
 *
 * 授权代次取会话管理器的 `epoch`（只有登出/切换主体才递增）：正常同账号 access token 续期
 * 保持同一代次，不会让每个请求都被核心判成 stale。账号身份只用于内部隔离，不进入公开视图。
 */
import type { HostStorageService, StorageExposeInput, StorageExposer } from "@woohaa3/contracts";
import { SDPPPX_PLUGIN_ID } from "../shared.js";
import type { SdpppxConfig } from "./config.js";
import type { SessionManager } from "./session.js";
import {
  baseMediaType,
  probeSdpppxMediaReadable,
  uploadSdpppxMedia,
  validateSdpppxMedia,
  SDPPPX_MEDIA_MAX_BYTES,
  type SdpppxMediaProbeInput,
  type SdpppxMediaProbeResult,
  type SdpppxMediaUploadInput,
  type SdpppxMediaUploadResult
} from "./media-upload.js";

/** 稳定的 exposerId：自动路由的提供商候选，与 RunningHub 同优先级时按 ID 排序。 */
export const SDPPPX_TEMPORARY_EXPOSER_ID = "sdpppx-temporary";
export const SDPPPX_TEMPORARY_LABEL = "SDPPPX 临时图床";

export type SdpppxTemporaryHostingOptions = {
  storage: HostStorageService;
  config: () => SdpppxConfig;
  session: SessionManager;
  fetchImpl?: typeof globalThis.fetch;
  upload?: (input: SdpppxMediaUploadInput) => Promise<SdpppxMediaUploadResult>;
  probe?: (input: SdpppxMediaProbeInput) => Promise<SdpppxMediaProbeResult>;
  getCredentialEpoch?: () => number;
  /** 只记录来源、阶段、状态码、错误码与字节数；不输出令牌或完整下载 URL。 */
  log?: (event: Record<string, unknown>) => void;
};

export type SdpppxTemporaryExposer = StorageExposer & { dispose(): void };

type Identity = {
  scope: string;
  objectKey: string;
  size: number;
  contentType: string;
  userId: string;
  epoch: number;
  baseUrl: string;
};

type PendingEntry = {
  identity: Identity;
  controller: AbortController;
  waiters: number;
  promise: Promise<string>;
};

export function createSdpppxTemporaryExposer(options: SdpppxTemporaryHostingOptions): SdpppxTemporaryExposer {
  const pending = new Map<string, PendingEntry>();
  const upload = options.upload ?? uploadSdpppxMedia;
  const probe = options.probe ?? probeSdpppxMediaReadable;
  let disposed = false;

  const epochOf = (): number => options.getCredentialEpoch?.() ?? options.session.epoch();
  const log = options.log ?? (() => undefined);

  const sessionOf = () => options.session.session();

  const ready = (): boolean => {
    if (disposed) return false;
    return options.config().degradedCode === null && sessionOf() !== null;
  };

  const note = (): string | null => {
    if (disposed) return "来源已卸载";
    if (options.config().degradedCode !== null) return "部署参数不完整";
    return sessionOf() === null ? "未登录 SDPPPX" : null;
  };

  const identityKey = (identity: Identity): string =>
    [
      identity.scope,
      identity.objectKey,
      String(identity.size),
      identity.contentType,
      identity.userId,
      String(identity.epoch),
      identity.baseUrl
    ].join("\u0000");

  const start = (
    identity: Identity,
    accessToken: string,
    bytes: Uint8Array,
    contentType: string
  ): PendingEntry => {
    const controller = new AbortController();
    const entry: PendingEntry = {
      identity,
      controller,
      waiters: 0,
      promise: Promise.resolve("")
    };
    const work = (async (): Promise<string> => {
      log({
        event: "sdpppx-temporary-prepare",
        stage: "upload",
        exposerId: SDPPPX_TEMPORARY_EXPOSER_ID,
        size: bytes.byteLength,
        contentType
      });
      const uploaded = await upload({
        baseUrl: identity.baseUrl,
        accessToken,
        bytes,
        contentType,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        signal: controller.signal
      });
      if (controller.signal.aborted) throw abortError();
      if (!uploaded.ok) {
        // 认证失效才清会话；403 是权限拒绝，匿名下载的 403 更不能影响登录态。
        if (uploaded.status === 401) {
          await options.session.clear("sdpppx-session-expired");
        }
        log({
          event: "sdpppx-temporary-failed",
          stage: "upload",
          exposerId: SDPPPX_TEMPORARY_EXPOSER_ID,
          status: uploaded.status,
          code: uploaded.code
        });
        throw mediaError(uploaded.message, uploaded.code);
      }
      const readable = await probe({
        url: uploaded.url,
        mediaType: uploaded.mediaType,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        signal: controller.signal
      });
      if (controller.signal.aborted) throw abortError();
      if (!readable.ok) {
        log({
          event: "sdpppx-temporary-failed",
          stage: "probe",
          exposerId: SDPPPX_TEMPORARY_EXPOSER_ID,
          status: 0,
          code: "sdpppx-media-not-readable"
        });
        throw mediaError(`SDPPPX 上传成功但地址不可匿名读取：${readable.message}`, "sdpppx-media-not-readable");
      }
      // 共享上传结束时也复核来源与授权：结果不能流进已经撤销/换号的会话。
      if (disposed) throw staleError("临时图床来源已撤销");
      if (epochOf() !== identity.epoch) throw staleError("SDPPPX 授权已变化，请重试");
      const current = sessionOf();
      if (!current || current.userId !== identity.userId) throw staleError("SDPPPX 账号已变化，请重试");
      log({
        event: "sdpppx-temporary-prepared",
        exposerId: SDPPPX_TEMPORARY_EXPOSER_ID,
        size: uploaded.size
      });
      // 上游没有 TTL：不写任何跨请求缓存，只把本次结果交给当前等待者。
      return uploaded.url;
    })();
    // 共享 promise 的失败由其等待者消费；这里兜住「全部等待者已取消」后的迟到拒绝。
    entry.promise = work.finally(() => {
      if (pending.get(identityKey(identity)) === entry) pending.delete(identityKey(identity));
    });
    entry.promise.catch(() => undefined);
    pending.set(identityKey(identity), entry);
    return entry;
  };

  const exposer: SdpppxTemporaryExposer = {
    exposerId: SDPPPX_TEMPORARY_EXPOSER_ID,
    label: SDPPPX_TEMPORARY_LABEL,
    ownerExtensionId: SDPPPX_PLUGIN_ID,
    requiresReplica: false,
    temporaryHosting: {
      category: "provider",
      priority: 10,
      constraints: { mediaKinds: ["image", "video"], maxBytes: SDPPPX_MEDIA_MAX_BYTES },
      // 明确未知：上游 `/media/upload` 不返回过期时间，也没有保留承诺。
      validitySeconds: null,
      ready,
      statusNote: note,
      credentialEpoch: epochOf
    },
    async expose(input: StorageExposeInput) {
      if (disposed) throw staleError("临时图床来源已撤销");
      const config = options.config();
      if (config.degradedCode !== null) throw mediaError("SDPPPX 部署参数不完整", config.degradedCode);
      const required = input.request?.requiredValiditySeconds ?? input.expiresSeconds ?? 0;
      if (required > 0) {
        // 不继承宿主缺省一天：上游没有可确认的窗口时只能明确拒绝。
        throw mediaError(
          `SDPPPX 临时图床没有可确认的有效期（上游不返回期限），无法满足 ${required} 秒的有效窗口`,
          "sdpppx-media-invalid-response"
        );
      }
      const signal = input.request?.signal;
      if (signal?.aborted) throw abortError();

      // 先完成恢复/续期，再冻结授权身份。
      await options.session.load();
      await options.session.ensureActive();
      if (signal?.aborted) throw abortError();
      const active = sessionOf();
      if (!active) throw mediaError("SDPPPX 临时图床未登录", "sdpppx-session-expired");
      const epoch = epochOf();

      const bucket = options.storage.bucket(input.namespace, input.scope);
      // 先用存储统计挡掉明显超限的对象，避免为了拒绝而把整段视频读进内存；
      // 真正发送前仍然按实际字节复核（stat 可能缺失或过期）。
      const stat = await bucket.head(input.key);
      if (stat && stat.size > SDPPPX_MEDIA_MAX_BYTES) {
        throw mediaError("素材超过 20 MiB 上限，未上传", "sdpppx-media-unsupported");
      }
      const object = await bucket.get(input.key);
      if (signal?.aborted) throw abortError();
      const bytes = object.bytes;
      const contentType = baseMediaType(object.contentType ?? input.request?.contentType) || "application/octet-stream";
      const invalid = validateSdpppxMedia(bytes, contentType);
      if (invalid) throw mediaError(invalid.message, invalid.code);

      const identity: Identity = {
        scope: input.scope?.canvasId ?? "",
        objectKey: `${input.namespace}/${input.key}`,
        size: bytes.byteLength,
        contentType,
        userId: active.userId,
        epoch,
        baseUrl: config.baseUrl
      };
      const key = identityKey(identity);
      let entry = pending.get(key);
      if (!entry) {
        const accessToken = await options.session.accessToken();
        if (signal?.aborted) throw abortError();
        if (epochOf() !== epoch) throw staleError("SDPPPX 授权已变化，请重试");
        entry = pending.get(key) ?? start(identity, accessToken, bytes, contentType);
      }

      entry.waiters += 1;
      const shared = entry;
      try {
        const url = await waitWithAbort(shared.promise, signal);
        if (signal?.aborted) throw abortError();
        if (disposed) throw staleError("临时图床来源已撤销");
        if (epochOf() !== epoch) throw staleError("SDPPPX 授权已变化，请重试");
        const current = sessionOf();
        if (!current || current.userId !== active.userId) throw staleError("SDPPPX 账号已变化，请重试");
        return url;
      } finally {
        shared.waiters -= 1;
        // 一个等待者取消只结束自己；全部取消且共享上传仍在进行时才真正中断上游请求。
        if (shared.waiters <= 0 && pending.get(key) === shared) {
          shared.controller.abort();
          pending.delete(key);
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
    }
  };
  return exposer;
}

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function mediaError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = "SdpppxMediaError";
  error.code = code;
  return error;
}

function staleError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = "StorageExposeStaleError";
  error.code = "STORAGE_EXPOSE_STALE";
  return error;
}

function abortError(): Error {
  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}
