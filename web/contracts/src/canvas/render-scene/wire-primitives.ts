/**
 * Render-scene 通用呈现原语
 * （change: 2026-10-28-generic-extension-content-ownership，任务 4.3）。
 *
 * 渲染层（Bevy/Rust）只理解这里的原语：身份、几何、材质、变换、动画与状态。
 * 业务语义（片场镜头、炉体对象、NPC 生产条目等）由扩展 adapter 投影为原语；扩展私有数据只
 * 作为**版本化载荷信封** `payload` 透传，渲染器不读取、不分支、也不据此拒绝整帧。
 */

/**
 * 扩展呈现载荷信封（版本化）。
 *
 * `extensionId` 与 `schemaVersion` 必须非空且有界；`data` 完全由扩展定义。渲染器把整个信封
 * 当作不透明数据：缺失或未知载荷只影响扩展自己的诊断，不影响原语本身的绘制/命中。
 */
export type BevyExtensionPayload = {
  extensionId: string;
  schemaVersion: string;
  data?: unknown;
};

/** 预览卡片状态：准备中/就绪/待更新/失败。 */
export type BevyPreviewCardState = "preparing" | "ready" | "stale" | "error";

/** 预览卡片零点封面相机（世界包围球上的观察姿态）。 */
export type BevyPreviewCardCamera = {
  azimuth: number;
  elevation: number;
  distance: number;
  focusOffset: [number, number, number];
};

/**
 * 预览卡片原语：一张卡片节点的通用呈现。
 *
 * `nodeId` 是卡片节点自身；`ownerNodeId` + `entityId` 是 owner 内的稳定归属身份（例如镜头）。
 * 标题/类型标记由 owner 投影，渲染器不再按业务类型推导文案。
 */
export type BevyPreviewCardPrimitive = {
  /** 卡片节点 canonical id（同一节点至多一张）。 */
  nodeId: string;
  /** 归属 owner 节点 id。 */
  ownerNodeId: string;
  /** owner 内稳定实体 id（不随位置/标题变化）。 */
  entityId: string;
  /** 仅影响呈现（离屏捕获目标仍可用）。 */
  hidden?: boolean;
  /** 卡片主标题。 */
  title: string;
  /** 次要类型标记（中文）；空串即不绘制。 */
  typeLabel: string;
  /** 是否动态（可播放）内容；静态卡片不绘制播放控件。 */
  animated: boolean;
  /** 画幅（宽/高数值）。 */
  aspect: number;
  /** 时间线时长（秒）；静态为 0。 */
  duration: number;
  /** 卡片背景色；缺省跟随主题。 */
  backdrop?: string;
  /** 零点封面相机。 */
  coverCamera: BevyPreviewCardCamera;
  state: BevyPreviewCardState;
  /** 本地播放进度 0..1；仅动态活动卡片携带。 */
  progress?: number;
  /** 是否正在本地播放（仅动态）。 */
  playing?: boolean;
  /** 可理解诊断（`stale`/`error` 时的原因摘要）。 */
  diagnostic?: string;
  /** 扩展私有载荷；渲染器不解读。 */
  payload?: BevyExtensionPayload;
};

/**
 * 归属线原语：owner → 目标节点的**派生呈现**（不是可编辑边）。
 *
 * 起点二选一：`start` 为宿主已投影的画布 2D 点（预览卡片等 2D 目标），`anchor` 为模型局部
 * 3D 锚点（复合资产根到子卡片）；同时存在时优先 `start`。目标可以按 `targetItemIds` 精确
 * 指向 owner 内的受管条目，缺失即取目标节点底部中心。
 */
export type BevyOwnershipLinkPrimitive = {
  /** 稳定身份（owner + 目标派生，不随位置变化）。 */
  id: string;
  ownerNodeId: string;
  start?: { x: number; y: number };
  anchor?: [number, number, number];
  targetNodeIds: string[];
  targetItemIds?: Record<string, string>;
  payload?: BevyExtensionPayload;
};

/**
 * 运行反馈原语：owner 节点的一次活动运行。
 *
 * `phase`/`labelCode` 是**通用阶段与文案码**（提交/排队/运行/保存/校验等），渲染器按同一组
 * 装饰动效呈现；具体业务身份只出现在 `payload`。缺失反馈表示无活动运行。
 */
export type BevyRunFeedbackPrimitive = {
  nodeId: string;
  active: boolean;
  phase: string;
  labelCode: string;
  /** 不透明运行身份：仅用于渲染器在换新任务时重启动效，不承载业务语义。 */
  operationKey?: string;
  source?: string;
  /** 减少动态效果偏好下使用静态可区分形态。 */
  reduceMotion?: boolean;
  /** 可选进度 0..1。 */
  progress?: number;
  diagnostic?: string;
  payload?: BevyExtensionPayload;
};

/**
 * 媒体平面原语（复合资产范围内的图片/视频平面）。
 *
 * 世界坐标由映射层派生；Rust 只据此放置真实平面并复用纹理通道。`id` 全局唯一
 * （`nodeId::itemId`），是纹理上传键。
 */
export type BevyMediaPlanePrimitive = {
  id: string;
  itemId?: string;
  unit?: number;
  kind: "image" | "video";
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  yaw: number;
  /** 是否已上传纹理；未就绪时 Rust 保留平面几何但显示占位。 */
  hasTexture: boolean;
};

/**
 * 受管条目运动原语：owner 内单个条目的局部播放配置与动作轨道
 * （change: 2026-10-09-add-film-set-object-motion-and-editing；
 *  change: 2026-10-28-generic-extension-content-ownership 通用化命名）。
 *
 * `itemId` 为 owner 内稳定条目 id；`playback` 决定局部时间映射；`modelMotion` 为已校验动作
 * 轨道（目标为条目内作者语义 partId，空串/`root` 即条目根）；`partIds` 为作者语义 partId →
 * 组合作用域编码 id。条目基础局部变换已烘焙进组合 group，不在此重复。
 */
export type BevyManagedItemMotion = {
  itemId: string;
  playback: { startTime: number; duration: number; timeScale: number; loop: boolean };
  /** 已校验的条目动作轨道（目标为条目内 partId）。 */
  modelMotion: import("../motion-ir.js").MotionIr["modelMotion"];
  /** 作者语义 partId → 组合作用域编码 id。 */
  partIds: Record<string, string>;
};

/** 扩展 adapter 一次可返回的通用原语集合。 */
export type ContentPresentationPrimitives = {
  previewCards?: BevyPreviewCardPrimitive[];
  ownershipLinks?: BevyOwnershipLinkPrimitive[];
  runFeedback?: BevyRunFeedbackPrimitive[];
};
