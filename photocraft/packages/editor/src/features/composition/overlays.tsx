/**
 * 构图域的**画布叠加层出口**（U50 裁剪框 / U52 整图旋转预览 / U53 变形网格）。
 *
 * 叠加层本身按共享画布的投影约定实现（`origin`/`zoom` → 文档像素），但**挂载点**属于共享
 * 装配：`photo-editor-app.tsx` 的 `renderOverlay(origin, zoom)` 槽位由集成负责人维护，本域
 * 无权往那里加分支。因此这里只提供可挂载的组件与它们的域名，集成侧按下面形状接一次即可：
 *
 * ```tsx
 * renderOverlay={(origin, zoom) => <>
 *   …existing overlays…
 *   <CompositionOverlay state={compositionOverlayState} origin={origin} zoom={zoom} />
 * </>}
 * ```
 *
 * `CompositionOverlay` 自己决定渲染哪一个（裁剪工具激活 → 裁剪框；整图旋转预览激活 →
 * 旋转框；变形工具激活 → 网格），都不活跃时返回 `null`，因此集成侧不需要第二个开关状态。
 *
 * 组件与几何都已用 jsdom 测过；未挂载时它们不参与渲染，也不改变任何文档状态。
 */

import { useEffect, useState, type ReactNode } from "react";
import { CropOverlay } from "./crop-overlay.js";
import { RotationOverlay } from "./rotation-overlay.js";
import { WarpOverlay } from "./warp-overlay.js";
import { compositionOverlayState, subscribeCompositionOverlay } from "./overlay-store.js";
import type { CropFrameRect } from "./crop-frame.js";
import type { WarpMesh } from "./workflows.js";
import type { RotationFootprint } from "./rotation-frame.js";

export { CropOverlay, RotationOverlay, WarpOverlay };
export type { CropFrameRect, RotationFootprint, WarpMesh };

/** 叠加层的域名：集成侧据此判断「当前是否有构图叠加层要画」。 */
export const COMPOSITION_OVERLAY_SLOTS = ["composition.crop", "composition.rotate", "composition.warp"] as const;
export type CompositionOverlaySlot = (typeof COMPOSITION_OVERLAY_SLOTS)[number];

/**
 * 叠加层需要的域状态。由面板/工具控制器提供，不由叠加层自己猜测。
 *
 * `active` 为 `null` 表示当前没有构图叠加层；各分支互斥，避免裁剪框、旋转预览和网格
 * 同时抢占指针。
 */
export type CompositionOverlayState =
  | {
      active: "crop";
      frame: CropFrameRect;
      document: { width: number; height: number };
      angle?: number;
      ratio?: number | null;
      grid?: "none" | "thirds" | "grid";
      allowOutside?: boolean;
      onFrameChange?: (frame: CropFrameRect) => void;
      onStraightenChange?: (angle: number) => void;
      onApply?: (frame: CropFrameRect, angle: number) => void;
    }
  | {
      active: "warp";
      rect: [number, number, number, number];
      mesh: WarpMesh;
      showMesh?: boolean;
      onMeshChange?: (mesh: WarpMesh) => void;
      onApply?: (mesh: WarpMesh, changed: boolean) => void;
      onSplit?: (at: [number, number]) => void;
    }
  | {
      active: "rotate";
      /** 当前画布尺寸（旋转前）。 */
      document: { width: number; height: number };
      /** 预览角度（度，顺时针为正）。 */
      angle: number;
      snap?: number;
      onAngleChange?: (angle: number) => void;
      onApply?: (angle: number) => void;
    }
  | { active: null };

export type CompositionOverlayProps = {
  state: CompositionOverlayState;
  origin: { x: number; y: number };
  zoom: number;
  readonly?: boolean;
  onGestureChange?: (active: boolean) => void;
};

/**
 * 画布叠加层入口：按域状态渲染裁剪框、整图旋转预览或变形网格。
 *
 * 不读控制器、不读文档：状态由调用方给，`EditorWorkspaceController` 只在挂载侧用于取
 * `origin`/`zoom` 与提交回调，避免叠加层变成第二个状态源。
 */
export function CompositionOverlay({ state, origin, zoom, readonly = false, onGestureChange }: CompositionOverlayProps): ReactNode {
  if (state.active === "crop") {
    return (
      <CropOverlay
        frame={state.frame}
        document={state.document}
        origin={origin}
        zoom={zoom}
        angle={state.angle}
        ratio={state.ratio ?? null}
        grid={state.grid ?? "thirds"}
        allowOutside={state.allowOutside ?? true}
        readonly={readonly}
        onFrameChange={state.onFrameChange}
        onStraightenChange={state.onStraightenChange}
        onApply={state.onApply}
        onGestureChange={onGestureChange}
      />
    );
  }
  if (state.active === "rotate") {
    return (
      <RotationOverlay
        document={state.document}
        origin={origin}
        zoom={zoom}
        angle={state.angle}
        snap={state.snap}
        readonly={readonly}
        onAngleChange={state.onAngleChange}
        onApply={state.onApply}
        onGestureChange={onGestureChange}
      />
    );
  }
  if (state.active === "warp") {
    return (
      <WarpOverlay
        rect={state.rect}
        mesh={state.mesh}
        origin={origin}
        zoom={zoom}
        showMesh={state.showMesh ?? true}
        readonly={readonly}
        onMeshChange={state.onMeshChange}
        onApply={state.onApply}
        onSplit={state.onSplit}
        onGestureChange={onGestureChange}
      />
    );
  }
  return null;
}

/**
 * 共享装配用的挂载组件：自己订阅域内叠加层状态，因此在 `renderOverlay` 槽位里只需
 * `<MountedCompositionOverlay origin={origin} zoom={zoom} />` 一行，不需要把域状态穿过
 * 共享组件树。没有活跃叠加层时保持不渲染。
 */
export function MountedCompositionOverlay({ origin, zoom, readonly = false }: {
  origin: { x: number; y: number };
  zoom: number;
  readonly?: boolean;
}): ReactNode {
  const [state, setState] = useState<CompositionOverlayState | null>(() => compositionOverlayState());
  useEffect(() => subscribeCompositionOverlay(setState), []);
  if (!state) return null;
  return <CompositionOverlay state={state} origin={origin} zoom={zoom} readonly={readonly} />;
}
