/**
 * 单节点「转为片场」转换服务的宿主 ↔ 扩展端口
 * （change: 2026-10-17-decouple-film-set-from-canvas-service）。
 *
 * 宿主（canvas-service）不再 import film-set 的实现来构造转换服务；扩展在
 * `canvasContent` 声明里返回的聚合运行时暴露 `conversion.createService(...)` 等工厂，
 * 宿主只提供**协作者**（权威房间、幂等登记、生成端口、模型能力目录、时钟）。
 *
 * 服务实例的消费面（`FilmSetConversionServicePort`）是之前就存在的画布 HTTP 端口形状，
 * 这里上移为公共契约，供宿主与扩展共同依赖。
 */
import type { CanvasAuthority } from "../backend/canvas-authority.js";
import type { AssistantExecutionRef } from "../extension/assistant/assistant-execution.js";
import type { AgentAdapterRunOutcome, AgentConversationAdapterEvent } from "../extension/assistant/conversation.js";
import type { FilmSetConversionRecord } from "./film-set-conversion/registry.js";

/** Trusted composition port, never selectable in a browser request. */
export type ContentConversionExecutionPort = {
  run(record: FilmSetConversionRecord, execute: (context: {
    execution: AssistantExecutionRef;
    signal: AbortSignal;
    emit(event: AgentConversationAdapterEvent): void;
  }) => Promise<AgentAdapterRunOutcome>, accepted?: (execution: AssistantExecutionRef) => Promise<void>): Promise<void>;
  cancel?(record: FilmSetConversionRecord): void;
  readStatus?(record: FilmSetConversionRecord): import("../extension/assistant/conversation.js").ConversationTurn["status"] | undefined;
  reconcile?(record: FilmSetConversionRecord, outcome: AgentAdapterRunOutcome): void;
};
import type {
  FilmSetConversionAdapterCapabilities,
  FilmSetConversionGenerator,
  FilmSetConversionMediaReader,
  FilmSetConversionModelCandidate,
  FilmSetConversionReceipt,
  FilmSetConversionRegistry,
  FilmSetConversionRequest,
  FilmSetConversionSourceKind,
  FilmSetConversionStatus,
  FilmSetConversionStatusResult
} from "./film-set-conversion.js";

/**
 * 媒体字节读取端口（宿主 Media 能力；扩展不直接读盘）。
 *
 * `canvasId` 可选：远端画布的素材字节只在托管存储里（键 `<canvasId>/media/<key>`），
 * 转片场的调用方在能拿到画布 id 时必须传；省略表示与画布无关。
 */
export type ContentConversionAssetReader = (
  storageKey: string,
  canvasId?: string
) => Promise<{ bytes: Uint8Array; contentType: string }>;

/**
 * 转片场服务实例的消费面（宿主 HTTP 路由与 composition 只依赖这些方法）。
 *
 * 结构上与实现类兼容即可；`code` 用 `string` 而不是枚举，宿主不再枚举具体错误码。
 */
export type FilmSetConversionServicePort = {
  submit(request: FilmSetConversionRequest): Promise<
    | { ok: true; receipt: FilmSetConversionReceipt & { ok: true }; status: FilmSetConversionStatus }
    | { ok: false; code: string; message: string; retryable?: boolean }
  >;
  status(request: { canvasId: string; requestId: string }): Promise<FilmSetConversionStatusResult>;
  cancel(request: { canvasId: string; requestId: string }): Promise<
    | { ok: true; status: FilmSetConversionStatus }
    | { ok: false; code: string; message: string }
  >;
  /** 当前可用转换模型候选（提供方集合的只读投影）。 */
  models?(): readonly FilmSetConversionModelCandidate[];
  /** 显式重试：合法候选保存失败时复用候选提交；无候选时重新推理。 */
  retry?(request: { canvasId: string; requestId: string }): Promise<
    | { ok: true; receipt: FilmSetConversionReceipt & { ok: true }; status: FilmSetConversionStatus }
    | { ok: false; code: string; message: string; retryable?: boolean }
  >;
};

/** 构造转片场服务需要宿主提供的协作者。 */
export type ContentConversionServiceDeps = {
  authorize?: (record: FilmSetConversionRecord) => Promise<boolean>;
  execution?: ContentConversionExecutionPort;
  resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
  registry: FilmSetConversionRegistry;
  /** 图片/视频生成端口；缺失时图片/视频转换返回 `model-not-configured`（3D 仍可用）。 */
  generator?: FilmSetConversionGenerator;
  /** 转换模型能力目录（可选）：调用上游之前解析实际模型与其能力。 */
  resolveModelCapabilities?: (input: {
    canvasId: string;
    sourceKind: FilmSetConversionSourceKind;
    modelKey?: string;
  }) => Promise<{ modelKey: string; capabilities?: FilmSetConversionAdapterCapabilities } | undefined>;
  /** 当前可用转换模型候选（只读投影）。 */
  models?: () => readonly FilmSetConversionModelCandidate[];
  now?: () => string;
  actorId?: string;
  /**
   * 提交/重试请求等待终态的时间（缺省 15s）。这是**请求等待参数**：超过即返回「进行中」并
   * 让占位节点继续反映真实阶段，不掐断上游（change: 2026-10-22-remove-agent-execution-limits）。
   */
  submitBudgetMs?: number;
  /** 显式上游期限（缺省不设应用侧总时长上限；用户停止与真实失败照常收敛）。 */
  generationTimeoutMs?: number;
};

/**
 * 转片场能力端口：由内容扩展实现，宿主在装配 `createCanvasService` 时注入。
 *
 * 宿主提供协作者与持久化选择（SQLite 登记仓在宿主侧），扩展提供领域服务与默认内存登记仓。
 */
export type ContentConversionRuntime = {
  createService(deps: ContentConversionServiceDeps): FilmSetConversionServicePort;
  createMediaReader(input: { read: ContentConversionAssetReader }): FilmSetConversionMediaReader;
  createInMemoryRegistry(): FilmSetConversionRegistry;
};
