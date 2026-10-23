/**
 * 工作区 UI store
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 1.2/2.2 / design D1/D2）。
 *
 * 插件拥有文档注册表与宿主资源；React 侧只消费这里发布的**不可变快照**（tab 列表、活动绑定、
 * 忙碌与内联提示）。快照在未变化时返回同一引用，满足 `useSyncExternalStore` 的稳定性要求。
 */
import type { EditorDocumentWorkspaceSnapshot } from "@woohaa3/photocraft-editor";
import { emptyRecentFileStore, type RecentFileStore } from "@woohaa3/photocraft-protocol";
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
  /**
   * 最近文件索引快照（change: 2026-10-22-add-photocraft-file-workflows，U04）。
   *
   * 只含身份与大小；字节仍在宿主的 `fileBytes` 里。它属于**工作区**（不是某个文档），
   * 因此放在这里而不是 `active` 绑定上：没有活动文档时也能看到并重开。
   */
  recentFiles: RecentFileStore;
  /**
   * 最近文件索引的本机持久化诊断（U04）。
   *
   * 索引写失败时不改内存状态、不抛错，但**必须**让用户看到「仅本次会话保留」；
   * 否则记录看起来正常、刷新后全部消失。这里只转发索引自己的 `lastError`。
   */
  recentFilesError: string | null;
};

const EMPTY: EditorDocumentWorkspaceSnapshot = { entries: [], activeId: null, activeGate: null };

export const INITIAL_WORKSPACE_UI: WorkspaceUiState = {
  documents: EMPTY,
  active: null,
  busy: false,
  notice: null,
  writable: false,
  recentFiles: emptyRecentFileStore(),
  recentFilesError: null
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
  if (a.recentFiles !== b.recentFiles) return false;
  if (a.recentFilesError !== b.recentFilesError) return false;
  if (a.busy !== b.busy || a.writable !== b.writable) return false;
  if (a.notice === b.notice) return true;
  return a.notice?.message === b.notice?.message && a.notice?.tone === b.notice?.tone;
}
