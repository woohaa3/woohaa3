/**
 * Shared platform service contracts kept separate from the slot contribution map.
 *
 * The façade re-exports these types so consumers keep the stable platform import
 * while the service portion remains independently reviewable.
 */
import type { AppThemeSnapshot, CanvasTaskCatalog } from "@woohaa3/contracts";
import type { DialogHostApi, DialogInstance, DialogDefinition, OpenDialogRequest, OpenDialogResult } from "../services/dialogs/types.js";
import type { DialogRenderer } from "../services/dialogs/renderer-registry.js";
import type { SelectionSnapshot } from "../services/selection-store.js";
import type { ParameterPatch } from "../services/parameter-preview.js";

export interface InputScopesService {
  /** 注册一个门禁谓词（例如 modal 打开时返回 true）。 */
  addGate(gate: () => boolean): () => void;
  /** 注册到指定 scope 的门禁谓词；返回注销函数（change: unify-canvas-presentation-navigation）。 */
  addScope(scope: InputScope, gate: () => boolean): () => void;
  isActive(scope: InputScope): boolean;
  /** modal/menu/editor 任一激活时，画布 pointer/keyboard/paste/drop 门禁为 true。 */
  blocksCanvas(): boolean;
  /** 聚焦相机输入门禁。 */
  blocksFocusInput(): boolean;
}

export type InputScope = "modal" | "menu" | "editor";

export interface SelectionService {
  getSnapshot(): SelectionSnapshot;
  subscribe(listener: () => void): () => void;
  setFromRuntime(
    raw: { nodeIds: readonly string[]; primaryNodeId: string | null; editingFocus: boolean },
    validNodeIds: ReadonlySet<string>
  ): void;
  setKeyboardActive(active: boolean): void;
  reset(): void;
}

export type ParameterPreviewEntry = { patch: ParameterPatch; deadline: number };

export interface ParameterPreviewService {
  set(nodeId: string, patch: ParameterPatch, deadline?: number): void;
  get(nodeId: string): ParameterPatch | undefined;
  resolve(nodeId: string): void;
  clearAll(): void;
  entries(): ReadonlyMap<string, ParameterPreviewEntry>;
  subscribe(listener: () => void): () => void;
}

export type CatalogState =
  | { status: "loading" }
  | { status: "ready"; catalog: CanvasTaskCatalog }
  | { status: "error"; error: string };

export interface TaskCatalogService {
  getState(): CatalogState;
  subscribe(listener: () => void): () => void;
  load(force?: boolean): Promise<void>;
  invalidate(): void;
}

/** Canvas 上空闲占位（feature-owned capability；目前仅保留菜单关闭）。 */
export interface CanvasMenuService {
  close(): void;
}

/** 页面级唯一主题 owner。 */
export interface ThemeService {
  getSnapshot(): AppThemeSnapshot;
  subscribe(listener: () => void): () => void;
  setPreset(preset: unknown): { ok: true } | { ok: false; error: string };
  select(presetId: string): { ok: true } | { ok: false; error: string };
  registerPreset(presetId: string, preset: unknown): void;
  presetIds(): readonly string[];
  applyTo(root: HTMLElement): () => void;
  diagnostic(): string | null;
  dispose(): void;
}

export type {
  DialogDefinition,
  DialogInstance,
  DialogHostApi,
  OpenDialogRequest,
  OpenDialogResult,
  DialogRenderer
};
export type { DialogRendererProps } from "../services/dialogs/renderer-registry.js";
export type { StoredAsset } from "@woohaa3/contracts";
