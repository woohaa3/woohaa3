/**
 * 应用插件 authoring 与受控工具委托契约（纯类型）
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 1.5/1.6 / design D7/D8）。
 *
 * Canvas 向可信插件提供：权威上下文读取、modelScript 提交、完整动画提交、镜头整批修改与
 * 提交回执查询。每次都绑定可信用户委托、工作与稳定 operationId，保留内容 precondition、
 * 幂等、原子性与历史规则。插件拿不到 Y.Doc、数据库或任意命令入口。
 *
 * 另含：稳定媒体引用的受限解析、MCP 工具委托（grant）与个人生成能力。
 */
import type {
  FilmSetNodeData
} from "../canvas/canvas-node-model.js";
import type { ModelCamera, ModelCameraMutation } from "../canvas/model-cameras.js";
import type { ModelContentVersion } from "../canvas/model-definition.js";
import type { ApplicationUserDelegation } from "./principal.js";

/** 权威节点上下文读取结果。 */
export type ApplicationAuthoringNodeRead =
  | {
      ok: true;
      nodeType: string;
      title: string;
      prompt: string;
      /** 当前权威模型脚本（供增量修改保留既有内容）。 */
      source?: string;
      references: ReadonlyArray<{ kind: string; role?: string; text?: string; url?: string; mediaKind?: string; mediaType?: string }>;
      modelContentVersion?: ModelContentVersion;
      animation?: FilmSetNodeData;
      snapshotHash?: string;
      cameras: ModelCamera[];
    }
  | { ok: false; code: string; message: string };

export type ApplicationAuthoringWriteOutcome =
  | { ok: true; canvasId: string; nodeId: string; commandId: string; duplicate: boolean; noop: boolean; revision?: number }
  | { ok: false; code: string; message: string; failedIndex?: number };

/** 一次 authoring 写入的公共上下文（用户委托 + 工作 + 稳定 operationId）。 */
export type ApplicationAuthoringWriteContext = {
  delegation: ApplicationUserDelegation;
  /** 宿主绑定的工作 identity（可选；准入后由工作关联提供）。 */
  workId?: string;
  /** 稳定操作 id（幂等作用域）。 */
  operationId: string;
};

export type ApplicationCanvasAuthoringFacade = {
  readNode(input: { delegation: ApplicationUserDelegation; canvasId: string; nodeId: string }): Promise<ApplicationAuthoringNodeRead>;
  submitModel(input: ApplicationAuthoringWriteContext & {
    canvasId: string;
    nodeId: string;
    source: string;
    expectedModelContentHash?: string;
  }): Promise<ApplicationAuthoringWriteOutcome>;
  commitAnimation(input: ApplicationAuthoringWriteContext & {
    canvasId: string;
    nodeId: string;
    animation: FilmSetNodeData;
    expectedSnapshotHash?: string;
  cameraId?: string; clipId?: string; itemId?: string;
  expectedClipHash?: string;
  }): Promise<ApplicationAuthoringWriteOutcome>;
  mutateCamerasBatch(input: ApplicationAuthoringWriteContext & {
    canvasId: string;
    nodeId: string;
    mutations: readonly ModelCameraMutation[];
  }): Promise<ApplicationAuthoringWriteOutcome>;
  /** 按工作/operationId 查询已提交回执（恢复/重连用）。 */
  receipt(input: { delegation: ApplicationUserDelegation; canvasId: string; nodeId: string; operationId: string }): Promise<
    | { ok: true; committed: boolean; commandId?: string; revision?: number }
    | { ok: false; code: string; message: string }
  >;
};

/** 稳定媒体引用到受限推理输入的解析（不交出 COS 凭据/内部令牌）。 */
export type ApplicationMediaReferenceFacade = {
  resolve(input: { delegation: ApplicationUserDelegation; storageKey: string }): Promise<
    | { ok: true; url: string; mediaType?: string; mediaKind?: string; expiresAt?: number }
    | { ok: false; code: string; message: string }
  >;
};

/**
 * MCP 工具委托（grant）：宿主签发、工具入口验证
 * （change: 2026-10-22-remove-agent-execution-limits，任务 2.1 / design D2）。
 *
 * 绑定 plugin/version/work/owner/目标与允许工具；只进入受限子进程环境，不进入浏览器、日志或
 * 公开 DTO。委托**不携带调用额度，也不按固定时钟失效**：寿命等于活动执行本身，由取消、终态、
 * 撤权与连接代次决定。工具入口每次操作仍重新检查权限与失效状态。
 */
export type ApplicationToolGrant = {
  groupScope?: import("../canvas/group-authoring-scope.js").CanvasGroupScope;
  token: string;
  /** 允许访问的画布集合。 */
  canvasIds: readonly string[];
  /** 允许访问的节点集合（空=该画布任意节点）。 */
  nodeIds: readonly string[];
  cameraId?: string; clipId?: string; itemId?: string;
  /** 允许调用的工具名集合。 */
  tools: readonly string[];
  /** 绑定的工作/回合身份（撤销按它定位；不进入模型提示词）。 */
  workId: string;
  /** 绑定的可信 owner；撤销与跨 owner 隔离据此判定。 */
  subject?: string;
  /** 绑定的连接代次；连接重建后旧委托不可继续使用。 */
  credentialEpoch?: number;
};

export type ApplicationToolGrantRequest = {
  mode?: import("./conversation.js").AgentTargetMode;
  expectedScopeEpoch?: number;
  delegation: ApplicationUserDelegation;
  workId: string;
  canvasId: string;
  nodeId: string;
  cameraId?: string; clipId?: string; itemId?: string;
  tools?: readonly string[];
  /** 绑定的连接代次（可选；变更后旧委托失效）。 */
  credentialEpoch?: number;
};

export type ApplicationToolDelegationFacade = {
  /** 签发一个受控工具 grant（寿命等于活动执行，不设调用额度或固定时钟到期）。 */
  issue(request: ApplicationToolGrantRequest): Promise<ApplicationToolGrant>;
  /** 撤销某工作的 grant（断开/取消/收尾）。 */
  revoke(workId: string, delegation?: ApplicationUserDelegation): void;
  /**
   * 工具入口强制校验（design D8）：绑定 token/tool/目标范围与当前撤销状态。
   * 工具入口 MUST 在每次操作前调用它，而不是只在会话建立时校验。校验不消耗任何额度。
   */
  authorize(input: { token: string; tool: string; canvasId?: string; nodeId?: string; cameraId?: string; clipId?: string; itemId?: string }): { ok: true } | { ok: false; reason: string };
};

/** 个人生成能力：账户模型目录与可执行性按可信 owner 隔离，不进入共享 catalog。 */
export type ApplicationPersonalGenerationFacade = {
  /** 账户可用模型（使用当前 owner 的有效凭据查询）。 */
  models(input: { delegation: ApplicationUserDelegation }): Promise<{ models: Array<{ id: string; label: string }>; error?: string }>;
  /** 是否可执行（凭据/订阅就绪）。 */
  executable(input: { delegation: ApplicationUserDelegation }): Promise<boolean>;
};

/** Context 暴露给插件的 authoring/工具/个人生成端口集合。 */
export type ApplicationAuthoringServices = {
  authoring: ApplicationCanvasAuthoringFacade;
  references: ApplicationMediaReferenceFacade;
  tools: ApplicationToolDelegationFacade;
  personalGeneration: ApplicationPersonalGenerationFacade;
};
