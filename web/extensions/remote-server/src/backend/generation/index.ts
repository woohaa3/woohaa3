/**
 * 服务端托管生成 Provider 的注册与生命周期
 * （change: 2026-10-20-reserve-remote-generation-provider，tasks 5.2/5.5/5.6）。
 *
 * 形状（design D2/D7）：
 * - 扩展激活时**只注册一次**占位 Provider（`available=false`、空模型、`catalogRevision=0`）；之后
 *   所有变化都在**原地**改这份注册（`models.splice` / `available` / `catalogRevision`），绝不重复
 *   `register`（core 对重复 id 直接抛错）。模型启停与其它 Provider 一样走本机策略。
 * - 会话出现后 `GetCapabilities` → `GetCatalog`：协商失败、未实现、空目录都保持休眠（info 级，
 *   不改连接相位、不表现成故障）。
 * - 会话失效/登出/切服 → 翻转不可用并清空模型；远端暂时不可达时**保留**已注册目录
 *   （一次网络抖动不该让整份目录消失）。
 *
 * 刷新用 in-flight 合并：登录事件与手动「刷新模型」同时到达时共享同一次远端往返。
 */
import type { GenerationModelDefinition, GenerationProvider } from "@woohaa3/contracts";
import { REMOTE_SERVER_EXTENSION_ID } from "../../shared.js";
import type { RemoteSession } from "../session.js";
import { createGenerationClient, type GenerationClient } from "./client.js";
import {
  decodeGenerationCapabilities,
  decodeGenerationCatalog,
  generationRpcErrorText,
  isGenerationDormantCode,
  isGenerationTransientCode,
  negotiateGenerationCapabilities,
  REMOTE_GENERATION_PROVIDER_ID,
  type GenerationAdmission
} from "./protocol.js";
import { RemoteGenerationError, createRemoteGenerationProvider, prepareRemoteGenerationInput } from "./provider.js";
import { withImageParameterFamily } from "./image-models.js";

/** 刷新结果（受控 handler 直接返回它；不含远端正文与任何凭据）。 */
export type RemoteGenerationStatus = {
  available: boolean;
  modelCount: number;
  catalogRevision: number;
  /** 最近一次刷新的稳定原因/失败短语；正常休眠且无原因时为 null。 */
  error: string | null;
};

export type RemoteGenerationLogInput = {
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  code?: string;
  reason?: string;
  modelCount?: number;
  skippedModels?: number;
  catalogRevision?: number;
  serverUrl?: string | null;
};

export type RemoteGenerationBridgeOptions = {
  /** 宿主是否提供生成扩展点；缺失时安静跳过（旧宿主/纯本地宿主）。 */
  registerGeneration?: (provider: GenerationProvider) => void;
  /** 当前会话（唯一来源；不触发自动登录）。 */
  session: () => Promise<Pick<RemoteSession, "serverUrl" | "token"> | null>;
  fetchImpl: typeof globalThis.fetch;
  log: (input: RemoteGenerationLogInput) => void;
  /** 测试可调小轮询间隔。 */
  pollIntervalMs?: number;
  clientTimeoutMs?: number;
  /**
   * 把参考字节推到本部署的存储，返回它的 locator。
   *
   * 由后端装配注入（用的是已注册的 server 存储后端）：Provider 不知道键布局，
   * 只负责「把字节交出去，拿回一个不透明位置」。
   */
  putReference?: (input: { bytes: Uint8Array; contentType: string; canvasId?: string; storageKey?: string }) => Promise<string | undefined>;
};

export type RemoteGenerationBridge = {
  /** 注册占位 Provider（只注册一次）；返回是否已注册。 */
  activate(): boolean;
  /** 重新探测并替换目录；并发调用共享同一次往返。 */
  refresh(): Promise<RemoteGenerationStatus>;
  status(): RemoteGenerationStatus;
};

const DORMANT_PROTOCOL_REASON = "服务端托管生成协议版本不匹配";
const DORMANT_FEATURE_REASON = "服务端托管生成缺少目录能力";
const DORMANT_EMPTY_REASON = "服务端暂未提供生成模型";

export function createRemoteGenerationBridge(options: RemoteGenerationBridgeOptions): RemoteGenerationBridge {
  const client: GenerationClient = createGenerationClient({
    fetchImpl: options.fetchImpl,
    ...(options.clientTimeoutMs !== undefined ? { timeoutMs: options.clientTimeoutMs } : {})
  });

  /** 已归一模型：注册时交给 core 的**同一个数组**，刷新就地替换内容。 */
  const models: GenerationModelDefinition[] = [];
  /** providerModelId → 受理版本（SubmitTask.admission）。 */
  let admission = new Map<string, GenerationAdmission>();
  let registration: GenerationProvider | null = null;
  let lastError: string | null = null;
  let inflight: Promise<RemoteGenerationStatus> | null = null;

  const modelFor = (providerModelId: string): GenerationModelDefinition | undefined =>
    models.find((model) => model.providerModelId === providerModelId);

  const providerHandle = createRemoteGenerationProvider({
    client,
    session: options.session,
    ...(options.putReference ? { putReference: options.putReference } : {}),
    modelFor,
    admissionFor: (providerModelId) => admission.get(providerModelId),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
  });

  const currentStatus = (): RemoteGenerationStatus => ({
    available: registration?.available === true,
    modelCount: models.length,
    catalogRevision: registration?.catalogRevision ?? 0,
    error: lastError
  });

  const bumpCatalogRevision = (): number => {
    if (registration === null) return 0;
    registration.catalogRevision = (registration.catalogRevision ?? 0) + 1;
    return registration.catalogRevision;
  };

  /**
   * 翻转到休眠（清空模型、标记不可用）。
   *
   * `transient=true` 表示「远端暂时不可达」：已注册且可用的目录保持原样（design D7），
   * 只有会话失效/未实现/目录为空等**确定性**结论才真正翻下去。
   */
  const applyDormant = (input: {
    event: string;
    level?: "debug" | "info" | "warn";
    code?: string;
    reason: string | null;
    transient?: boolean;
    serverUrl?: string | null;
  }): void => {
    if (registration === null) return;
    const wasActive = registration.available || models.length > 0;
    if (input.transient === true && registration.available) {
      // 保留注册：已展示的模型不因一次网络抖动消失；执行时按 unavailable 失败并给可读原因。
      lastError = input.reason;
      options.log({
        event: input.event,
        level: input.level ?? "info",
        code: input.code ?? "unavailable",
        reason: input.reason ?? undefined,
        serverUrl: input.serverUrl ?? null
      });
      return;
    }
    registration.available = false;
    models.splice(0, models.length);
    admission = new Map();
    if (wasActive) bumpCatalogRevision();
    lastError = input.reason;
    options.log({
      event: input.event,
      level: input.level ?? "info",
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.reason !== null ? { reason: input.reason } : {}),
      ...(input.serverUrl !== undefined ? { serverUrl: input.serverUrl } : {})
    });
  };

  const logDormant = (code: string, reason: string, serverUrl: string | null, level: "debug" | "info" | "warn" = "info"): void => {
    applyDormant({ event: "remote-generation-dormant", level, code, reason, serverUrl });
  };

  /**
   * 一次完整刷新。
   *
   * 顺序固定为「先协商、再拉目录」：版本不匹配时不该发一次目录请求（老服务端可能没有这个 RPC，
   * 多发一次只会把正常的「未实现」变成日志噪音）。
   */
  const doRefresh = async (): Promise<RemoteGenerationStatus> => {
    if (registration === null) return currentStatus();

    const session = await options.session();
    if (session === null) {
      // 未登录是正常形态，不是错误：清空目录但保留注册，reason 留空。
      lastError = null;
      if (registration.available || models.length > 0) {
        registration.available = false;
        models.splice(0, models.length);
        admission = new Map();
        bumpCatalogRevision();
      }
      options.log({ event: "remote-generation-dormant", level: "debug", code: "unauthenticated", reason: "没有可用会话" });
      return currentStatus();
    }

    const capabilities = await client.getCapabilities(session);
    if (!capabilities.ok) {
      const reason = generationRpcErrorText(capabilities.code);
      const transient = isGenerationTransientCode(capabilities.code);
      if (isGenerationDormantCode(capabilities.code) && !transient) {
        logDormant(capabilities.code, reason, session.serverUrl);
      } else if (transient) {
        applyDormant({
          event: "remote-generation-refresh-unreachable",
          level: "info",
          code: capabilities.code,
          reason,
          transient: true,
          serverUrl: session.serverUrl
        });
        if (!registration.available) lastError = reason;
      } else {
        logDormant(capabilities.code, reason, session.serverUrl, "warn");
      }
      return currentStatus();
    }

    const decoded = decodeGenerationCapabilities(capabilities.value);
    const negotiation = negotiateGenerationCapabilities(decoded);
    if (!negotiation.ok) {
      logDormant(
        negotiation.code,
        negotiation.code === "protocol-version" ? DORMANT_PROTOCOL_REASON : DORMANT_FEATURE_REASON,
        session.serverUrl
      );
      return currentStatus();
    }

    const catalog = await client.getCatalog(session);
    if (!catalog.ok) {
      const reason = generationRpcErrorText(catalog.code);
      const transient = isGenerationTransientCode(catalog.code);
      if (transient) {
        applyDormant({
          event: "remote-generation-refresh-unreachable",
          level: "info",
          code: catalog.code,
          reason,
          transient: true,
          serverUrl: session.serverUrl
        });
        if (!registration.available) lastError = reason;
      } else {
        logDormant(catalog.code, reason, session.serverUrl);
      }
      return currentStatus();
    }

    const decodedCatalog = decodeGenerationCatalog(catalog.value, REMOTE_GENERATION_PROVIDER_ID);
    if (!decodedCatalog.available) {
      logDormant("catalog-unavailable", DORMANT_EMPTY_REASON, session.serverUrl);
      return currentStatus();
    }
    if (decodedCatalog.models.length === 0) {
      logDormant("catalog-empty", DORMANT_EMPTY_REASON, session.serverUrl);
      options.log({
        event: "remote-generation-catalog-skipped",
        level: "info",
        skippedModels: decodedCatalog.skippedModels,
        reason: "目录为空或全部模型预过滤",
        serverUrl: session.serverUrl
      });
      return currentStatus();
    }

    // 原地替换：注册对象与 models 数组的引用都不变，catalog 与设置视图按请求现读即可生效。
    // 图像模型在这里套上 Provider 侧的家族 schema（见 image-models.ts）：服务端给的通用
    // `size` 形状不足以表达即梦/Gemini/gpt-image 的参数差异。
    models.splice(0, models.length, ...decodedCatalog.models.map(withImageParameterFamily));
    admission = decodedCatalog.admission;
    registration.available = true;
    const revision = bumpCatalogRevision();
    lastError = null;
    options.log({
      event: "remote-generation-catalog-loaded",
      level: "info",
      modelCount: models.length,
      skippedModels: decodedCatalog.skippedModels,
      catalogRevision: revision,
      serverUrl: session.serverUrl
    });
    if (decodedCatalog.skippedModels > 0) {
      options.log({
        event: "remote-generation-catalog-degraded",
        level: "info",
        code: "model-skipped",
        skippedModels: decodedCatalog.skippedModels,
        serverUrl: session.serverUrl
      });
    }
    return currentStatus();
  };

  return {
    activate() {
      if (!options.registerGeneration) {
        // 宿主没有生成扩展点（旧宿主/纯本地宿主）：安静跳过，不当成激活失败。
        options.log({ event: "remote-generation-unavailable", level: "info", reason: "宿主没有提供生成扩展点" });
        return false;
      }
      if (registration !== null) return true;
      const provider: GenerationProvider = {
        extensionId: REMOTE_SERVER_EXTENSION_ID,
        providerId: REMOTE_GENERATION_PROVIDER_ID,
        available: false,
        // 与其它 Provider 一样走本机运营策略：目录由服务端发现，但哪些模型可用由设置页的
        // 模型启停决定；没启用的模型不进 catalog，也不出现在画布的模型选择器里。
        catalogRevision: 0,
        provider: providerHandle,
        models,
        describe: (providerModelId: string) => modelFor(providerModelId),
        // 参考输入走自己上传：本地/未同步画布的字节在客户端，服务端读不到裸键。
        // uploadReference 把字节推到本部署存储并返回 locator，提交体只带 locator；
        // 已经是服务端对象（reference.locator 存在）时 Task 不会问这个钩子。
        uploadReference: async (input) => {
          const locator = await options.putReference?.(input);
          if (locator === undefined) {
            // 明确报「没连上」，不要回落到签名地址：那会让上游拿到一个它读不了的 URL，
            // 最后以 media-not-found 收场，把「未连接」伪装成「素材不存在」。
            throw new RemoteGenerationError("unavailable", "尚未连接远端服务，无法上传参考素材");
          }
          return { locator };
        },
        prepareInput: (input) => prepareRemoteGenerationInput(input, { modelFor, admissionFor: (id) => admission.get(id) })
      };
      // 只注册一次：registration 非空即已注册，之后的刷新只原地改写。
      options.registerGeneration(provider);
      registration = provider;
      options.log({ event: "remote-generation-registered", level: "info", modelCount: 0, catalogRevision: 0 });
      return true;
    },

    refresh(): Promise<RemoteGenerationStatus> {
      if (inflight !== null) return inflight;
      const started = doRefresh()
        .catch((error: unknown) => {
          // 刷新绝不把异常抛给 handler：远端异常只是「这次没成功」，界面拿稳定原因。
          const reason = error instanceof Error ? error.message : "服务端托管生成刷新失败";
          logDormant("refresh-failed", reason, null, "warn");
          return currentStatus();
        })
        .finally(() => {
          if (inflight === started) inflight = null;
        });
      inflight = started;
      return started;
    },

    status: currentStatus
  };
}
