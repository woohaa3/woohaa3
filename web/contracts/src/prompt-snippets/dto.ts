/**
 * 提示词片段目录跨运行单元契约
 * （change: add-prompt-snippet-library，任务 1.1 / design D2/D3/D4）。
 *
 * 无副作用纯 DTO 与校验：不依赖 React / DOM / 数据库 / Yjs。Frontend、Canvas Service
 * 与测试共用同一份形状与稳定错误码。
 *
 * 关键语义：
 * - 片段正文是 token 化字符串，token 的 identity 字段解释为**片段局部 material key**，
 *   绝非画布 input `slotId`（design D3）；
 * - material 快照只保存稳定身份与显示信息，绝不保存 object/data/签名/外部 URL 或 Blob；
 * - 创建用 `operationId` 幂等，更新/标签重命名用 `revision` 乐观并发。
 */
import { looksLikeRemoteUrl, isValidStorageKey } from "../validation.js";

export const PROMPT_SNIPPET_FORMAT_VERSION = 1 as const;

/** 片段局部 material key；`material-1` 形式，稳定且在同一片段内唯一。 */
export const PROMPT_SNIPPET_MATERIAL_KEY_PATTERN = /^material-[a-z0-9][a-z0-9_-]*$/i;

export type PromptSnippetMediaKind = "image" | "video" | "audio" | "text";

type PromptSnippetMaterialBase = {
  /** 片段局部 key；正文 token 的 identity 字段必须是它。 */
  key: string;
  label: string;
};

export type PromptSnippetMediaMaterial = PromptSnippetMaterialBase & {
  mediaKind: "image" | "video" | "audio";
  /** 捕获时当前画布的稳定 asset 身份；跨画布不保证存在。 */
  assetId: string;
  /** 稳定内容寻址键（`sha256-<64hex>` 或 `generation-outputs/...`）。 */
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
};

export type PromptSnippetTextMaterial = PromptSnippetMaterialBase & {
  mediaKind: "text";
  assetId: string;
  /** 受长度限制的文本快照。 */
  text: string;
};

export type PromptSnippetMaterial = PromptSnippetMediaMaterial | PromptSnippetTextMaterial;

export type PromptSnippetTag = {
  id: string;
  /** 规范化后的展示名（去除首尾空白、压缩内部空白）。 */
  name: string;
  builtIn: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type PromptSnippet = {
  id: string;
  formatVersion: number;
  builtIn: boolean;
  name: string;
  /** 受长度限制的 token 化正文。 */
  body: string;
  materials: PromptSnippetMaterial[];
  tagIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** 目录筛选：全部 / 内置 / 无标签 / 单个自定义标签。 */
export type PromptSnippetFilter = "all" | "builtIn" | "untagged" | "tag";

export type PromptSnippetListQuery = {
  query?: string;
  filter?: PromptSnippetFilter;
  tagId?: string;
  cursor?: string;
  limit?: number;
};

export type PromptSnippetListResult = {
  items: PromptSnippet[];
  /** 下一页游标；无更多时为 null。 */
  nextCursor: string | null;
  total: number;
};

export type PromptSnippetTagListResult = {
  items: Array<PromptSnippetTag & { snippetCount: number }>;
};

/** 所有最终进入 Canvas Service 的片段目录协议的错误码（跨进程稳定契约）。 */
export const PROMPT_SNIPPET_ERROR_CODES = [
  "SNIPPET_NOT_FOUND",
  "SNIPPET_NAME_CONFLICT",
  "SNIPPET_READ_ONLY",
  "TAG_NOT_FOUND",
  "TAG_NAME_CONFLICT",
  "SNIPPET_INVALID",
  "SNIPPET_OPERATION_CONFLICT",
  "SNIPPET_REVISION_CONFLICT"
] as const;

export type PromptSnippetErrorCode = (typeof PROMPT_SNIPPET_ERROR_CODES)[number];

export function isPromptSnippetErrorCode(value: unknown): value is PromptSnippetErrorCode {
  return typeof value === "string" && (PROMPT_SNIPPET_ERROR_CODES as readonly string[]).includes(value);
}

export const PROMPT_SNIPPET_LIMITS = {
  maxNameLength: 120,
  maxBodyLength: 20_000,
  maxTextMaterialLength: 4_000,
  maxMaterials: 32,
  maxTags: 16,
  defaultPageSize: 30,
  maxPageSize: 100
} as const;

/** 名称规范化：去除首尾空白并压缩内部空白；用于大小写无关唯一性判定。 */
export function normalizePromptSnippetName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed === "" || collapsed.length > PROMPT_SNIPPET_LIMITS.maxNameLength) return null;
  return collapsed;
}

/** 大小写无关的目录内唯一键。 */
export function promptSnippetNameKey(normalizedName: string): string {
  return normalizedName.toLocaleLowerCase();
}

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: PromptSnippetErrorCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 校验单个 material 快照：拒绝任意 URL/Blob/data/签名 URL 与重复 key。 */
export function decodePromptSnippetMaterial(input: unknown): DecodeResult<PromptSnippetMaterial> {
  if (!isRecord(input)) return invalid("material 必须是对象");
  const key = input.key;
  const label = input.label;
  const mediaKind = input.mediaKind;
  if (!isNonEmptyString(key) || !PROMPT_SNIPPET_MATERIAL_KEY_PATTERN.test(key)) {
    return invalid("material key 形态非法");
  }
  if (typeof label !== "string" || label.length > 200) return invalid("material label 非法");
  if (mediaKind === "text") {
    const assetId = input.assetId;
    const text = input.text;
    if (!isNonEmptyString(assetId)) return invalid("文本 material 缺少 assetId");
    if (typeof text !== "string" || text.length > PROMPT_SNIPPET_LIMITS.maxTextMaterialLength) {
      return invalid("文本 material 超长");
    }
    return { ok: true, value: { key, mediaKind, assetId, label, text } };
  }
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") {
    return invalid("material mediaKind 非法");
  }
  const assetId = input.assetId;
  const storageKey = input.storageKey;
  const checksum = input.checksum;
  const contentType = input.contentType;
  const size = input.size;
  if (!isNonEmptyString(assetId)) return invalid("media material 缺少 assetId");
  if (!isValidStorageKey(storageKey) || looksLikeRemoteUrl(storageKey)) {
    return invalid("media material storageKey 非法");
  }
  if (!isNonEmptyString(checksum) || /[^0-9a-f]/i.test(checksum)) return invalid("media material checksum 非法");
  if (!isNonEmptyString(contentType) || looksLikeRemoteUrl(contentType)) return invalid("media material contentType 非法");
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return invalid("media material size 非法");
  return { ok: true, value: { key, mediaKind, assetId, storageKey, checksum, contentType, size, label } };
}

/** 校验片段（含 material key 唯一性）；正文-清单双向一致性由 codec 另行校验。 */
export function decodePromptSnippet(input: unknown): DecodeResult<PromptSnippet> {
  if (!isRecord(input)) return invalid("snippet 必须是对象");
  const id = input.id;
  if (!isNonEmptyString(id)) return invalid("snippet 缺少 id");
  const name = normalizePromptSnippetName(input.name);
  if (!name) return invalid("snippet 名称非法");
  const body = input.body;
  if (typeof body !== "string" || body.length > PROMPT_SNIPPET_LIMITS.maxBodyLength) {
    return invalid("snippet 正文非法或超长");
  }
  const builtIn = input.builtIn === true;
  const formatVersion = typeof input.formatVersion === "number" ? input.formatVersion : PROMPT_SNIPPET_FORMAT_VERSION;
  const revision = input.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return invalid("snippet revision 非法");
  const createdAt = input.createdAt;
  const updatedAt = input.updatedAt;
  if (!isNonEmptyString(createdAt) || !isNonEmptyString(updatedAt)) return invalid("snippet 时间戳非法");
  if (!Array.isArray(input.materials)) return invalid("snippet materials 必须是数组");
  if (!Array.isArray(input.tagIds)) return invalid("snippet tagIds 必须是数组");
  const materials: PromptSnippetMaterial[] = [];
  const keys = new Set<string>();
  for (const raw of input.materials) {
    const decoded = decodePromptSnippetMaterial(raw);
    if (!decoded.ok) return decoded;
    if (keys.has(decoded.value.key)) return invalid(`material key 重复：${decoded.value.key}`);
    keys.add(decoded.value.key);
    materials.push(decoded.value);
  }
  const tagIds = input.tagIds.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  return {
    ok: true,
    value: { id, formatVersion, builtIn, name, body, materials, tagIds, revision, createdAt, updatedAt }
  };
}

/** 解码列表查询（分页/筛选/搜索）；非法值回落为默认。 */
export function decodePromptSnippetListQuery(input: unknown): PromptSnippetListQuery {
  const record = isRecord(input) ? input : {};
  const filterRaw = record.filter;
  const filter: PromptSnippetFilter =
    filterRaw === "builtIn" || filterRaw === "untagged" || filterRaw === "tag" ? filterRaw : "all";
  const limitRaw = record.limit;
  const limit = typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, PROMPT_SNIPPET_LIMITS.maxPageSize)
    : PROMPT_SNIPPET_LIMITS.defaultPageSize;
  const query = typeof record.query === "string" ? record.query.slice(0, 200) : undefined;
  const tagId = typeof record.tagId === "string" && record.tagId !== "" ? record.tagId : undefined;
  const cursor = typeof record.cursor === "string" && record.cursor !== "" ? record.cursor : undefined;
  return { filter, limit, ...(query ? { query } : {}), ...(tagId ? { tagId } : {}), ...(cursor ? { cursor } : {}) };
}

function invalid(message: string): { ok: false; code: PromptSnippetErrorCode; message: string } {
  return { ok: false, code: "SNIPPET_INVALID", message };
}
