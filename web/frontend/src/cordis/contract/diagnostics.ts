/**
 * 插件运行时诊断契约与 Feature 只读画布快照钩子依赖。
 * 从 `contracts.ts` façade 拆分（change: 2026-09-28-split-frontend-god-plugins，task 1.5）。
 */
import type { ServerCanvas } from "@woohaa3/contracts";

export type ExtensionStatus =
  | "pending"
  | "active"
  | "failed"
  | "loading"
  | "unloading"
  | "disposed"
  | "disabled";

export type ExtensionDiagnostic = {
  id: string;
  required: boolean;
  status: ExtensionStatus;
  missingServices: string[];
  error?: string;
  contributions: string[];
  /** 用户禁用的 optional Plugin 的稳定原因（change: add-frontend-plugin-manager）。 */
  reason?: string;
};

export type RuntimeStatus = {
  phase: "starting" | "ready" | "failed";
  error: string | null;
  plugins: ExtensionDiagnostic[];
};

export interface RuntimeDiagnostics {
  getStatus(): RuntimeStatus;
  subscribe(listener: () => void): () => void;
}

/** 供 Feature 组件读取的只读画布快照钩子依赖（由 canvas store 注入）。 */
export type CanvasStoreLike = {
  getState(): { canvas: ServerCanvas | null };
  subscribe(listener: () => void): () => void;
};
