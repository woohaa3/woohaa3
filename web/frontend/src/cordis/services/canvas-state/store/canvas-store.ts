/**
 * 规范画布 store。
 *
 * Yjs 是唯一事实源：服务端 published Y.Doc 经 `applyRemoteCanvas` 派生进 store，
 * React selector 与渲染快照都从这里读取。store 不再持有本地权威画布、本地持久化
 * 目标或本地 undo 历史（那些属于已移除的 remote-cas 路径）。
 *
 * 这里用 zustand 的 vanilla store 而不是 React hook：state 包不应把 React 绑进依赖图
 * （React 侧消费方通过 `useStore(woohaa3CanvasStore, selector)` 订阅）。
 */
import { createStore } from "zustand/vanilla";
import type { CanvasAggregateIssue, CanvasNodeData, ServerCanvas, StoredAsset, StoredJob, Woohaa3CanvasJsonObject, Woohaa3CanvasNode, Woohaa3CanvasPosition } from "@woohaa3/contracts";
import { addCanvasNode,
  addCanvasNodeConnected,
  canvasGraphOf,
  commitCanvas,
  connectCanvasEdge,
  deleteCanvasNodes,
  disconnectCanvasEdge,
  moveCanvasNodes,
  patchCanvasNodeData,
  setCanvasAssets,
  setCanvasJobs,
  type CanvasCommitPatch,
  type CanvasCommitRejection,
  type CanvasCommitResult } from "./canvas-commit.js";

export type Woohaa3CanvasStoreState = {
  /** 规范画布聚合；未派生前为 `null`。 */
  canvas: ServerCanvas | null;
  /**
   * 会话内 working projection（canonical + 有序 pending batches，change:
   * add-frontend-speculative-canvas-state）。Bevy/hit test/选择用它；未就绪为 `null`。
   */
  working: ServerCanvas | null;
  /** 加载/规范化过程中的诊断。 */
  issues: readonly CanvasAggregateIssue[];
  /** 最近一次被拒绝的提交，供桥接协调层回报结构化失败。 */
  lastRejection: CanvasCommitRejection | null;

  hydrate: (canvas: ServerCanvas, issues?: readonly CanvasAggregateIssue[]) => void;
  /** 应用服务端派生的规范画布（Yjs 唯一回流路径）。 */
  applyRemoteCanvas: (canvas: ServerCanvas) => void;
  /** 覆盖 working projection（由 working projection store 推入）。 */
  applyWorkingCanvas: (working: ServerCanvas | null) => void;
  commit: (patch: CanvasCommitPatch, now?: string) => CanvasCommitResult;
  addNode: (node: Woohaa3CanvasNode, nodeData?: CanvasNodeData, now?: string) => CanvasCommitResult;
  /** 「拉线创建」：一次提交里新增节点并从已有节点连一条边，只递增一个 revision。 */
  addNodeConnected: (
    request: {
      node: Woohaa3CanvasNode;
      nodeData?: CanvasNodeData;
      connectFromNodeId: string;
      connectLabel?: string;
    },
    now?: string
  ) => CanvasCommitResult;
  moveNodes: (
    positions: Readonly<Record<string, Woohaa3CanvasPosition>>,
    now?: string
  ) => CanvasCommitResult;
  deleteNodes: (nodeIds: readonly string[], now?: string) => CanvasCommitResult;
  connect: (
    connection: {
      id?: string;
      source: string;
      target: string;
      sourceHandle?: string | null;
      targetHandle?: string | null;
      data?: Woohaa3CanvasJsonObject;
    },
    now?: string
  ) => CanvasCommitResult;
  disconnect: (edgeId: string, now?: string) => CanvasCommitResult;
  patchNodeData: (nodeId: string, patch: CanvasNodeData, now?: string) => CanvasCommitResult;
  setAssets: (assets: readonly StoredAsset[], now?: string) => CanvasCommitResult;
  setJobs: (jobs: readonly StoredJob[], now?: string) => CanvasCommitResult;
};

type CommitFn = (canvas: ServerCanvas, now?: string) => CanvasCommitResult;

/** 未 hydrate 时所有提交路径共用的拒绝。 */
const NO_CANVAS_REJECTION: CanvasCommitRejection = {
  code: "unknown-node",
  message: "画布尚未 hydrate，拒绝变更"
};

/**
 * 创建一个规范画布 store。导出工厂是为了让测试能拿到干净的实例；
 * 生产代码使用下面的单例 `woohaa3CanvasStore`。
 */
export function createWoohaa3CanvasStore() {
  return createStore<Woohaa3CanvasStoreState>()((set, get) => {
    /** 所有变更路径共用的收尾：拒绝记入诊断，成功则替换画布。 */
    function applyCommit(run: CommitFn, now?: string): CanvasCommitResult {
      const current = get().canvas;
      if (!current) {
        set({ lastRejection: NO_CANVAS_REJECTION });
        return { ok: false, rejection: NO_CANVAS_REJECTION };
      }
      const result = run(current, now);
      if (!result.ok) {
        set({ lastRejection: result.rejection });
        return result;
      }
      if (result.changed) set({ canvas: result.canvas, lastRejection: null });
      else set({ lastRejection: null });
      return result;
    }

    return {
      canvas: null,
      working: null,
      issues: [],
      lastRejection: null,

      hydrate: (canvas, issues = []) =>
        set({ canvas, working: canvas, issues, lastRejection: null }),

      applyRemoteCanvas: (canvas) =>
        set((state) => ({
          canvas,
          // canonical 是 working 的新基线；pending 重基由 working projection store 随后
          // 调用 `applyWorkingCanvas` 推入。这里先回落到 canonical，避免残留上次的 working。
          working: canvas,
          lastRejection: null,
          issues: state.issues
        })),

      applyWorkingCanvas: (working) => set({ working }),

      commit: (patch, now) => applyCommit((canvas) => commitCanvas(canvas, patch, { now }), now),
      addNode: (node, nodeData, now) =>
        applyCommit((canvas) => addCanvasNode(canvas, node, nodeData, { now }), now),
      addNodeConnected: (request, now) =>
        applyCommit((canvas) => addCanvasNodeConnected(canvas, request, { now }), now),
      moveNodes: (positions, now) =>
        applyCommit((canvas) => moveCanvasNodes(canvas, positions, { now }), now),
      deleteNodes: (nodeIds, now) =>
        applyCommit((canvas) => deleteCanvasNodes(canvas, nodeIds, { now }), now),
      connect: (connection, now) =>
        applyCommit((canvas) => connectCanvasEdge(canvas, connection, { now }), now),
      disconnect: (edgeId, now) =>
        applyCommit((canvas) => disconnectCanvasEdge(canvas, edgeId, { now }), now),
      patchNodeData: (nodeId, patch, now) =>
        applyCommit((canvas) => patchCanvasNodeData(canvas, nodeId, patch, { now }), now),
      setAssets: (assets, now) =>
        applyCommit((canvas) => setCanvasAssets(canvas, assets, { now }), now),
      setJobs: (jobs, now) =>
        applyCommit((canvas) => setCanvasJobs(canvas, jobs, { now }), now)
    };
  });
}

/** 全应用共享的规范画布 store。 */
export const woohaa3CanvasStore = createWoohaa3CanvasStore();

/** 当前规范画布的渲染器投影；未 hydrate 时为 `null`。 */
export function canvasGraphOfState(state: Woohaa3CanvasStoreState) {
  return state.canvas ? canvasGraphOf(state.canvas) : null;
}

/**
 * canonical-only 选择器（change: add-frontend-speculative-canvas-state，design D11）。
 *
 * 任务执行、model MCP 登记、稳定资产解析、revision/同步状态必须用它——它们不得读取
 * 尚未确认的 working projection。
 */
export function canonicalCanvasOf(state: Woohaa3CanvasStoreState): ServerCanvas | null {
  return state.canvas;
}

/**
 * working 选择器（design D11）。
 *
 * Bevy render scene、hit test、选择过滤、上下文菜单和后续编辑规划用它，以获得 pending
 * 命令的立即反馈。未就绪时回落到 canonical。
 */
export function workingCanvasOf(state: Woohaa3CanvasStoreState): ServerCanvas | null {
  return state.working ?? state.canvas;
}
