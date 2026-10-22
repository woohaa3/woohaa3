/**
 * 单节点快捷转为片场的公共契约：请求、冻结来源、设置、状态与回执
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.1 / design D1/D4/D5）。
 *
 * 纯类型/常量叶子模块：不 import 任何 codec，避免经 barrel 形成环。字段刻意区分
 * **源节点生成模型**（保持图片/视频节点自己的生成配置）与**转换模型**（本次转换为片场
 * 使用的视觉模型）；转换设置只属于本次用途，不写来源节点。
 */

/** 转换协议版本；结构变化必须提升。 */
export const FILM_SET_CONVERSION_PROTOCOL_VERSION = 1 as const;

/** 内置转换指令版本：指令结构变化时递增（记录在来源 metadata）。 */
// v3：加入具体 SceneBuilder 调用形式与可运行示例，避免模型写出引用未定义全局的脚本。
// v4：加入渲染预算（估算 tessellation 顶点上限），避免结构合法但超预算的候选被整份拒绝。
// v5：加入图元合法性约束与失败修复段，减少因未告知的隐式几何约束反复失败。
// v6：加入动作脚本 API 与相机弧度单位，修正「镜头朝向错、人物完全不动」。
// v7：声明世界单位/主体真实尺寸与地面尺寸指引，修正「地板巨大、人物微小」。
// v8：拍摄镜头 kind 联合（static/dynamic）与严格静态/动态不变式，区分「固定机位拍运动对象」。
export const FILM_SET_CONVERSION_INSTRUCTION_VERSION = 9 as const;

/** 支持的转换来源节点种类：图片、视频、普通 3D 模型。 */
export const FILM_SET_CONVERSION_SOURCE_KINDS = ["image", "video", "model3d"] as const;
export type FilmSetConversionSourceKind = (typeof FILM_SET_CONVERSION_SOURCE_KINDS)[number];

/** 视频处理时间范围（秒，`endSeconds` 必须大于 `startSeconds`）。 */
export type FilmSetConversionRange = {
  startSeconds: number;
  endSeconds: number;
};

/**
 * 上一次候选未通过完整校验时的**修复指引**（可选）。
 *
 * 每一次上游调用都是无状态回合，模型不会记得上一次输出，因此生成器 MUST 把上一份候选与完整校验
 * 错误**一并回喂**，要求其只修复该问题并返回完整候选（避免逐条在提示词里穷举隐式约束）。
 */
export type FilmSetConversionRepair = {
  /** 上一份已通过结构归一、但未通过完整校验的候选（原样回喂）。 */
  candidate: unknown;
  /** 完整校验给出的可读失败原因（例如「对象 X 的 capsule 总高度不得小于直径」）。 */
  message: string;
  /** 已进行的修复轮次（从 1 开始）。 */
  attempt: number;
};

/**
 * 开始时冻结的来源身份：由任务持有，selection 或来源内容后来变化都不重定位。
 *
 * - `contentHash`：模型为源码哈希，媒体为资产 checksum；
 * - 媒体额外携带稳定 `assetId`、固有宽高比与视频时长；
 * - 视频本次处理范围在 `range`（缺省表示整个视频）。
 */
export type FilmSetConversionFrozenSource = {
  nodeId: string;
  kind: FilmSetConversionSourceKind;
  contentHash: string;
  assetId?: string;
  aspectRatio?: number;
  durationSeconds?: number;
  range?: FilmSetConversionRange;
};

/**
 * 转换设置（用户可见、可保存为「转为片场」用途偏好）。
 *
 * `modelKey` 是转换模型身份，绝不写回源节点的生成模型；`instruction` 为可选补充要求。
 * `range` 为本次视频素材设置，不迁移到另一段视频。
 */
export type FilmSetConversionSettings = {
  connection?: import("../../extension/conversation.js").AgentConnectionBinding;
  reasoningEffort?: import("../../extension/conversation.js").AgentReasoningEffort;
  modelKey?: string;
  instruction?: string;
  range?: FilmSetConversionRange;
};

/**
 * 单节点转换请求。
 *
 * `targetNodeId` 由调用方生成，使重试落到同一实体；`requestId` 是稳定的幂等身份。
 * 同一 `requestId` 携带不同规范输入必须被拒绝（见 `filmSetConversionInputHash`）。
 */
export type FilmSetConversionRequest = {
  canvasId: string;
  requestId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceKind: FilmSetConversionSourceKind;
  settings?: FilmSetConversionSettings;
  /**
   * 请求方可信主体（由宿主在 HTTP 边界解析，**不**来自请求体，故不参与幂等输入 hash）。
   * 生成 adapter 用它解析个人授权/owner；缺失时按 adapter 自身的边界（如配置账号）处理。
   */
  subject?: string;
  /**
   * 宿主在 HTTP 边界**已解析**的转换 owner（含提供方前缀，如 `principal:` / `local:`），
   * 同样不来自请求体、不参与幂等 hash。生成 adapter 优先使用它；缺省时按 `subject` 解析。
   */
  ownerId?: string;
};

/** 转换执行阶段（来自后端真实阶段；无真实比例时不估计百分比）。 */
export const FILM_SET_CONVERSION_STEPS = [
  "prepare-source",
  "analyze-content",
  "generate-film-set",
  "validate-and-save"
] as const;
export type FilmSetConversionStep = (typeof FILM_SET_CONVERSION_STEPS)[number];

/** 转换任务状态判别值。 */
export const FILM_SET_CONVERSION_STATES = ["running", "completed", "failed", "cancelled", "unknown"] as const;
export type FilmSetConversionState = (typeof FILM_SET_CONVERSION_STATES)[number];

/** 稳定错误码（用于前端就近展示与恢复动作，不暴露内部堆栈）。 */
export const FILM_SET_CONVERSION_ERROR_CODES = [
  "malformed-request",
  "canvas-not-found",
  "canvas-unavailable",
  "unauthorized",
  "source-not-found",
  "unsupported-source",
  "source-not-ready",
  "stale-source",
  "model-required",
  "model-not-configured",
  "model-not-vision-capable",
  "model-no-structured-output",
  "budget-exceeded",
  "range-required",
  "candidate-invalid",
  "commit-failed",
  "generation-failed",
  "cancelled",
  "request-id-reused",
  "unknown-result"
] as const;
export type FilmSetConversionErrorCode = (typeof FILM_SET_CONVERSION_ERROR_CODES)[number];

/** 冻结来源快照：请求受理时由权威画布派生（见 `readFilmSetConversionSource`）。 */
export type FilmSetConversionSourceSnapshot = {
  ok: true;
  source: FilmSetConversionFrozenSource;
  /** 来源节点标题（作为目标片场默认命名的一部分）。 */
  title: string;
} | {
  ok: false;
  code: FilmSetConversionErrorCode;
  message: string;
};

/** 提交回执（受理或明确失败；`unknown` 不在此表达，由状态查询回答）。 */
export type FilmSetConversionReceipt =
  | {
      ok: true;
      requestId: string;
      targetNodeId: string;
      commandId: string;
      /** 该 requestId 已存在时的同一结果。 */
      duplicate: boolean;
    }
  | { ok: false; code: FilmSetConversionErrorCode; message: string; retryable?: boolean };

/**
 * 转换任务状态视图。
 *
 * `completed` 只由**权威创建事务成功**产生，携带最终片场 nodeId 与 commandId；模型完成但
 * 尚未提交时保持 `running` + `validate-and-save` 阶段。
 */
export type FilmSetConversionStatus = { execution?: import("../../extension/assistant-execution.js").AssistantExecutionRef } & (
  | { status: "running"; requestId: string; sourceNodeId: string; step: FilmSetConversionStep }
  | {
      status: "completed";
      requestId: string;
      sourceNodeId: string;
      targetNodeId: string;
      commandId: string;
      /** 内容质量说明（如部分动作未还原）；缺失表示无额外说明。 */
      note?: string;
    }
  | {
      status: "failed";
      requestId: string;
      sourceNodeId: string;
      code: FilmSetConversionErrorCode;
      message: string;
      /** 尝试序号；显式重新推理时递增。 */
      attempt: number;
      /** 是否可复用候选或安全重试。 */
      retryable: boolean;
    }
  | { status: "cancelled"; requestId: string; sourceNodeId: string }
  | { status: "unknown"; requestId: string; sourceNodeId: string });

/** 状态查询结果：`null` 表示不存在该请求。 */
export type FilmSetConversionStatusResult =
  | { ok: true; status: FilmSetConversionStatus | null }
  | { ok: false; code: FilmSetConversionErrorCode; message: string };

/**
 * 写入目标片场来源 metadata 的转换记录（change: 2026-10-13-add-node-to-film-set-shortcut，
 * 任务 1.3/1.4 / design D5）。
 *
 * 持久保存在片场节点 `origin` 上，记录来源身份、内容 hash、本次转换模型/adapter、指令版本、
 * requestId 与视频范围。未能映射到片场镜头契约的附加镜头在此显式说明（`unmappedCameras`），
 * 绝不声称全部已映射。
 */
export type FilmSetConversionOriginRecord = {
  requestId: string;
  sourceKind: FilmSetConversionSourceKind;
  /** 源内容 hash（模型为源码哈希，媒体为资产 checksum）。 */
  sourceHash: string;
  /** 本次转换使用的模型/adapter 身份（3D 直接复制缺省）。 */
  modelKey?: string;
  /** 内置转换指令版本（3D 直接复制缺省）。 */
  instructionVersion?: number;
  /** 视频本次处理范围；缺失表示整个视频。 */
  range?: FilmSetConversionRange;
  /** 无法映射到片场镜头契约的附加镜头名称（存在时明确说明）。 */
  unmappedCameras?: string[];
};
