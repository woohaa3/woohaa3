/**
 * 工作区 UI store
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 1.2/2.2 / design D1/D2）。
 *
 * 插件拥有文档注册表与宿主资源；React 侧只消费这里发布的**不可变快照**（tab 列表、活动绑定、
 * 忙碌与内联提示）。快照在未变化时返回同一引用，满足 `useSyncExternalStore` 的稳定性要求。
 */
import type { EditorDocumentWorkspaceSnapshot } from "@woohaa3/photocraft-editor";
import type { ActiveDocumentBinding } from "./image-editor-overlay.js";

export type WorkspaceUiState = {
  /** 文档列表/活动项/门禁（tab 条与关闭规则）。 */
  documents: EditorDocumentWorkspaceSnapshot;
  /** 活动文档的呈现绑定；没有活动文档时为 null。 */
  active: ActiveDocumentBinding | null;
  /** 有异步操作（打开/保存/发布）在进行。 */
  busy: boolean;
  /** 工作区内联提示（错误与交付结果都在这里，不依赖全局 Dialog）。 */
  notice: { message: string; tone: "info" | "error" } | null;
  /** 画布当前是否可写（只读时禁止添加到画布与节点保存）。 */
  writable: boolean;
};

const EMPTY: EditorDocumentWorkspaceSnapshot = { entries: [], activeId: null, activeGate: null };

export const INITIAL_WORKSPACE_UI: WorkspaceUiState = {
  documents: EMPTY,
  active: null,
  busy: false,
  notice: null,
  writable: false
};

export class DocumentWorkspaceStore {
  private state: WorkspaceUiState = INITIAL_WORKSPACE_UI;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): WorkspaceUiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 合并一次状态变化；内容完全相同时不发布（避免无谓重渲染）。 */
  update(patch: Partial<WorkspaceUiState>): void {
    const next: WorkspaceUiState = { ...this.state, ...patch };
    if (sameState(this.state, next)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** 只改内联提示（交付结果、打开失败原因）。 */
  setNotice(notice: WorkspaceUiState["notice"]): void {
    this.update({ notice });
  }

  dispose(): void {
    this.listeners.clear();
    this.state = INITIAL_WORKSPACE_UI;
  }
}

function sameState(a: WorkspaceUiState, b: WorkspaceUiState): boolean {
  if (a === b) return true;
  if (a.documents !== b.documents || a.active !== b.active) return false;
  if (a.busy !== b.busy || a.writable !== b.writable) return false;
  return a.notice === b.notice;
}
