import type { ReactNode } from "react";
import type { AuthoringGenerationProps } from "../cordis/contract/authoring.js";
import type { ModelEditorSession } from "./model-workspace-session.js";
export type ModelCaptureOrigin = { nodeData: import("@woohaa3/contracts").CanvasNodeData };
export type ModelCaptureSession = {
  readonly busy: boolean;
  capture(input: { nodeId: string; cameraId: string; cameraName?: string; captureId?: string; origin?: ModelCaptureOrigin; isCurrent?: () => boolean }): Promise<{ ok: true; status: "inserted" | "duplicate"; nodeId: string; entryId: string } | { ok: false; code: string; message: string }>;
};
/** Shared camera editor and capture channel. Extensions own their workspace and business actions. */
export type ModelWorkspaceService = {
  session: ModelEditorSession;
  captureSession: ModelCaptureSession;
  defaultDistance(nodeId: string): number;
  addCamera(): void;
  capture(): Promise<void>;
  acquireCapture(): Promise<() => void>;
  refreshGizmo(): void;
  renderCameraPanel(input: { presentation?: "composition"; cameraCollectionMutable?: boolean; writable: boolean; readOnly: boolean; canvasId?: string; onActivateCamera?: () => void; renderGenerate?: () => ReactNode }): ReactNode;
  /**
   * 渲染宿主 authoring 生成入口（`authoring.generate` 贡献）
   * （change: 2026-10-12-add-agent-conversation-panel，design D6/D8）。
   *
   * 扩展拥有布局时用它渲染生成入口，而不是自行读取 slot：宿主据此注入目标身份、MCP 指引与
   * Agent 会话能力（重开复用同一会话、按状态显示详情入口）。缺少贡献时返回 null。
   */
  renderGenerate(input: AuthoringGenerationProps): ReactNode;
  renderCameraPreview(readOnly: boolean): ReactNode;
};
/** Shared input-owner eligibility; the playback target is typed and never guessed from ground geometry. */
export type HoverPlaybackTarget =
  | { kind: "shot-preview"; previewNodeId: string; filmSetNodeId: string; clipId: string }
  | null;
export type HoverPlaybackSnapshot = { target: HoverPlaybackTarget; blocked: boolean; epoch: number };
export type HoverStateService = { getNodeId(): string | null; getPlaybackSnapshot(): HoverPlaybackSnapshot; subscribe(listener: () => void): () => void };
