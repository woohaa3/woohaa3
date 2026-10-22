/**
 * 转换任务幂等登记契约
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.2 / design D5）。
 *
 * 稳定绑定「可信调用身份 + requestId + 规范输入 hash + 步骤 + 候选 + 首次回执」。相同请求返回
 * 原任务/原结果；同 ID 不同输入被拒绝；未知先查询。端口与存储后端解耦：调用方注入 durable
 * 实现（跨重启保留回执），测试/单实例可用内存实现。
 *
 * 刻意**不**把回执写进画布 Y.Doc：转换任务不是源节点的普通生成 run，也不应改变画布内容身份。
 * 画布上的最终结果由权威 `submitDerived` 事务单独保证幂等（commandId）。
 *
 * 纯类型 / JSON-only：不依赖任何存储实现或服务。
 */
import type { ValidatedFilmSetConversionCandidate } from "./candidate.js";
import type { FilmSetConversionAdapterCapabilities } from "./capabilities.js";
import type {
  FilmSetConversionErrorCode,
  FilmSetConversionFrozenSource,
  FilmSetConversionSettings,
  FilmSetConversionSourceKind,
  FilmSetConversionStep
} from "./types.js";

/** 转换任务状态：`completed` 只由权威创建事务成功产生。 */
export const FILM_SET_CONVERSION_RECORD_STATES = [
  "running",
  "completed",
  "failed",
  "cancelled"
] as const;
export type FilmSetConversionRecordState = (typeof FILM_SET_CONVERSION_RECORD_STATES)[number];

/** 创建结果回执（权威事务成功后的稳定身份）。 */
export type FilmSetConversionRecordResult = {
  targetNodeId: string;
  commandId: string;
  /** 内容质量说明（如部分动作未还原）。 */
  note?: string;
};

/** 写入目标片场的来源 metadata 字段（转换身份写入片场 `origin.conversion`）。 */
export type FilmSetConversionProvenanceFields = {
  sourceNodeId: string;
  sourceKind: FilmSetConversionSourceKind;
  sourceHash: string;
  importedAt: string;
};

/** 一条转换任务记录（含冻结来源、步骤、已校验候选与首次回执）。 */
export type FilmSetConversionRecord = {
  /** Explicit save-only recovery, retaining the original validated candidate and Canvas command. */
  saveAttempt?: number;
  execution?: import("../../extension/assistant-execution.js").AssistantExecutionRef;
  canvasId: string;
  requestId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceKind: FilmSetConversionSourceKind;
  /** 规范输入 hash；同 ID 不同 hash 必须拒绝。 */
  inputHash: string;
  /** 开始时冻结的来源身份/内容 hash/资产/范围；之后 selection 或来源变化都不重定位。 */
  frozenSource: FilmSetConversionFrozenSource;
  /** 来源节点标题（目标片场默认命名）。 */
  title: string;
  settings: FilmSetConversionSettings;
  /** 请求方可信主体（宿主解析，非请求体）；供生成 adapter 解析个人授权/owner。 */
  subject?: string;
  /**
   * 宿主在 HTTP 边界已解析的转换 owner（含提供方前缀，如 `principal:` / `local:`）。
   *
   * 与 `subject` 分开保存：`subject` 是可信主体（生产里 owner 由它派生），而本地开发姿态下
   * owner 可以是受控本地会话 `local:<id>`；重试/恢复必须复用同一 owner，故冻结在记录里。
   */
  ownerId?: string;
  /**
   * 本次实际使用的转换模型身份（由能力目录在受理时解析并冻结）。
   *
   * 与 `settings.modelKey`（用户偏好）区分：偏好缺失时目录给出的明确默认模型记录在此，绝不写回
   * 源节点的生成模型；模型/adapter 身份同时写入目标片场来源 metadata。
   */
  resolvedModelKey?: string;
  /** 本次实际使用的模型能力声明（供生成器选择原生视频/抽帧；与 resolvedModelKey 同时冻结）。 */
  capabilities?: FilmSetConversionAdapterCapabilities;
  step: FilmSetConversionStep;
  state: FilmSetConversionRecordState;
  /** 尝试序号；显式重新推理时递增。 */
  attempt: number;
  /** 已通过完整校验的候选；保存重试复用，不重复调用模型。 */
  candidate?: ValidatedFilmSetConversionCandidate;
  result?: FilmSetConversionRecordResult;
  error?: { code: FilmSetConversionErrorCode; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
};

/** 幂等登记端口。 */
export type FilmSetConversionRegistry = {
  /** 按 `(canvasId, requestId)` 读取；不存在返回 `null`。 */
  get(canvasId: string, requestId: string): Promise<FilmSetConversionRecord | null>;
  /** 幂等 upsert（主键为 `(canvasId, requestId)`）。 */
  put(record: FilmSetConversionRecord): Promise<void>;
  /** 删除记录。 */
  delete(canvasId: string, requestId: string): Promise<void>;
};
