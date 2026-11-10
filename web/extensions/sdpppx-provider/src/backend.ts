/**
 * SDPPPX 扩展宿主插件。
 *
 * 一个插件同时承担两件事：
 * 1. **账号**：微信扫码（Authing）→ Supabase bridge 会话，令牌只留在宿主；同源 handler 只
 *    投影状态。会话优先落在 owner-scoped 文档存储，跨重启保留。
 * 2. **Provider**：登录后把租户模板投影成模型目录，并在演示/下线时保持占位注册。
 *
 * 租户 / Supabase / anon key 是编译进 `deployment-config.ts` 的部署身份；其余可调参数读
 * `SDPPPX_*` 环境变量（`options.env` 仅用于测试注入）。部署身份为空时插件照样装载：
 * Provider 不可用、handler 返回稳定诊断，宿主与其他扩展不受影响。
 */
import {
  defineConfigSchema,
  type ExtensionPlugin,
  type GenerationModelDefinition,
  type GenerationProvider
} from "@woohaa3/contracts";
import {
  SDPPPX_ERROR_CODES,
  SDPPPX_PLUGIN_ID,
  SDPPPX_PROVIDER_ID,
  EMPTY_SDPPPX_CONFIG_SUMMARY,
  type SdpppxBalance,
  type SdpppxConfigSummary,
  type SdpppxFailure,
  type SdpppxModelRefreshResult,
  type SdpppxResult,
  type SdpppxSessionSnapshot,
  type SdpppxSessionView
} from "./shared.js";
import { isSdpppxConfigured, readSdpppxConfig, summarizeSdpppxConfig, type SdpppxConfig, type SdpppxEnv } from "./backend/config.js";
import type { SdpppxDeployment } from "./backend/deployment-config.js";
import {
  createDocumentSessionStore,
  createMemorySessionStore,
  sessionView,
  type SessionManager,
  type SessionStore,
  createSessionManager
} from "./backend/session.js";
import { fetchSdpppxBalance } from "./backend/balance.js";
import { fetchSdpppxCatalog, type SdpppxTemplate } from "./backend/catalog.js";
import { createSdpppxLoginFlow, type SdpppxLoginFlow } from "./backend/login-flow.js";
import { createSdpppxProvider, type SdpppxProviderRuntime } from "./backend/provider.js";
import { createSdpppxReferenceUploader, type SdpppxReferenceUploader } from "./backend/reference.js";
import { createSdpppxTemporaryExposer } from "./backend/temporary-hosting.js";
import { registerSdpppxRoutes } from "./backend/routes.js";
import { SdpppxHttpError } from "./backend/http.js";

/** 本期没有可写配置项；部署身份编译进 deployment-config.ts，运行参数来自环境变量。 */
export const SDPPPX_CONFIG = defineConfigSchema({});

export type SdpppxExtensionOptions = {
  /** 可调参数来源（测试注入）；缺省 `process.env`。 */
  env?: SdpppxEnv;
  /** 部署身份覆盖（仅测试）；缺省用 `deployment-config.ts` 的内置值。 */
  deployment?: SdpppxDeployment;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  /** 会话存储覆盖（测试注入）；缺省用 `ctx.services.documents` 或内存。 */
  store?: SessionStore;
  jobRepository?: unknown;
  pollIntervalMs?: number;
  /** 临时图床 I/O 覆盖（仅测试用）。 */
  mediaUpload?: (input: import("./backend/media-upload.js").SdpppxMediaUploadInput) => Promise<import("./backend/media-upload.js").SdpppxMediaUploadResult>;
  mediaProbe?: (input: import("./backend/media-upload.js").SdpppxMediaProbeInput) => Promise<import("./backend/media-upload.js").SdpppxMediaProbeResult>;
};

const BALANCE_CACHE_MS = 60_000;

function failure(code: SdpppxFailure["code"], message: string, missing?: string[]): SdpppxFailure {
  return { ok: false, code, message, ...(missing ? { missing } : {}) };
}

function modelDefinitionsOf(templates: readonly SdpppxTemplate[], timeoutMs: number): GenerationModelDefinition[] {
  return templates.map((template) => ({
    providerId: SDPPPX_PROVIDER_ID,
    providerModelId: template.templateId,
    modelType: template.modelType,
    title: template.title,
    taskTimeoutMs: timeoutMs
  }));
}

export function createSdpppxProviderPlugin(
  options: SdpppxExtensionOptions = {}
): ExtensionPlugin<typeof SDPPPX_CONFIG.fields> {
  const envOf = (): SdpppxEnv => options.env ?? process.env;
  const now = options.now ?? (() => Date.now());

  return {
    name: SDPPPX_PLUGIN_ID,
    label: "SDPPPX",
    icon: "identity",
    configPrefix: `extensions.${SDPPPX_PLUGIN_ID}`,
    modelTypes: ["image", "video"],
    inject: ["log", "generation", "storage", "exposer"],
    Config: SDPPPX_CONFIG,
    health: () => {
      const config = readSdpppxConfig(envOf(), options.deployment);
      if (config.degradedCode === null) return undefined;
      return {
        state: "degraded" as const,
        diagnostics: [
          {
            code: config.degradedCode,
            message: `缺少 SDPPPX 部署参数：${config.missing.join(" / ")}`
          }
        ]
      };
    },
    async apply(ctx, _config) {
      const log = ctx.log.scope(SDPPPX_PLUGIN_ID);
      const config = (): SdpppxConfig => readSdpppxConfig(envOf(), options.deployment);
      const documents = options.store ? undefined : ctx.services?.documents;
      const store: SessionStore =
        options.store ?? (documents ? createDocumentSessionStore(documents) : createMemorySessionStore());
      if (!options.store && !documents) {
        log({ event: "sdpppx-session-store-ephemeral", code: "sdpppx-service-unavailable" });
      }
      const session: SessionManager = createSessionManager({
        config,
        store,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        now,
        log: (event) => log(event)
      });

      const templates = new Map<string, SdpppxTemplate>();
      const models: GenerationModelDefinition[] = [];
      let available = false;
      let catalogRevision = 0;
      let refreshPromise: Promise<SdpppxResult<SdpppxModelRefreshResult>> | null = null;
      let balanceCache: { userId: string; at: number; value: SdpppxBalance | null } | null = null;
      let recommendUploadProvider: string | null = null;

      const uploads: SdpppxReferenceUploader = createSdpppxReferenceUploader({
        config,
        session,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        now,
        recommendUploadProvider: () => recommendUploadProvider,
        log: (event) => log(event)
      });

      const runtime: SdpppxProviderRuntime = createSdpppxProvider({
        config,
        session,
        uploads,
        templates: () => templates,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        now,
        ...(options.jobRepository ? { jobRepository: options.jobRepository } : {}),
        ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
        onRecommendUploadProvider: (provider) => {
          recommendUploadProvider = provider;
        },
        log: (event) => log(event)
      });

      const registration: GenerationProvider = {
        extensionId: SDPPPX_PLUGIN_ID,
        providerId: SDPPPX_PROVIDER_ID,
        // `available` / `models` / `catalogRevision` 是注册对象的可写快照：登录后原地刷新，
        // 不重复 register（重复注册会命中宿主 duplicate-provider）。
        available,
        selectionAuthority: "server",
        catalogRevision,
        provider: runtime.provider,
        models,
        describeModel: ({ providerModelId, modelType }) =>
          runtime.describeModel(providerModelId, modelType),
        prepareInput: (input) => runtime.prepareInput(input),
        uploadReference: (input) =>
          uploads.upload({
            bytes: input.bytes,
            contentType: input.contentType,
            ...(input.reference.role ? { role: input.reference.role } : {}),
            ...(input.storageKey ? { storageKey: input.storageKey } : {})
          })
      };
      // 注册对象持有的是同一个 models 数组；available/catalogRevision 需要在每次目录变化后写回。
      const syncRegistration = (): void => {
        registration.available = available;
        registration.catalogRevision = catalogRevision;
      };

      const clearCatalog = (): void => {
        available = false;
        templates.clear();
        models.splice(0, models.length);
        catalogRevision += 1;
        balanceCache = null;
        recommendUploadProvider = null;
        uploads.clear();
        runtime.clear();
        syncRegistration();
      };

      const applyCatalog = (templatesNext: readonly SdpppxTemplate[]): void => {
        templates.clear();
        for (const template of templatesNext) templates.set(template.templateId, template);
        models.splice(0, models.length, ...modelDefinitionsOf(templatesNext, config().taskTimeoutMs));
        available = templatesNext.length > 0;
        // 空目录也是一次成功刷新：available=false，但版本仍要推进，否则界面不会收敛。
        catalogRevision += 1;
        syncRegistration();
      };

      const refreshCatalog = async (): Promise<SdpppxResult<SdpppxModelRefreshResult>> => {
        if (refreshPromise) return refreshPromise;
        const run = (async (): Promise<SdpppxResult<SdpppxModelRefreshResult>> => {
          const current = config();
          if (!isSdpppxConfigured(current)) {
            return failure(
              current.degradedCode ?? SDPPPX_ERROR_CODES.configIncomplete,
              "缺少 SDPPPX 部署参数",
              current.missing
            );
          }
          await session.load();
          if (!session.session()) {
            clearCatalog();
            return failure(SDPPPX_ERROR_CODES.sessionExpired, "登录已过期");
          }
          try {
            const token = await session.accessToken();
            const templatesNext = await fetchSdpppxCatalog({
              config: current,
              accessToken: token,
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
            });
            applyCatalog(templatesNext);
            log({ event: "sdpppx-catalog-refreshed", modelCount: models.length, catalogRevision });
            return {
              ok: true,
              available,
              modelCount: models.length,
              catalogRevision,
              error: null
            };
          } catch (error) {
            const expired =
              error instanceof SdpppxHttpError && error.code === SDPPPX_ERROR_CODES.sessionExpired;
            if (expired) {
              await session.clear("sdpppx-session-expired");
              clearCatalog();
              log({ event: "sdpppx-catalog-failed", code: SDPPPX_ERROR_CODES.sessionExpired });
              return failure(SDPPPX_ERROR_CODES.sessionExpired, "登录已过期");
            }
            const code = error instanceof SdpppxHttpError
              ? error.code === SDPPPX_ERROR_CODES.configIncomplete
                ? SDPPPX_ERROR_CODES.configIncomplete
                : SDPPPX_ERROR_CODES.catalogUnavailable
              : SDPPPX_ERROR_CODES.catalogUnavailable;
            log({ event: "sdpppx-catalog-failed", code, modelCount: models.length });
            // 保留上一次成功目录：一次网络失败不该让已启用的模型凭空消失。
            return {
              ok: true,
              available,
              modelCount: models.length,
              catalogRevision,
              error: code
            };
          }
        })();
        refreshPromise = run;
        try {
          return await run;
        } finally {
          if (refreshPromise === run) refreshPromise = null;
        }
      };

      const flow: SdpppxLoginFlow = createSdpppxLoginFlow({
        config,
        session,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        now,
        log: (event) => log(event),
        onAuthorized: async () => {
          await refreshCatalog();
        }
      });

      const balanceFor = async (active: { userId: string; accessToken: string }): Promise<SdpppxBalance | null> => {
        const current = config();
        if (!isSdpppxConfigured(current)) return null;
        if (balanceCache && balanceCache.userId === active.userId && now() - balanceCache.at < BALANCE_CACHE_MS) {
          return balanceCache.value;
        }
        let value: SdpppxBalance | null = null;
        try {
          value = await fetchSdpppxBalance({
            config: current,
            accessToken: active.accessToken,
            userId: active.userId,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
          });
        } catch {
          value = null;
        }
        balanceCache = { userId: active.userId, at: now(), value };
        return value;
      };

      const configSummary = (current: SdpppxConfig): SdpppxConfigSummary =>
        isSdpppxConfigured(current) ? summarizeSdpppxConfig(current) : {
          ...EMPTY_SDPPPX_CONFIG_SUMMARY,
          ...summarizeSdpppxConfig(current)
        };

      const snapshot = async (): Promise<SdpppxSessionSnapshot> => {
        const current = config();
        const base = {
          config: configSummary(current),
          missing: current.missing
        };
        if (!isSdpppxConfigured(current)) {
          return {
            ...base,
            status: "unconfigured",
            degradedCode: current.degradedCode,
            session: null,
            notice: null
          };
        }
        await session.load();
        await session.ensureActive();
        const active = session.session();
        if (!active) {
          if (session.rawSession()) session.setNotice(SDPPPX_ERROR_CODES.sessionExpired);
          return {
            ...base,
            status: "anonymous",
            degradedCode: null,
            session: null,
            notice: session.notice()
          };
        }
        const balance = await balanceFor(active);
        const view: SdpppxSessionView = sessionView(active, balance);
        return {
          ...base,
          status: "authenticated",
          degradedCode: null,
          session: view,
          notice: null
        };
      };

      const logout = async (): Promise<SdpppxSessionSnapshot> => {
        await session.clear(null);
        clearCatalog();
        return snapshot();
      };

      ctx.effect(() => ctx.generation.register(registration));
      // 临时图床：独立媒体端点 + 匿名读取核验；就绪只看部署配置与当前登录会话，
      // 模板目录为空或刷新失败都不影响上传资格。
      const temporary = createSdpppxTemporaryExposer({
        storage: ctx.storage,
        config,
        session,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.mediaUpload ? { upload: options.mediaUpload } : {}),
        ...(options.mediaProbe ? { probe: options.mediaProbe } : {}),
        log: (event) => log(event)
      });
      ctx.effect(() => ctx.exposer.register(temporary));
      ctx.effect(() => () => temporary.dispose(), "sdpppx-temporary-hosting");
      ctx.effect(() => () => {
        flow.dispose();
        runtime.clear();
        uploads.clear();
      }, "sdpppx-login-flow");

      if (ctx.webServer) {
        registerSdpppxRoutes({
          config,
          flow,
          snapshot,
          logout,
          refreshModels: refreshCatalog,
          register: (route) => ctx.webServer!.register(route),
          log: (event) => log(event)
        });
      } else {
        log({ event: "sdpppx-routes-unavailable", code: "sdpppx-service-unavailable" });
      }

      // 启动时恢复持久会话：先处理到期续期，有可用会话就顺手拉一次目录；没有会话不发起外部请求。
      void session
        .load()
        .then(async () => {
          await session.ensureActive();
          if (!session.session()) return;
          await refreshCatalog();
        })
        .catch(() => {
          log({ event: "sdpppx-startup-restore-failed", code: "sdpppx-service-unavailable" });
        });

      log({
        event: "sdpppx-plugin-activated",
        configured: isSdpppxConfigured(config()),
        hasWebServer: Boolean(ctx.webServer)
      });
    }
  };
}
