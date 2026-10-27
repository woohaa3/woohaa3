import { DEFAULT_MEDIA_TIME_MAP, type ModelMediaTimeMap } from "../../../../../../contracts/src/canvas/media-time.js";
/**
 * 片场内部内容契约：类型、常量与守卫
 * （自 `film-set-content.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R19）。
 *
 * 纯类型/常量叶子模块，无任何解码器依赖。`FilmSetContent` 集合是片场身份的一部分，参与
 * 保存、复制、历史与资产引用保护；不借用通用 envelope 或任何 opaque plugin state。
 */
import type { ModelDefinition } from "../../../../../../contracts/src/canvas/model-definition.js";
import type { MotionDefinition } from "../../../../../../contracts/src/canvas/motion-script.js";

/**
 * 片场内容契约版本；结构变化必须升版本。
 *
 * - schema 3 = items-only（几何只在 items，动作只在片段 binding）；
 * - schema 4 = 在 schema 3 之上显式声明**场景单位**语义：items 的 localTransform/尺寸、媒体
 *   尺寸与镜头（`sceneCamera` / 片段 `initialCamera` distance、`focusOffset`、镜头运动）全部
 *   使用同一场景空间单位，画布节点矩形与 viewport 只控制呈现
 *   （change: 2026-10-23-isolate-film-set-camera-space，design D1/D5）。
 *
 * 旧客户端严格拒绝非 schema 3，因此版本升级本身就是拒绝门禁：不能只加一个旧客户端会忽略的
 * optional 坐标字段。
 */
export const FILM_SET_CONTENT_VERSION = 4 as const;
/** 上一代在线版本（items-only，坐标语义未显式版本化）；只由离线迁移转换。 */
export const FILM_SET_CONTENT_PREVIOUS_VERSION = 3 as const;
/** 仅用于隔离离线 reader 类型的旧版本（在线 decoder 拒绝）。 */
export const FILM_SET_CONTENT_LEGACY_VERSION = 1 as const;
export type FilmSetContentVersion =
  | typeof FILM_SET_CONTENT_LEGACY_VERSION
  | 2
  | typeof FILM_SET_CONTENT_PREVIOUS_VERSION
  | typeof FILM_SET_CONTENT_VERSION;
export const FILM_SET_CONTENT_FIELD = "filmSetContent" as const;

/** 单个片场允许的内部对象数量上限。 */
export const MAX_FILM_SET_ITEMS = 128;
/** 内部对象名称最大长度。 */
export const MAX_FILM_SET_NAME_LENGTH = 80;
/** 序列化内容字节预算（防止超长内容进入持久层）。 */
export const MAX_FILM_SET_BYTES = 1 << 20;
/** 整个片场所有对象源码（模型 + 动作）的累计字节预算。 */
export const MAX_FILM_SET_TOTAL_SOURCE_BYTES = 1 << 20;
/** 用户添加地面的建议边长（世界单位）。 */
export const FILM_SET_GROUND_DEFAULT_SIZE = 8;
/** 导入默认错开布局的水平步长 / 竖直步长（世界单位）。 */
export const FILM_SET_LAYOUT_STEP = 2.5;

/** 合法内部对象种类。 */
export const FILM_SET_ITEM_KINDS = ["model", "image", "video", "ground"] as const;
export type FilmSetItemKind = (typeof FILM_SET_ITEM_KINDS)[number];

/**
 * 内容契约层面可导入的种类（ground 不可导入）。
 *
 * 这是**内容接口**（MCP 导入等）的种类集合，不是画布拖动策略：共享拖动流程只把普通
 * `model3d` 导入片场，图片/视频通过拖动被拒绝（change: 2026-10-18-restrict-film-set-drop-to-models）。
 */
export const FILM_SET_IMPORTABLE_KINDS = ["model", "image", "video"] as const;
export type FilmSetImportableKind = (typeof FILM_SET_IMPORTABLE_KINDS)[number];

/**
 * 片场局部变换：offset 使用片场**场景单位**（与几何、媒体尺寸、镜头 distance 同一尺度），
 * scale 等比，yaw 绕局部 Y 轴。画布节点矩形与 viewport 不改变这些值。
 */
export type FilmSetLocalTransform = {
  offset: { x: number; y: number; z: number };
  scale: number;
  yaw: number;
};

export const DEFAULT_FILM_SET_LOCAL_TRANSFORM: FilmSetLocalTransform = {
  offset: { x: 0, y: 0, z: 0 },
  scale: 1,
  yaw: 0
};

/** 来源说明（仅说明，不用于加载或运行，不参与内容标识）。 */
export type FilmSetOrigin = {
  sourceNodeId?: string;
  sourceCanvasId?: string;
  importedAt: string;
};

/**
 * 对象局部播放配置（change design D1/D4）。
 *
 * 局部时间映射：`T < startTime` 显示基础姿态；`u = (T-startTime)*timeScale`；
 * 非循环 `t = clamp(u,0,duration)`；循环 `t = u mod duration`。片场只拥有一个播放头 T。
 */
export type FilmSetPlayback = ModelMediaTimeMap;
export const DEFAULT_FILM_SET_PLAYBACK: FilmSetPlayback = DEFAULT_MEDIA_TIME_MAP;

/** 每个对象可选的完整运动定义（含 motionScript）；缺失即静态。 */
export type FilmSetMotion = MotionDefinition;

export type FilmSetItemBase = {
  id: string;
  name: string;
  localTransform: FilmSetLocalTransform;
  /**
   * 独立运动定义；缺失即静态。`motionScript` 为空字符串表示移除动作。
   * 非空动作必须声明正有限 `playback.duration`。
   */
  motion?: FilmSetMotion;
  playback?: FilmSetPlayback;
};

export type FilmSetModelItem = FilmSetItemBase & {
  kind: "model";
  model: ModelDefinition;
  origin?: FilmSetOrigin;
};

export type FilmSetMediaItem = FilmSetItemBase & {
  kind: "image" | "video";
  assetId: string;
  /** 资源固有宽高比（宽 / 高），正有限。 */
  aspectRatio: number;
  origin?: FilmSetOrigin;
};

export type FilmSetGroundItem = FilmSetItemBase & {
  kind: "ground";
  size: { width: number; depth: number };
  color?: string;
};

export type FilmSetItem = FilmSetModelItem | FilmSetMediaItem | FilmSetGroundItem;

/** 媒体项类型守卫（媒体 kind 是联合字面量，需显式收窄）。 */
export function isFilmSetMediaItem(item: FilmSetItem): item is FilmSetMediaItem {
  return item.kind === "image" || item.kind === "video";
}

/** 模型项类型守卫。 */
export function isFilmSetModelItem(item: FilmSetItem): item is FilmSetModelItem {
  return item.kind === "model";
}

export type FilmSetContent = {
  schemaVersion: FilmSetContentVersion;
  items: FilmSetItem[];
};

/** 规范空集合（旧片场缺失字段、显式清空均归一到它，使用当前版本）。 */
export function emptyFilmSetContent(): FilmSetContent {
  return { schemaVersion: FILM_SET_CONTENT_VERSION, items: [] };
}
