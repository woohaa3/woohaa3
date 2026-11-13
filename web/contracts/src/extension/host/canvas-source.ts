/**
 * 类型化外部画布来源 capability 契约
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 1.2 / design D3）。
 *
 * 可信后端扩展通过 `host.registerCapability({ id: "canvas-source:<sourceId>", value })`
 * 注册一个 `CanvasSourceProvider`。Application 宿主校验 capability 形状、唯一 owner、配置
 * 版本与依赖；Backend 的受控来源调用桥只能经 Application 的版本化 dispatch 调用它，**不**
 * 裸取 `resolveCapability()` 后长期缓存（停用/配置版本检查会被绕过）。
 *
 * 本模块是纯类型 + 形状校验，**不含**旧 Mongo/旧 SQLite/旧 Y.Doc/驱动/目标数据库形状。
 * `readSnapshot` 属于扩展内部实现，不穿过公共 capability 边界。
 */
import { isJsonObject, isNonNegativeInteger, isBoundedId } from "../../validation.js";
import type { CanvasImportCandidate, CanvasSourceReadiness } from "../../canvas/preparation.js";
import type { CanvasSourceListPage, CanvasSourceRef } from "../../canvas/source.js";

/** 可信调用上下文：主体来自宿主认证/身份映射，绝不来自请求 body 或来源卡片缓存。 */
export type CanvasSourceTrustedContext = {
  subject: string;
  extensionId: string;
  configVersion: number;
  correlationId?: string;
  signal?: AbortSignal;
};

/** 来源自己的稳定 cursor 分页请求。 */
export type CanvasSourceListInput = {
  context: CanvasSourceTrustedContext;
  cursor: string | null;
  limit: number;
};

/** prepare 候选请求：先解析主体与旧 ACL，再在扩展内部读取快照并转换。 */
export type CanvasSourcePrepareInput = {
  context: CanvasSourceTrustedContext;
  ref: CanvasSourceRef;
};

/**
 * 解析单个来源作品的可访问性（含来源 ACL）：返回主体可见的摘要与水位，供 Canvas 建立绑定。
 * 主体不可见时返回 `FORBIDDEN`，**不**区分「不存在」与「无权限」（不泄露存在性）。
 */
export type CanvasSourceResolveInput = {
  context: CanvasSourceTrustedContext;
  ref: CanvasSourceRef;
};

export type CanvasSourceResolvedHandle = {
  ref: CanvasSourceRef;
  targetCanvasId: string;
  title: string;
  /** 来源水位；进入 binding，提交前再验。 */
  sourceVersion: string;
};

export type CanvasSourceResolveResult =
  | { ok: true; handle: CanvasSourceResolvedHandle }
  | { ok: false; code: string; retryable: boolean; message: string };

/** 提交前再验：确认冻结代次、来源水位、权限版本仍匹配。 */
export type CanvasSourceValidateInput = {
  context: CanvasSourceTrustedContext;
  binding: CanvasImportCandidate["binding"];
};

export type CanvasSourcePrepareResult =
  | { ok: true; candidate: CanvasImportCandidate }
  | { ok: false; code: string; retryable: boolean; message: string };

/**
 * 外部画布来源 provider capability。
 *
 * 一个 sourceId 只能有一个活动 owner；注册冲突使 activation 回滚（由 Application 保证）。
 */
export type CanvasSourceProvider = {
  readonly sourceId: string;
  readonly extensionId: string;
  /** 转换算法版本；进入 binding，不得替代目标 revision。 */
  readonly converterVersion: string;
  listAccessible(input: CanvasSourceListInput): Promise<CanvasSourceListPage>;
  /** 解析单个来源作品可访问性（含来源 ACL）；不可见返回 FORBIDDEN。 */
  resolveAccessible(input: CanvasSourceResolveInput): Promise<CanvasSourceResolveResult>;
  prepareCandidate(input: CanvasSourcePrepareInput): Promise<CanvasSourcePrepareResult>;
  validateSnapshot(input: CanvasSourceValidateInput): Promise<CanvasSourceReadiness>;
};

/**
 * 形状校验：Application 在登记 capability 与执行受控调用前都调用它，拒绝半成品/伪造实现。
 *
 * 只检查可调用性与声明的稳定字符串字段；具体实现返回的错误形状由调用方再校验。
 */
export function isCanvasSourceProviderShape(value: unknown): value is CanvasSourceProvider {
  if (!isJsonObject(value)) return false;
  return (
    isBoundedId(value.sourceId, 120) &&
    isBoundedId(value.extensionId, 120) &&
    isBoundedId(value.converterVersion, 120) &&
    typeof value.listAccessible === "function" &&
    typeof value.resolveAccessible === "function" &&
    typeof value.prepareCandidate === "function" &&
    typeof value.validateSnapshot === "function"
  );
}

export function isCanvasSourceTrustedContext(value: unknown): value is CanvasSourceTrustedContext {  if (!isJsonObject(value)) return false;
  return (
    isBoundedId(value.subject, 200) &&
    isBoundedId(value.extensionId, 120) &&
    isNonNegativeInteger(value.configVersion)
  );
}
