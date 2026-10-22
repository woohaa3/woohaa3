/**
 * Media Service composition root（change: split-web-runtime-services，任务 3.1 / 3.4；
 * change: 2026-10-16-add-storage-extension-point 起 media 不再直接持有对象存储）。
 *
 * 组合 public `/api/media` handler 与 internal v1 handler。存储由外部注入：本机宿主把
 * `ctx.storage` 的 media namespace 视图接进来（见 `web/backend/src/ports/media-storage.ts`），
 * 媒体服务本身不知道后端是 local、COS 还是服务端，也不读任何存储凭据。
 *
 * 未注入存储时直接抛错，不回退到本地/内存实现。
 */
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createNativeProjectVerifier,
  createProcessOnlyVerifier,
  type NativeProjectVerifier
} from "@woohaa3/photocraft-project-verifier";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MediaStorage } from "@woohaa3/contracts";
import type { BackendMediaPort } from "@woohaa3/contracts";
import { createMediaRequestHandler, type MediaRequestHandler } from "./api/public-handler.js";
import { createMediaInternalHandler, type MediaInternalHandler } from "./api/internal-handler.js";
import { DEFAULT_MEDIA_BASE_PATH } from "./api/public-handler.js";
import { MEDIA_INTERNAL_BASE_PATH } from "./api/internal-handler.js";
import { createMediaApplicationService } from "./application/internal-service.js";
import { createExtensionMediaResources } from "./application/extension-resources.js";
import { parseServiceIdentityConfig, type ServiceIdentityConfig } from "./security/identity.js";

export type MediaServiceOptions = {
  env?: Record<string, string | undefined>;
  /** 媒体对象存储端口；必填（由宿主从 `ctx.storage` 的 media namespace 注入）。 */
  storage: MediaStorage;
  identities?: ServiceIdentityConfig;
  publicBasePath?: string;
  internalBasePath?: string;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

export type MediaService = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  readiness: () => Promise<{ ready: boolean; reason?: string }>;
  close: () => Promise<void>;
  storage: MediaStorage;
  /**
   * 进程内 Media 契约（change: 2026-10-06-unify-backend-runtime-with-cordis，任务 2.1）。
   * 供统一后端进程内的 Canvas/Task 模块直接调用，取代服务间 HTTP client。
   */
  port: () => BackendMediaPort;
};

export function createMediaService(options: MediaServiceOptions): MediaService {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  if (!options.storage) throw new Error("createMediaService 需要注入存储（ctx.storage 的 media namespace）");
  const storage = options.storage;
  const identities = options.identities ?? parseServiceIdentityConfig(env);
  const log = options.logger ?? (() => undefined);

  const verifierPath = env.WOOHAA3_PROJECT_VERIFIER_PATH?.trim();
  // change: 2026-10-21-extract-photocraft-subproject，任务 3.1/3.2 / design D5：
  // 核验能力已迁入 `@woohaa3/photocraft-project-verifier`。Media 每个服务实例持有**自己的**
  // 可释放实例，不再共享模块级全局配置 —— 多实例互不影响并发额度，关闭一个也不会清掉
  // 另一个仍在用的配置。未配置原生工具时用只做进程内有界核验的默认实例。
  const verifier: NativeProjectVerifier = verifierPath
    ? (() => {
        if (!isAbsolute(verifierPath)) throw new Error("WOOHAA3_PROJECT_VERIFIER_PATH 必须为绝对路径");
        accessSync(verifierPath, constants.X_OK);
        return createNativeProjectVerifier({ binaryPath: verifierPath });
      })()
    : createProcessOnlyVerifier();

  const publicHandler: MediaRequestHandler = createMediaRequestHandler({
    storage,
    basePath: options.publicBasePath ?? DEFAULT_MEDIA_BASE_PATH,
    maxBytes: options.maxBytes,
    logger: log,
    verifier
  });

  /** 进程内 Media 能力（供统一后端进程的 BackendMediaPort 复用）。 */
  const internalApp = createMediaApplicationService({
    storage,
    ...(options.maxBytes !== undefined ? { maxImportBytes: options.maxBytes } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.resolveHost ? { resolveHost: options.resolveHost } : {})
  });

  const readiness = async (): Promise<{ ready: boolean; reason?: string }> => {
    // 只读探测：写一个固定 key 再读回，验证主存储读写与 metadata 一致性。
    // 对外（expose）后端不参与就绪：它失败只影响需要外部地址的生成任务。
    const key = "health-probe";
    const bytes = new Uint8Array([0]);
    try {
      await storage.put(key, bytes, "application/octet-stream");
      const exists = await storage.exists(key);
      if (!exists) return { ready: false, reason: "媒体存储探测对象不可读" };
      if (typeof storage.stat === "function") {
        const stat = await storage.stat(key);
        if (stat.size !== bytes.byteLength) return { ready: false, reason: "媒体存储探测对象 metadata 不一致" };
      }
      return { ready: true };
    } catch {
      return { ready: false, reason: "媒体存储读写探测失败" };
    }
  };

  const internalHandler: MediaInternalHandler = createMediaInternalHandler({
    storage,
    identities,
    basePath: options.internalBasePath ?? MEDIA_INTERNAL_BASE_PATH,
    fetchImpl: options.fetchImpl,
    resolveHost: options.resolveHost,
    logger: log,
    readiness
  });

  return {
    storage,
    readiness,
    port: () => ({
      resources: createExtensionMediaResources(storage),
      // canvas scope / canvasId 只做透传：进程内调用方声明这次读写属于哪张画布。
      verify: (storageKey, expected, scope) => internalApp.verify(storageKey, expected, scope),
      sign: (storageKey, expiresSeconds, scope) => internalApp.sign(storageKey, expiresSeconds, scope),
      importFromUrl: (input) => internalApp.importFromUrl(input),
      importBytes: (input) => internalApp.importBytes(input)
    }),
    handle: async (req, res) => {
      // 内部协议优先（不同前缀，不会与 public 冲突）。
      if (await internalHandler(req, res)) return true;
      return publicHandler(req, res);
    },
    close: async () => {
      verifier.dispose();
      const closeable = storage as { close?: () => void | Promise<void> };
      await closeable.close?.();
    }
  };
}

export { MEDIA_INTERNAL_BASE_PATH, DEFAULT_MEDIA_BASE_PATH };
