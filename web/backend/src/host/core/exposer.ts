/**
 * 核心层 · exposer：`ctx.exposer` 扩展点（对外地址）。
 *
 * 与 `ctx.storage` 拆开的原因是两个生命周期不同：
 * - 存储缺失 → 宿主整体不可用，进就绪门槛；
 * - 对外地址缺失 → 只影响「把 URL 交给远端」的那类任务（生成 API 拉参考素材），宿主照常启动。
 *
 * 解析顺序（change: 2026-11-07-add-runninghub-llm-and-provider-temporary-hosting）：
 * ① 画布显式覆盖：指定 id 只用该来源；空串表示禁用。
 * ② 全局显式来源（`exposer.primary`，旧键 `storage.expose`）：只用该来源。
 * ③ 自动：先选符合当前请求的提供商临时图床（优先级升序、再按 exposerId 字典序），
 *    没有时选 Woohaa3 内置临时图床。当前主存储能 presign **不抢占**自动候选，
 *    它仍可作为手动选择。
 *
 * 自动模式选中的提供商出现可恢复失败时，符合条件的内置来源最多回退一次；手动选择不静默改投。
 * 一次请求会冻结来源 owner 与凭据 epoch，变化即按请求失效处理。
 */
import {
  StorageExposeUnavailableError,
  isStorageObjectNotFoundError,
  type HostExposerService,
  type HostStorageService,
  type StorageExposeInput,
  type StorageExposer,
  type StorageScope,
  type TemporaryHostingCandidateView,
  type TemporaryHostingDeclaration,
  type TemporaryHostingQuery,
  type TemporaryHostingRouteView
} from "@woohaa3/contracts";
import type { HostPlugin } from "../context.js";

export type ExposerSettings = {
  /** 全局显式来源 id；自动模式返回 undefined。 */
  expose(): string | undefined;
};

export type ExposerRegistryOptions = {
  settings: ExposerSettings;
  storage: HostStorageService;
  logger?: (event: Record<string, unknown>) => void;
};

const DEFAULT_PRIORITY = 100;
/** 文档上限一天；没有签名时间时按文档上限留安全余量（由提供者自己声明 validitySeconds）。 */
const FALLBACK_VALIDITY_SECONDS = 24 * 60 * 60;

type Candidate = {
  exposer: StorageExposer;
  declaration: TemporaryHostingDeclaration;
  priority: number;
};

type RequestFacts = {
  /** 无素材的配置查询只检查就绪；真实请求仍必须通过素材约束。 */
  configurationOnly?: boolean;
  mediaKind?: string;
  contentType?: string;
  sizeBytes?: number;
  requiredValiditySeconds?: number;
  signal?: AbortSignal;
};

export function createExposerRegistry(options: ExposerRegistryOptions): HostExposerService {
  const log = options.logger ?? (() => undefined);
  const storage = options.storage;
  const registered = new Map<string, StorageExposer>();
  /** 最近一次真实失败（只影响展示，不永久拉黑提供商）。 */
  let lastFailure: { exposerId: string; message: string } | null = null;

  const selectedIdOf = (): string | undefined => {
    const value = options.settings.expose()?.trim();
    return value ? value : undefined;
  };

  /** 后端自带签名能力时，它同时就是一个提供者（无需插件再注册一份）。 */
  const implicitFor = (backendId: string): StorageExposer | undefined => {
    const backend = storage.resolve(backendId);
    const presign = backend?.presign;
    if (!backend || !presign) return undefined;
    return {
      exposerId: backend.backendId,
      ...(backend.label ? { label: backend.label } : {}),
      ...(backend.ownerExtensionId ? { ownerExtensionId: backend.ownerExtensionId } : {}),
      requiresReplica: true,
      targetBackendId: backend.backendId,
      expose: (input) => {
        const expires = input.expiresSeconds;
        return presign.call(
          backend,
          `${input.namespace}/${input.key}`,
          expires === undefined ? undefined : { expiresSeconds: expires },
          input.scope
        );
      }
    };
  };

  const resolve = (exposerId: string): StorageExposer | undefined =>
    registered.get(exposerId) ?? implicitFor(exposerId);

  const temporaryCandidates = (): Candidate[] =>
    [...registered.values()]
      .filter((exposer): exposer is StorageExposer & { temporaryHosting: TemporaryHostingDeclaration } =>
        exposer.temporaryHosting !== undefined)
      .map((exposer) => ({
        exposer,
        declaration: exposer.temporaryHosting,
        priority: exposer.temporaryHosting.priority ?? DEFAULT_PRIORITY
      }));

  const configured = (candidate: Candidate): boolean => {
    try {
      return candidate.declaration.ready?.() ?? true;
    } catch {
      return false;
    }
  };

  const mediaKindOf = (facts: RequestFacts): string | undefined => {
    if (facts.mediaKind) return facts.mediaKind;
    const contentType = facts.contentType ?? "";
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/")) return "video";
    if (contentType.startsWith("audio/")) return "audio";
    return undefined;
  };

  /** 请求条件是否在该临时图床的声明范围内；`sizeBytes` 未知时只核对类型与有效窗口。 */
  const accepts = (candidate: Candidate, facts: RequestFacts): boolean => {
    if (!configured(candidate)) return false;
    if (facts.configurationOnly) return true;
    const constraints = candidate.declaration.constraints;
    const kind = mediaKindOf(facts);
    if (constraints?.mediaKinds && constraints.mediaKinds.length > 0) {
      // 未知类型不能冒充支持：声明了限制就必须有可核对的事实。
      if (!kind || !constraints.mediaKinds.includes(kind)) return false;
    }
    if (constraints?.maxBytes !== undefined && facts.sizeBytes !== undefined && facts.sizeBytes > constraints.maxBytes) return false;
    const validity = candidate.declaration.validitySeconds ?? FALLBACK_VALIDITY_SECONDS;
    if (facts.requiredValiditySeconds !== undefined && facts.requiredValiditySeconds > validity) return false;
    return true;
  };

  const sortCandidates = (list: Candidate[]): Candidate[] =>
    [...list].sort((left, right) =>
      left.priority - right.priority || left.exposer.exposerId.localeCompare(right.exposer.exposerId));

  const deriveFacts = async (input: StorageExposeInput): Promise<RequestFacts> => {
    const facts: RequestFacts = {
      ...(input.request?.mediaKind ? { mediaKind: input.request.mediaKind } : {}),
      ...(input.request?.contentType ? { contentType: input.request.contentType } : {}),
      ...(input.request?.sizeBytes === undefined ? {} : { sizeBytes: input.request.sizeBytes }),
      ...(input.request?.requiredValiditySeconds === undefined
        ? input.expiresSeconds === undefined ? {} : { requiredValiditySeconds: input.expiresSeconds }
        : { requiredValiditySeconds: input.request.requiredValiditySeconds }),
      ...(input.request?.signal ? { signal: input.request.signal } : {})
    };
    if (facts.mediaKind === undefined || facts.sizeBytes === undefined) {
      try {
        const stat = await storage.bucket(input.namespace, input.scope).head(input.key);
        if (stat) {
          if (facts.sizeBytes === undefined) facts.sizeBytes = stat.size;
          if (facts.contentType === undefined && stat.contentType) facts.contentType = stat.contentType;
        }
      } catch {
        // 读不到对象统计不阻塞配置面解析；真实缺失会在提供者读取或复制时显式失败。
      }
    }
    return facts;
  };

  type Route = {
    mode: "auto" | "manual" | "disabled";
    source: "canvas" | "manual" | "auto" | "none";
    id?: string;
    autoCandidate?: Candidate;
    error?: string;
  };

  const currentOverride = (namespace: string, scope?: StorageScope): string | undefined => {
    if (scope === undefined) return undefined;
    try {
      return storage.current(namespace, scope).exposure;
    } catch {
      // 主存储未就绪时不能让状态投影抛错：真实暴露会在提供者读写字节时显式失败。
      return undefined;
    }
  };

  const resolveRoute = (facts: RequestFacts, namespace: string, scope?: StorageScope): Route => {
    // 画布级覆盖优先：空串 = 这张画布明确不对外。
    const override = currentOverride(namespace, scope);
    if (override !== undefined) {
      const id = override.trim();
      return id === "" ? { mode: "disabled", source: "canvas", error: "这张画布未启用临时图床（画布存储形态的 exposure 为空）" }
        : { mode: "manual", source: "canvas", id };
    }
    const manual = selectedIdOf();
    if (manual) return { mode: "manual", source: "manual", id: manual };
    const candidates = sortCandidates(temporaryCandidates());
    const providers = candidates.filter(candidate => candidate.declaration.category === "provider" && accepts(candidate, facts));
    const builtins = candidates.filter(candidate => candidate.declaration.category === "builtin" && accepts(candidate, facts));
    const selected = providers[0] ?? builtins[0];
    return selected
      ? { mode: "auto", source: "auto", autoCandidate: selected, id: selected.exposer.exposerId }
      : { mode: "auto", source: "auto", error: "没有可用的临时图床，请检查提供商配置" };
  };

  const candidateView = (route: Route, facts: RequestFacts): TemporaryHostingCandidateView[] =>
    sortCandidates(temporaryCandidates()).map(candidate => ({
      exposerId: candidate.exposer.exposerId,
      label: candidate.exposer.label ?? candidate.exposer.exposerId,
      category: candidate.declaration.category,
      ownerExtensionId: candidate.exposer.ownerExtensionId ?? null,
      priority: candidate.priority,
      configured: configured(candidate),
      available: accepts(candidate, facts),
      selected: route.id === candidate.exposer.exposerId,
      lastError: lastFailure?.exposerId === candidate.exposer.exposerId ? lastFailure.message : null
    }));

  const recordFailure = (exposer: StorageExposer, error: unknown): void => {
    if (!exposer.temporaryHosting) return;
    lastFailure = { exposerId: exposer.exposerId, message: messageOf(error) };
    log({ event: "exposer-temporary-failed", exposerId: exposer.exposerId, message: messageOf(error) });
  };

  const requestInvalid = (error: unknown, signal?: AbortSignal): boolean => {
    if (signal?.aborted) return true;
    if (error instanceof Error && error.name === "AbortError") return true;
    if (isStorageObjectNotFoundError(error)) return true;
    const value = error as { code?: unknown; name?: unknown } | null | undefined;
    return value?.code === "STORAGE_OBJECT_NOT_FOUND" || value?.name === "StorageObjectNotFoundError"
      || value?.code === "MEDIA_OBJECT_NOT_FOUND" || value?.name === "MediaObjectNotFoundError"
      || value?.code === "STORAGE_EXPOSE_STALE";
  };

  const ensureLease = (exposer: StorageExposer, epoch: number | null): void => {
    const current = resolve(exposer.exposerId);
    if (!current || current.ownerExtensionId !== exposer.ownerExtensionId) {
      throw staleError("临时图床来源已撤销");
    }
    const now = current.temporaryHosting?.credentialEpoch?.() ?? null;
    if (now !== epoch) throw staleError("临时图床凭据已变化，请重试");
  };

  const run = async (exposer: StorageExposer, input: StorageExposeInput, epoch: number | null): Promise<string> => {
    if (input.request?.signal?.aborted) throw staleError("请求已取消");
    const current = resolve(exposer.exposerId);
    if (!current || current.ownerExtensionId !== exposer.ownerExtensionId || current.targetBackendId !== exposer.targetBackendId) {
      throw staleError("临时图床来源已撤销");
    }
    if (exposer.requiresReplica) {
      const targetId = exposer.targetBackendId ?? exposer.exposerId;
      const target = storage.resolve(targetId);
      if (!target) {
        throw new StorageExposeUnavailableError(`对外地址提供者未注册：${targetId}（设置 exposer.primary）`);
      }
      const scoped = `${input.namespace}/${input.key}`;
      if ((await target.head(scoped, input.scope)) === null) {
        const object = await storage.bucket(input.namespace, input.scope).get(input.key);
        await target.put(scoped, object.bytes, object.contentType ?? "application/octet-stream", input.scope);
        log({ event: "storage-expose-copy", namespace: input.namespace, backendId: targetId, size: object.bytes.byteLength });
      }
    }
    const url = await exposer.expose(input);
    ensureLease(exposer, epoch);
    if (lastFailure?.exposerId === exposer.exposerId) lastFailure = null;
    return url;
  };

  const exposeManual = async (id: string, input: StorageExposeInput): Promise<string> => {
    const exposer = resolve(id);
    if (!exposer) {
      // 区分「没注册」与「注册了但签不了」：两者的修法完全不同。
      if (storage.resolve(id)) {
        throw new StorageExposeUnavailableError(`对外存储后端 ${id} 没有签名能力：请在 exposer.primary 改选地址提供者`);
      }
      throw new StorageExposeUnavailableError(`临时图床提供者未注册：${id}（设置 exposer.primary）`);
    }
    const epoch = exposer.temporaryHosting?.credentialEpoch?.() ?? null;
    return run(exposer, input, epoch);
  };

  return {
    register(exposer) {
      if (registered.has(exposer.exposerId)) throw new Error(`对外地址提供者已注册：${exposer.exposerId}`);
      registered.set(exposer.exposerId, exposer);
      log({
        event: "exposer-registered",
        exposerId: exposer.exposerId,
        label: exposer.label,
        requiresReplica: exposer.requiresReplica,
        targetBackendId: exposer.targetBackendId,
        ...(exposer.temporaryHosting ? { temporaryCategory: exposer.temporaryHosting.category } : {})
      });
      return () => {
        if (registered.get(exposer.exposerId) === exposer) {
          registered.delete(exposer.exposerId);
          log({ event: "exposer-unregistered", exposerId: exposer.exposerId });
        }
      };
    },
    unregister(exposerId) {
      if (registered.delete(exposerId)) log({ event: "exposer-unregistered", exposerId });
    },
    list() {
      // 注册项在前（顺序即插件的注册顺序），隐式项补齐后端自带的能力。
      const out: StorageExposer[] = [...registered.values()];
      for (const backend of storage.list()) {
        if (registered.has(backend.backendId)) continue;
        const implicit = implicitFor(backend.backendId);
        if (implicit) out.push(implicit);
      }
      return out;
    },
    resolve,
    selectedId: selectedIdOf,
    available(namespace, scope, request) {
      const facts: RequestFacts = {
        configurationOnly: request === undefined,
        ...(request?.mediaKind ? { mediaKind: request.mediaKind } : {}),
        ...(request?.contentType ? { contentType: request.contentType } : {}),
        ...(request?.sizeBytes === undefined ? {} : { sizeBytes: request.sizeBytes }),
        ...(request?.requiredValiditySeconds === undefined ? {} : { requiredValiditySeconds: request.requiredValiditySeconds })
      };
      const route = resolveRoute(facts, namespace, scope);
      if (route.mode === "disabled" || route.error || !route.id) return false;
      const exposer = resolve(route.id);
      if (!exposer) return false;
      if (!exposer.temporaryHosting) return true;
      const candidate = temporaryCandidates().find(item => item.exposer.exposerId === route.id);
      return candidate ? accepts(candidate, facts) : true;
    },
    async expose(input: StorageExposeInput) {
      const facts = await deriveFacts(input);
      const route = resolveRoute(facts, input.namespace, input.scope);
      if (route.mode === "disabled") throw new StorageExposeUnavailableError(route.error);
      if (!route.id) throw new StorageExposeUnavailableError(route.error);

      if (route.mode === "manual") {
        try {
          return await exposeManual(route.id, input);
        } catch (error) {
          const exposer = resolve(route.id);
          if (exposer) recordFailure(exposer, error);
          throw error;
        }
      }

      // 自动模式：冻结来源身份与凭据 epoch，失败最多回退内置一次。
      const selected = route.autoCandidate!;
      const exposer = selected.exposer;
      const epoch = exposer.temporaryHosting?.credentialEpoch?.() ?? null;
      try {
        return await run(exposer, input, epoch);
      } catch (error) {
        recordFailure(exposer, error);
        if (requestInvalid(error, facts.signal)) throw error;
        const builtin = sortCandidates(temporaryCandidates())
          .find(candidate => candidate.declaration.category === "builtin" && accepts(candidate, facts));
        if (!builtin || builtin.exposer.exposerId === exposer.exposerId) throw error;
        log({ event: "exposer-temporary-fallback", from: exposer.exposerId, to: builtin.exposer.exposerId });
        const builtinEpoch = builtin.exposer.temporaryHosting?.credentialEpoch?.() ?? null;
        try {
          return await run(builtin.exposer, input, builtinEpoch);
        } catch (fallbackError) {
          recordFailure(builtin.exposer, fallbackError);
          throw new StorageExposeUnavailableError(
            `临时图床不可用：${exposer.exposerId}：${messageOf(error)}；${builtin.exposer.exposerId}：${messageOf(fallbackError)}`
          );
        }
      }
    },
    temporaryHosting(query?: TemporaryHostingQuery) {
      const facts: RequestFacts = {
        configurationOnly: query?.request === undefined,
        ...(query?.request?.mediaKind ? { mediaKind: query.request.mediaKind } : {}),
        ...(query?.request?.contentType ? { contentType: query.request.contentType } : {}),
        ...(query?.request?.sizeBytes === undefined ? {} : { sizeBytes: query.request.sizeBytes }),
        ...(query?.request?.requiredValiditySeconds === undefined ? {} : { requiredValiditySeconds: query.request.requiredValiditySeconds })
      };
      const route = resolveRoute(facts, query?.namespace ?? "media", query?.scope);
      const mode: TemporaryHostingRouteView["mode"] = route.mode;
      const selected = route.id ? resolve(route.id) : undefined;
      const manualError = route.mode === "manual" && !selected
        ? `临时图床提供者未注册：${route.id}`
        : undefined;
      return {
        mode,
        selectionSource: route.source,
        selectedId: route.mode === "disabled" ? null : route.id ?? null,
        candidates: candidateView(route, facts),
        error: route.error ?? manualError ?? null,
        lastFailure
      };
    }
  };
}

function staleError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = "StorageExposeStaleError";
  error.code = "STORAGE_EXPOSE_STALE";
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 核心层插件：提供 `ctx.exposer`。刻意不挂就绪检查（缺地址能力不该拖垮宿主）。 */
export const exposerPlugin: HostPlugin = {
  name: "exposer",
  inject: ["log", "config", "storage"],
  apply(ctx) {
    const log = ctx.log.scope("exposer");
    const readPrimary = (): string | undefined => {
      const next = ctx.config.get("exposer.primary");
      if (typeof next === "string" && next.trim() !== "") {
        const value = next.trim();
        const source = ctx.config.describe?.().find(entry => entry.key === "exposer.primary")?.source;
        // 产品/构建默认里表示「用内置」的 local-public 迁移为自动；用户文件、环境变量或封锁值
        // 里的显式 local-public 保留，不会被一律改写。只有缺省自动模式回读旧键；用户显式
        // 保存 auto 后必须能恢复自动，否则旧 storage.expose 会让面板的策略选择永远不生效。
        const auto = value === "auto" || (source === "default" && value === "local-public");
        if (auto && source !== undefined && source !== "default") return undefined;
        if (!auto) {
          // 历史遗留：这个键在拆分前存的是存储后端 id，部署里可能还留着 `local`——
          // 它永远签不出地址。按「未设置」处理，让自动路由接管；配置本身不改。
          const backend = ctx.storage.resolve(value);
          if (backend && !backend.presign) {
            log({ event: "exposer-primary-ignored", value, reason: "backend-cannot-sign" });
          } else {
            return value;
          }
        }
      }
      const legacy = ctx.config.get("storage.expose");
      return typeof legacy === "string" && legacy.trim() !== "" ? legacy.trim() : undefined;
    };
    const service = createExposerRegistry({
      settings: { expose: readPrimary },
      storage: ctx.storage,
      logger: log
    });
    ctx.provide("exposer", service);
  }
};
