/**
 * 转换模型提供方（capability）契约
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.1 / design D6）。
 *
 * 拥有执行器的扩展（ChatGPT、语言 Provider）通过这个**公共 capability** 暴露：
 * - 可用的转换模型与其声明的能力（供服务端门禁与前端摘要）；
 * - 用注入的媒体读取端口构造生成端口。
 *
 * 这样 Canvas 权威服务与统一后端**不 import 任何扩展私有实现**，也不按业务 ID 分支；每个
 * Provider 的能力与模型身份仍由拥有执行器的扩展声明。纯类型 + 形状校验，不含 provider SDK。
 */
import type { FilmSetConversionAdapterCapabilities } from "./capabilities.js";
import type { FilmSetConversionGenerator, FilmSetConversionMediaReader } from "./generator.js";
import type { FilmSetConversionSourceKind } from "./types.js";

/** capability id 前缀：`film-set-conversion:<providerId>`。 */
export const FILM_SET_CONVERSION_CAPABILITY_PREFIX = "film-set-conversion:";

/** 一个可用的转换模型候选（能力已由提供方声明）。 */
export type FilmSetConversionModelCandidate = {
  assistant?: { adapterId: string; model: string };
  /** 稳定模型身份（`<providerId>:<providerModelId>`）。 */
  modelKey: string;
  /** 展示名（前端摘要用）。 */
  label: string;
  capabilities: FilmSetConversionAdapterCapabilities;
  /** 该模型是否能承担某来源种类（提供方自己的判定，与服务端门禁同源）。 */
  supports: readonly FilmSetConversionSourceKind[];
  /** 是否为该 Provider 的默认模型。 */
  isDefault?: boolean;
};

/** 转换模型提供方 capability。 */
export type FilmSetConversionProvider = {
  /** 提供方身份（与 capability id 的 `<providerId>` 一致）。 */
  readonly providerId: string;
  /** Trusted mapping to the conversation adapter; never inferred from a provider/model prefix. */
  readonly assistantAdapterId?: string;
  /** 当前可用候选（已按凭据/授权就绪裁剪；未配置返回空数组）。 */
  listModels(): readonly FilmSetConversionModelCandidate[];
  /**
   * 解析本次实际使用的模型与能力（服务端门禁用）。
   *
   * `modelKey` 缺省时按明确默认选择该来源的候选；无候选返回 `null`（能力未知 → 不开放一键调用）。
   * 返回的 `modelKey` 被冻结为本次尝试模型身份。
   */
  resolveCapabilities(input: {
    modelKey?: string;
    sourceKind: FilmSetConversionSourceKind;
  }): { modelKey: string; capabilities: FilmSetConversionAdapterCapabilities } | null;
  /** 用注入的媒体读取端口构造生成端口；该 Provider 无法承担来源时返回 `null`。 */
  createGenerator(input: { media: FilmSetConversionMediaReader }): FilmSetConversionGenerator | null;
  /**
   * 解析「本次转换用哪个 owner（个人授权账户）」——由宿主在 **HTTP 边界**调用。
   *
   * 提供方拥有自己的 owner 规则（如 ChatGPT：有应用登录时用 `principal:<subject>`；无登录的
   * 本地开发姿态用受控本地会话 `local:<id>`，与 `/api/oauth-agent/*` 同源）。宿主把结果作为
   * `ownerId` 传给生成端口，**不让浏览器自报身份**。无法解析返回 `null`（回退到生成端自身边界）。
   *
   * `subject` 是宿主认证适配器解析的可信主体；`cookie` 是本次请求的 Cookie 头（本地会话用）。
   */
  resolveOwner?(input: { subject?: string; cookie?: string }): FilmSetConversionOwner | null;
};

/** 宿主边界解析出的转换 owner（含提供方前缀，如 `principal:` / `local:`）。 */
export type FilmSetConversionOwner = {
  ownerId: string;
  /** 新建本地会话时需要下发的 `Set-Cookie`（宿主写入本次响应）。 */
  setCookie?: string;
};


/** capability id 构造。 */
export function filmSetConversionCapabilityId(providerId: string): string {
  return `${FILM_SET_CONVERSION_CAPABILITY_PREFIX}${providerId}`;
}

/** 是否为转换提供方 capability id。 */
export function isFilmSetConversionCapabilityId(id: string): boolean {
  return id.startsWith(FILM_SET_CONVERSION_CAPABILITY_PREFIX) && id.length > FILM_SET_CONVERSION_CAPABILITY_PREFIX.length;
}

/** 从 capability id 读取 `<providerId>`；非法返回 null。 */
export function filmSetConversionProviderIdFromCapabilityId(id: string): string | null {
  return isFilmSetConversionCapabilityId(id) ? id.slice(FILM_SET_CONVERSION_CAPABILITY_PREFIX.length) : null;
}

/** 形状校验：宿主登记 capability 与受控调用前都调用它，拒绝半成品/伪造实现。 */
export function isFilmSetConversionProviderShape(value: unknown): value is FilmSetConversionProvider {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const provider = value as Record<string, unknown>;
  return (
    typeof provider.providerId === "string" && provider.providerId.trim() !== "" &&
    typeof provider.listModels === "function" &&
    typeof provider.resolveCapabilities === "function" &&
    typeof provider.createGenerator === "function" &&
    (provider.resolveOwner === undefined || typeof provider.resolveOwner === "function")
  );
}
