import { decodeFilmSetContent, emptyFilmSetContent, isFilmSetMediaItem, type FilmSetContent, type FilmSetItem, type FilmSetLocalTransform, type ServerCanvas } from "@woohaa3/contracts";

export type FilmSetObjectEntry = {
  itemId: string;
  kind: FilmSetItem["kind"];
  name: string;
  /** 对象是否可独立编辑（模型、媒体、地面均为 true）。 */
  editable: boolean;
};

/** 一次对象操作的结算结果（committed 才算真正完成）。 */
export type FilmSetOperationOutcome =
  | { state: "committed" }
  | { state: "rejected"; error: string | null }
  | { state: "pending" };

export type FilmSetObjectSessionState = {
  tool: import("@woohaa3/contracts").ObjectGizmoTool;
  feedback: import("@woohaa3/contracts").GizmoFeedback;
  pointer: { x: number; y: number } | null;
  nodeId: string | null;
  selectedItemId: string | null;
  /** 拖动中的临时摆放 preview；无 preview 为 null。 */
  preview: FilmSetLocalTransform | null;
  /** 最近一次对象级失败/诊断信息。 */
  error: string | null;
  /**
   * 正在结算（pending）的对象 action 目标。非 null 时禁用**同一目标**的删除/冲突编辑，
   * 避免长按或重复点击连删（change: 2026-10-10-improve-film-set-editing-and-inspector，任务 4.2）。
   */
  pendingItemId: string | null;
};

const INITIAL: FilmSetObjectSessionState = {
  tool: "move",
  feedback: { epoch: 0 },
  pointer: null,
  nodeId: null,
  selectedItemId: null,
  preview: null,
  error: null,
  pendingItemId: null
};

export function readFilmSetContentForSession(canvas: ServerCanvas | null, nodeId: string): FilmSetContent {
  if (!canvas) return emptyFilmSetContent();
  const decoded = decodeFilmSetContent(canvas.nodeData[nodeId]?.["filmSetContent"]);
  return decoded.ok ? decoded.value : emptyFilmSetContent();
}

export class FilmSetObjectState {
  protected state: FilmSetObjectSessionState = { ...INITIAL };
  protected editBase: FilmSetLocalTransform | null = null;
  private readonly listeners = new Set<() => void>();
  getState = (): FilmSetObjectSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  protected emit(): void { for (const listener of this.listeners) listener(); }
}
export { INITIAL, isFilmSetMediaItem };
