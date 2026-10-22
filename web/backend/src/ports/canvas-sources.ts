/**
 * 受控来源调用桥（Backend 侧）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 3.2、3.5、3.6 / design D3、D10）。
 *
 * 把 Canvas 的窄端口 `CanvasSourcePort` 落地到 Application 的受控来源注册表：
 * - **每次调用**用 `registry.resolve(sourceId)` 取得版本绑定 handle，并通过
 *   `assertBoundContext` 以 owner+configVersion 再校验（停用/升级立即生效；不裸缓存 capability）；
 * - 主体只来自宿主认证注入（`subject`），来源身份映射在扩展内部完成；
 * - 只向 Canvas 暴露平台 DTO，不透出旧 JSON/驱动/路径/URI。
 *
 * 本文件不 import 任何扩展实现，只依赖 Application 的注册表接口与平台契约。
 */
import type { CanvasSourceRegistry } from "@woohaa3/application-service";
import type {
  CanvasImportCandidate,
  CanvasImportErrorCode,
  CanvasSourceBinding,
  CanvasSourceCatalogEntry
} from "@woohaa3/contracts";
import type { CanvasSourcePort } from "@woohaa3/canvas-service";

/** 注册表解析出的活动来源目录条目。 */
type ActivityCatalogEntry = { sourceId: string; extensionId: string; configVersion: number };

export type CanvasSourceBridgeOptions = {
  /** 懒解析 Application（Canvas 先于 Application 创建）。 */
  registry: () => CanvasSourceRegistry | null;
  /** 活动来源展示名解析（缺省用 sourceId）。 */
  displayName?: (sourceId: string) => string;
  logger?: (event: Record<string, unknown>) => void;
};

export function createCanvasSourceBridge(options: CanvasSourceBridgeOptions): CanvasSourcePort {
  const log = options.logger ?? (() => undefined);

  const listSources = async (): Promise<CanvasSourceCatalogEntry[]> => {
    const registry = options.registry();
    if (!registry) return [];
    try {
      return registry.list().map((owner) => ({
        sourceId: owner.sourceId,
        displayName: options.displayName?.(owner.sourceId) ?? owner.sourceId,
        availability: owner.mode === "public" ? "available" : "unavailable"
      }));
    } catch (error) {
      log({ event: "canvas-source-list-failed", message: String(error) });
      return [];
    }
  };

  const listAccessible: CanvasSourcePort["listAccessible"] = async (input) => {
    const registry = options.registry();
    if (!registry) return { items: [], nextCursor: null };
    const resolved = registry.resolve(input.sourceId);
    if (!resolved.ok) {
      log({ event: "canvas-source-resolve-failed", code: resolved.code });
      return { items: [], nextCursor: null };
    }
    const context = contextFor(resolved.handle, input.subject);
    return await resolved.handle.provider.listAccessible({ context, cursor: input.cursor, limit: input.limit });
  };

  const resolveAccessible: CanvasSourcePort["resolveAccessible"] = async (input) => {
    const registry = options.registry();
    if (!registry) return { ok: false, code: "SOURCE_UNAVAILABLE", message: "来源未启用" };
    const owners = registry.list();
    const candidates: ActivityCatalogEntry[] = input.sourceId
      ? owners.filter((owner) => owner.sourceId === input.sourceId)
      : owners;
    if (candidates.length === 0) {
      return { ok: false, code: "SOURCE_UNAVAILABLE", message: "没有可用来源" };
    }
    if (candidates.length > 1) {
      return { ok: false, code: "SOURCE_AMBIGUOUS", message: "多个来源命中，请显式指定 sourceId" };
    }
    const owner = candidates[0]!;
    const resolved = registry.resolve(owner.sourceId);
    if (!resolved.ok) return { ok: false, code: resolved.code === "FORBIDDEN" ? "FORBIDDEN" : "SOURCE_UNAVAILABLE", message: resolved.message };
    const context = contextFor(resolved.handle, input.subject);
    const result = await resolved.handle.provider.resolveAccessible({
      context,
      ref: { sourceId: owner.sourceId, sourceCanvasId: input.sourceCanvasId, cutoverGeneration: "" }
    });
    if (!result.ok) {
      return { ok: false, code: result.code === "FORBIDDEN" ? "FORBIDDEN" : classifyCode(result.code), message: result.message };
    }
    const binding: Omit<CanvasSourceBinding, "sourceVersion"> = {
      sourceId: result.handle.ref.sourceId,
      sourceCanvasId: result.handle.ref.sourceCanvasId,
      cutoverGeneration: result.handle.ref.cutoverGeneration,
      extensionId: resolved.handle.owner.extensionId,
      configVersion: resolved.handle.owner.configVersion,
      converterVersion: resolved.handle.provider.converterVersion
    };
    return {
      ok: true,
      handle: {
        binding,
        sourceVersion: result.handle.sourceVersion,
        targetCanvasId: result.handle.targetCanvasId,
        title: result.handle.title
      }
    };
  };

  const prepareCandidate: CanvasSourcePort["prepareCandidate"] = async (input) => {
    const registry = options.registry();
    if (!registry) return { ok: false, code: "SOURCE_UNAVAILABLE", retryable: false, message: "来源未启用" };
    const resolved = registry.resolve(input.handle.binding.sourceId);
    if (!resolved.ok) return { ok: false, code: resolved.code === "FORBIDDEN" ? "FORBIDDEN" : "SOURCE_UNAVAILABLE", retryable: false, message: resolved.message };
    const bound = registry.assertBoundContext(resolved.handle, {
      subject: input.subject,
      extensionId: input.handle.binding.extensionId,
      configVersion: input.handle.binding.configVersion
    });
    if (!bound.ok) return { ok: false, code: "FORBIDDEN", retryable: true, message: bound.message };
    const context = contextFor(resolved.handle, input.subject);
    const result = await resolved.handle.provider.prepareCandidate({
      context,
      ref: {
        sourceId: input.handle.binding.sourceId,
        sourceCanvasId: input.handle.binding.sourceCanvasId,
        cutoverGeneration: input.handle.binding.cutoverGeneration
      }
    });
    if (!result.ok) return { ok: false, code: classifyCode(result.code), retryable: result.retryable, message: result.message };
    return { ok: true, candidate: result.candidate };
  };

  const validateSnapshot: CanvasSourcePort["validateSnapshot"] = async (input) => {
    const registry = options.registry();
    if (!registry) return { ok: false, code: "SOURCE_UNAVAILABLE", retryable: false, message: "来源未启用" };
    const resolved = registry.resolve(input.binding.sourceId);
    if (!resolved.ok) return { ok: false, code: resolved.code === "FORBIDDEN" ? "FORBIDDEN" : "SOURCE_UNAVAILABLE", retryable: false, message: resolved.message };
    const bound = registry.assertBoundContext(resolved.handle, {
      subject: input.subject,
      extensionId: input.binding.extensionId,
      configVersion: input.binding.configVersion
    });
    if (!bound.ok) return { ok: false, code: "FORBIDDEN", retryable: true, message: bound.message };
    const context = contextFor(resolved.handle, input.subject);
    const result = await resolved.handle.provider.validateSnapshot({ context, binding: input.binding });
    if (!result.ok) return { ok: false, code: classifyCode(result.code), retryable: result.retryable, message: result.message };
    return { ok: true };
  };

  return { listSources, listAccessible, resolveAccessible, prepareCandidate, validateSnapshot };
}

function contextFor(handle: { owner: { extensionId: string; configVersion: number } }, subject: string) {
  return { subject, extensionId: handle.owner.extensionId, configVersion: handle.owner.configVersion };
}

/** 把扩展返回的字符串码收敛到平台错误码集合；未知归为 SOURCE_UNAVAILABLE。 */
function classifyCode(code: string): CanvasImportErrorCode {
  switch (code) {
    case "FORBIDDEN":
    case "SOURCE_UNAVAILABLE":
    case "SOURCE_CHANGED":
    case "SOURCE_AMBIGUOUS":
    case "UNSUPPORTED_SOURCE_FORMAT":
    case "TARGET_CONFLICT":
    case "MEDIA_MISSING":
    case "CANDIDATE_INVALID":
    case "LIMIT_EXCEEDED":
      return code;
    default:
      return "SOURCE_UNAVAILABLE";
  }
}

export type { CanvasImportCandidate };
