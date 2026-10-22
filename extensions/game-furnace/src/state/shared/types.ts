/**
 * 游戏炼丹炉共享契约：identity、预算常量、素材类别与逻辑 schema 类型
 * （change: 2026-10-10-add-game-furnace-extension，任务 1.1–1.5 / design D2/D4/D5/D7）。
 *
 * 纯类型与常量叶子：不 import 宿主 store、Provider、数据库、DOM 或 Node API。由
 * `../shared.js` barrel 统一再导出；浏览器、Canvas 权威服务与后端共享同一份定义。
 */
import type { Woohaa3CanvasJsonObject } from "@woohaa3/contracts";

/** 插件 identity（共享契约的稳定键）。 */
export const GAME_FURNACE_PLUGIN_ID = "game-furnace";
export const GAME_FURNACE_SCHEMA_VERSION = 1;
/** 前端菜单/工作区展示名。 */
export const GAME_FURNACE_LABEL = "游戏炼丹炉";

// ---------------------------------------------------------------------------
// 预算（D7；前后端一致，UI 不得放宽）
// ---------------------------------------------------------------------------

/** 项目最多资源数。 */
export const MAX_RESOURCES = 128;
/** 名称长度上限。 */
export const MAX_NAME_LENGTH = 200;
/** 分类长度上限。 */
export const MAX_CATEGORY_LENGTH = 80;
/** 单项描述 / 每段需求长度上限。 */
export const MAX_DESCRIPTION_LENGTH = 12_000;
/** 生成输入 prompt 建议字符上限，并服从模型上下文限制（D7/D8）。 */
export const MAX_PROMPT_CHARS = 180_000;
/**
 * 文本素材 inline 快照字符上限（D4/D7）。超过时保留不可变 source asset 引用并标记
 * `overBudget`，不把截断后的文本声称成完整原件。
 */
export const MAX_INLINE_TEXT_CHARS = 12_000;
/**
 * 非文本素材（模型/导演场/opaque）inline 快照字符预算（D4/D7）。超过时**保留完整内容**
 * 并标记 `overBudget`，供 UI/LLM 明确标识为需转存摘要，绝不静默截断。
 */
export const MAX_INLINE_SNAPSHOT_CHARS = 32_000;
/** 模型输出 HTML 建议字节上限（1 MiB）。 */
export const MAX_GAME_HTML_BYTES = 1024 * 1024;
/** 源码包建议字节上限（2 MiB）。 */
export const MAX_SOURCE_PACKAGE_BYTES = 2 * 1024 * 1024;
/** build 引用资源数上限。 */
export const MAX_BUILD_DEPENDENCIES = 128;
/** 单项目保留的 generation 记录上限（保留/分页策略；不在状态里无限增长）。 */
export const MAX_GENERATIONS = 64;
/** 单项目保留的 build 记录上限。 */
export const MAX_BUILDS = 64;

/** 生成策略版本：输入编译 / 输出协议的稳定键；变化会使 inputHash 失效。 */
export const GAME_POLICY_VERSION = "game-furnace/v1";

// ---------------------------------------------------------------------------
// 素材类别
// ---------------------------------------------------------------------------

export type GameResourceKind =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "model"
  | "film-set"
  | "container"
  | "unknown";

export const GAME_RESOURCE_KINDS: readonly GameResourceKind[] = [
  "image",
  "video",
  "audio",
  "text",
  "model",
  "film-set",
  "container",
  "unknown"
];

/** 默认分类字符串（可编辑；重名不覆盖素材）。 */
export const DEFAULT_CATEGORY_BY_KIND: Readonly<Record<GameResourceKind, string>> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本",
  model: "3D 模型",
  "film-set": "导演场",
  container: "扩展素材",
  unknown: "其他素材"
};

/** 推荐用途（仅作提示，不强制建立分类树）。 */
export const RECOMMENDED_USES: readonly string[] = ["角色", "场景", "道具", "UI", "音乐", "音效", "规则"];

// ---------------------------------------------------------------------------
// 项目数据（D7 逻辑 schema）
// ---------------------------------------------------------------------------

export type GameResourceSource = {
  canvasId: string;
  nodeId: string;
  sourceContentHash: string;
};

export type GameResourceMetadata = {
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  previewAssetId?: string;
  storageKey?: string;
};

/** 冻结的依赖媒体；读取和导出不再依赖来源画布的 asset 表。 */
export type GameResourceAsset = { assetId: string; storageKey: string; mime: string; size?: number };

export type GameResourcePayload = {
  kind: "asset" | "text" | "model" | "scene" | "opaque";
  /** 规范快照（有界）；asset 类素材可省略。 */
  snapshot?: Woohaa3CanvasJsonObject;
  assetIds: string[];
  assets?: GameResourceAsset[];
};

export type GameResource = {
  resourceId: string;
  kind: GameResourceKind;
  name: string;
  category: string;
  description: string;
  source?: GameResourceSource;
  payload: GameResourcePayload;
  metadata?: GameResourceMetadata;
};

export type GameRequirements = {
  name: string;
  description: string;
  gameplay?: string;
  modelKey?: string;
};

export type GameGeneration = {
  /** 复制的历史记录不再关联任何 Task；保留模型/Agent 来源用于展示。 */
  executionDetached?: true;
  /** Agent 提交是源码编译工作，不对应站点模型 Task。 */
  origin?: "agent" | "model";
  generationId: string;
  workerTaskKey: string;
  inputHash: string;
  inputManifestAssetId?: string;
  workId?: string;
  pluginConfigVersion?: number;
  admittedAt: string;
  candidateBuildId?: string;
  disposition?: "candidate" | "active" | "discarded" | "failed" | "cancelled";
  lastSafeDiagnostic?: string;
};

export type GameBuild = {
  buildId: string;
  generationId: string;
  inputHash: string;
  manifestAssetId: string;
  sourceAssetId: string;
  dependencyAssetIds: string[];
  sourceHash: string;
  policyVersion: string;
  createdAt: string;
  title: string;
  controlsSummary: string;
  /** 参与的素材归属：used / reference-only / unused（不得声称全部融合）。 */
  resources: { resourceId: string; usage: "used" | "reference-only" | "unused" }[];
};

export type GameFurnaceState = Woohaa3CanvasJsonObject & {
  projectId: string;
  projectOwner?: { canvasId: string; nodeId: string };
  resources: GameResource[];
  requirements: GameRequirements;
  generations: GameGeneration[];
  builds: GameBuild[];
  latestGenerationId?: string;
  activeBuildId?: string;
};

/** 素材输入（规范化前的宽松形态）。 */
export type GameResourceInput = {
  resourceId: string;
  kind: GameResourceKind;
  name: string;
  category?: string;
  description?: string;
  source?: GameResourceSource;
  payload: GameResourcePayload;
  metadata?: GameResourceMetadata;
};

export type GameResourceUsability = {
  usage: "used" | "reference-only" | "unused";
  reason?: string;
};
