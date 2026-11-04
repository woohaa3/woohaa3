/**
 * ChatGPT 生成层使用的 Canvas 权威端口
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 1.4/4.1–4.4 / design D4）。
 *
 * 生成层不直接写 Y.Doc/数据库，也不 patch nodeData 绕过语义：所有写入都经这些端口，由 Canvas
 * 负责内容 precondition、并发串行、幂等与历史。端口形状与 Canvas 现有 `mcpServices()` /
 * `ModelMcpService` 一致，便于统一后端进程内直接注入。
 */
import type {
  ModelCamera,
  ModelCameraMutation,
  ModelContentVersion
} from "@woohaa3/contracts";

/** 权威节点读取结果（生成前读取完整上下文）。 */
export type CanvasNodeReadResult =
  | {
      ok: true;
      nodeType: string;
      title: string;
      prompt: string;
      /** 当前权威模型脚本（供"只改部分"时保留既有内容，避免整段重写）。 */
      source?: string;
      references: ReadonlyArray<{ kind: string; role?: string; text?: string; url?: string; mediaKind?: string; mediaType?: string }>;
      /** model3d 模型内容版本（含 contentHash）。 */
      modelContentVersion?: ModelContentVersion;
      snapshotHash?: string;
      cameras: ModelCamera[];
    }
  | { ok: false; code: string; message: string };

export type CanvasWriteOutcome =
  | { ok: true; canvasId: string; nodeId: string; commandId: string; duplicate: boolean; noop: boolean; revision?: number }
  | { ok: false; code: string; message: string; failedIndex?: number };

/**
 * 端口调用的可信 owner。
 *
 * 由生成层携带（`input.ownerId`，来自后端 owner 解析：`principal:<subject>` 或本地会话
 * `local:<id>`），使画布委托与本次生成本身的 owner 一致。端口 MUST NOT 读取进程级可变
 * 作用域——原始 HTTP 是并发的，模块级 `scope.current` 会在 `await` 间串号，且在本地开发
 * （无宿主 principal）时为空，导致「缺少可信用户委托」。
 */
export type CanvasOwner = string;

/** 提交模型脚本（完整静态 modelScript）到原节点，带内容 precondition。 */
export type CanvasSubmitModelInput = {
  ownerId: CanvasOwner;
  canvasId: string;
  nodeId: string;
  requestId: string;
  source: string;
  expectedModelContentHash?: string;
};

/** 批量受限镜头变更（整批原子）。 */
export type CanvasMutateCamerasBatchInput = {
  ownerId: CanvasOwner;
  canvasId: string;
  nodeId: string;
  requestId: string;
  mutations: readonly ModelCameraMutation[];
};

export type ChatGptCanvasPorts = {
  readNode: (input: { ownerId: CanvasOwner; canvasId: string; nodeId: string }) => Promise<CanvasNodeReadResult>;
  submitModel: (input: CanvasSubmitModelInput) => Promise<CanvasWriteOutcome>;
  mutateCamerasBatch: (input: CanvasMutateCamerasBatchInput) => Promise<CanvasWriteOutcome>;
};
