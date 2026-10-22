/**
 * 文档呈现接口（宿主适配层）
 * （change: 2026-10-21-add-photocraft-document-workspace，design D1/D3/D4）。
 *
 * 工作区同时服务两种来源：
 * - **节点文档**：`ImageFocusWorkspace`（原节点由 Bevy 呈现，周围保留画布）；
 * - **独立文件文档**：`FileDocumentWorkspace`（不透明编辑背景 + 文档自身预览）。
 *
 * 两者对 React 编辑器暴露同一份最小接口，使 `PhotoEditorApp` / `ProjectEditorPane` 不按来源
 * 分支。接口只含呈现与文档状态；保存目的地、节点发布与交付端口归宿主插件。
 */
import type { EditorPreview, DetailFrame } from "@woohaa3/photocraft-editor";
import type { ImageProjectDocument } from "@woohaa3/contracts";
import type { ProjectSession } from "./project-session.js";
import type { ImageFocusViewport } from "./focus-session.js";

/** 取景会话的可呈现部分（节点与文件文档共用）。 */
export type DocumentFocusView = {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  viewportState(): ImageFocusViewport;
  setViewport(viewport: ImageFocusViewport): void;
  setFitZoom(zoom: number): void;
  currentFitZoom(): number;
  adoptSourceSize(width: number, height: number): void;
};

export type DocumentRect = { x: number; y: number; width: number; height: number };

/**
 * 编辑器消费的文档呈现。
 *
 * 不携带文档或节点身份：身份由工作区条目给出，呈现只回答“当前文档长什么样”。
 */
export interface EditorDocumentView {
  /** 节点文档的节点身份；独立文件文档为 null（不伪造节点）。 */
  readonly nodeId: string | null;
  readonly focus: DocumentFocusView;
  readonly project: ProjectSession;

  subscribe(listener: () => void): () => void;
  revisionState(): number;
  contentRevisionState(): number;

  isPresentationReady(): boolean;
  isTransitioning(): boolean;
  isReadOnlyPreview(): boolean;
  historyOverrideState(): { url: string } | null;
  previewStatus(): string | null;

  projectDocument(): ImageProjectDocument | null;
  baseAsset(): unknown;

  setViewport(viewport: ImageFocusViewport): void;
  setEditorPreview(preview: EditorPreview | null, size?: { width: number; height: number }): void;
  setEditorDetails(frame: DetailFrame | null): void;
  detailViewportSize(): { width: number; height: number };
  setRect(rect: DocumentRect): void;
  preserveNextLayoutViewport(): void;
  setHistoryOverride(override: { url: string } | null): void;

  /** 释放呈现资源（关闭文档/页面离开）。 */
  dispose(): void;
}

/** 文档状态汇总（tab 呈现与关闭结算共用）。 */
export type DocumentDirtyState = {
  /** 内容相对保存基线有净变化。 */
  dirty: boolean;
  /** 仍有未确认的受控草稿（文字/变换/调整/属性）。 */
  pendingDraft: string | null;
  /** 当前阶段（保存/冻结/失败）。 */
  phase: string;
  /** 失败原因（无则 null）。 */
  message: string | null;
};
