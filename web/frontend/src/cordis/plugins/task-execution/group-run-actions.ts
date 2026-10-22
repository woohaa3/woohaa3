/**
 * 分组横条动作的纯描述与结果摘要存储
 * （change: 2026-10-16-add-group-selection-toolbar，任务 2.2/2.3/4.1 / design D1/D4/D6）。
 *
 * 本模块只做**纯数据**判定与**有界**反馈状态：
 * - `resolveGroupBulkDescriptor`：把只读预览 + 只读/提交态映射为横条动作描述
 *   （`批量执行 · N` / 禁用原因 / `提交中`）。与 React、DOM、Bevy 无关，便于非渲染回归。
 * - `GroupRunSummaryStore`：保存**最近一批**提交摘要，供 overlay 渲染。绑定起始
 *   canvasId/groupId；同画布切换选择保留，新批替换，切画布或页面释放清理（不无界累积）。
 *
 * 横条本体由 Bevy 绘制，因此禁用原因复用**已在绘制的摘要文本**（`summary`）呈现；不新增
 * wire 字段，也不引入第二份任务状态。
 */
import type { NodeActionDescriptor } from "../../contract/platform.js";
import type { GroupRunPreview, GroupRunSummary } from "../service-keys.js";

/** 分组主动作的稳定贡献 ID（横条命中回传用它派发）。 */
export const GROUP_BULK_ACTION_ID = "group-bulk-run";

/**
 * 主动作描述（纯函数）。
 *
 * - `submitting`：该组正在编排一批请求 → 文案「提交中」并禁用。
 * - 预览不可用（N=0、只读、目录未就绪等）→ 保持「批量执行」文案并禁用，原因写入 `summary`
 *   以便在横条内可见；不同时显示 N（避免「批量执行 · 0」误导）。
 * - 预览可用 → 「批量执行 · N」，无摘要。
 */
export function resolveGroupBulkDescriptor(input: {
  preview: GroupRunPreview | null;
  submitting: boolean;
}): NodeActionDescriptor {
  const base = { tone: "primary" as const };
  if (input.submitting) {
    return { ...base, label: "提交中", enabled: false, reason: "提交中", summary: "提交中" };
  }
  const preview = input.preview;
  if (!preview) {
    return { ...base, label: "批量执行", enabled: false, reason: "分组执行能力不可用" };
  }
  if (!preview.enabled) {
    const reason = preview.reason ?? "没有可执行任务";
    return { ...base, label: "批量执行", enabled: false, reason, summary: reason };
  }
  return { ...base, label: `批量执行 · ${preview.count}`, enabled: true };
}

export type GroupRunSummaryRecord = {
  canvasId: string;
  summary: GroupRunSummary;
};

export type GroupRunSummaryState = GroupRunSummaryRecord & { dismissed: boolean };

/**
 * 最近一批提交摘要的有界存储（每页一个；绑定 canvasId/groupId）。
 *
 * 同一画布内新批**替换**旧摘要（不累积）；`syncCanvas` 在画布切换时清理；`dispose` 在页面
 * 释放时清理。摘要只表达**请求受理结果**，不是任务终态源。
 */
export class GroupRunSummaryStore {
  private state: GroupRunSummaryState | null = null;
  private readonly listeners = new Set<() => void>();

  /** 记录一批结果；不同画布时丢弃旧摘要（不跨画布误报）。 */
  show(input: { canvasId: string; summary: GroupRunSummary }): void {
    if (this.state && this.state.canvasId !== input.canvasId) {
      this.state = null;
    }
    this.state = { canvasId: input.canvasId, summary: input.summary, dismissed: false };
    this.emit();
  }

  /** 画布切换/回流时收敛：不同画布立即清理。 */
  syncCanvas(canvasId: string): void {
    if (!this.state || this.state.canvasId === canvasId) return;
    this.state = null;
    this.emit();
  }

  dismiss(): void {
    if (!this.state || this.state.dismissed) return;
    this.state = { ...this.state, dismissed: true };
    this.emit();
  }

  /**
   * 供 `useSyncExternalStore` 使用的快照读取。
   *
   * 必须是**箭头属性**（绑定 `this`）：React 以裸函数引用调用它，普通方法会丢失 `this`。
   */
  getState = (): GroupRunSummaryState | null => (this.state?.dismissed ? null : this.state);

  /** 原始快照（含已关闭标记），供需要知道「有摘要但被关闭」的调用方使用。 */
  getRaw = (): GroupRunSummaryState | null => this.state;

  dispose(): void {
    this.state = null;
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
