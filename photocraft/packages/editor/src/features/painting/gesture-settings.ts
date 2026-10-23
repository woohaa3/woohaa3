/**
 * 画布手势使用的绘画设置（React 状态 + 命令编译）
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U34 / design D1）。
 *
 * 为什么需要这一层：共享 `photo-editor-app.tsx` 的 `canvasTool` 白名单、`beginStroke` 与单击
 * 分支必须把「当前工具的设置」编译成内核命令，但**不能**把本域的参数模型塞进共享外壳。
 * 因此状态与编译都留在本域：外壳只调用这里返回的 `compile*` 函数。
 *
 * 两条硬约束：
 *
 * 1. **逐工具冻结**：每个工具有自己的设置（`tool-settings-state.ts`），切换工具不互相污染；
 * 2. **整笔冻结**：`compileStroke` 在开始一笔时调用一次，拖动中改界面不影响这一笔。
 *
 * 纯 UI 状态 + 纯编译，没有 WASM、没有文档；内核仍是唯一执行者与校验者。
 */
import { useCallback, useMemo, useState } from "react";
import {
  DEFAULT_BACKGROUND_ERASER,
  buildBackgroundEraser,
  buildBucket,
  buildColorReplacement,
  buildGradient,
  buildMagicEraser,
  buildPencil,
  buildSampleColor,
  buildSymmetry,
  buildSymmetryDisable,
  buildSymmetryFromPath,
  type SampleLayers,
  type SymmetryMode
} from "./tool-modes.js";
import type { PaintBlendMode } from "./blend-modes.js";
import { defaultPaintingToolSettings, type PaintingToolSettings } from "./tool-settings-state.js";
import type { StrokePoint } from "./stroke-points.js";

/** 一条待提交的绘画命令（id + 已编译参数）。 */
export type CompiledPaintCommand = { id: string; params: Record<string, unknown> };

export type PaintingGestureSettings = {
  settings: PaintingToolSettings;
  /** 逐字段更新某个工具的设置。 */
  update: <K extends keyof PaintingToolSettings>(key: K, patch: Partial<PaintingToolSettings[K]>) => void;
  setBlendMode(mode: PaintBlendMode): void;
  setSymmetryMode(mode: SymmetryMode): void;
  /** 拖动类工具（铅笔/颜色替换/背景橡皮）：整笔一组参数。 */
  compileStroke(tool: string, points: readonly StrokePoint[], color: string, options: { zoom?: number; target?: "pixels" | "mask" }): CompiledPaintCommand | null;
  /** 单击类工具（油漆桶/魔术橡皮）。 */
  compilePoint(tool: string, point: { x: number; y: number }, color: string, options: { target?: "pixels" | "mask" }): CompiledPaintCommand | null;
  /** 渐变：拖动起点/终点。`zoom` 只影响抖动间距，不影响端点坐标。 */
  compileGradient(from: { x: number; y: number }, to: { x: number; y: number }, options: { target?: "pixels" | "mask"; zoom?: number }): CompiledPaintCommand | null;
  /** 吸管：只读采样参数。 */
  compileSample(point: { x: number; y: number }): Record<string, unknown> | null;
  compileSymmetry(): CompiledPaintCommand | null;
  compileSymmetryFromPath(source?: string): CompiledPaintCommand | null;
  compileSymmetryDisable(): CompiledPaintCommand;
  /** 吸管写回目标。 */
  eyedropperTarget: "foreground" | "background";
  setEyedropperTarget(target: "foreground" | "background"): void;
  setSampleLayer(layer: SampleLayers): void;
};

/**
 * 画布与面板共享的绘画设置。
 *
 * 返回的函数在每次渲染更新，外壳应在事件里**立即**调用（不要在 `requestAnimationFrame` 之后
 * 再读，那时设置可能已被改）。参数非法返回 `null`，由调用方提示，不静默替换成别的值。
 */
export function usePaintingGestureSettings(width = 0, height = 0): PaintingGestureSettings {
  const [settings, setSettings] = useState<PaintingToolSettings>(() => defaultPaintingToolSettings([Math.round(width / 2), Math.round(height / 2)]));

  const update = useCallback(<K extends keyof PaintingToolSettings>(key: K, patch: Partial<PaintingToolSettings[K]>) => {
    setSettings((all) => {
      const current = all[key];
      const next = typeof current === "object" && current !== null && !Array.isArray(current)
        ? { ...(current as object), ...(patch as object) }
        : patch;
      return { ...all, [key]: next } as unknown as PaintingToolSettings;
    });
  }, []);

  const setBlendMode = useCallback((mode: PaintBlendMode) => setSettings((all) => ({ ...all, blendMode: mode })), []);
  const setSymmetryMode = useCallback((mode: SymmetryMode) => setSettings((all) => ({ ...all, symmetry: { ...all.symmetry, mode } })), []);
  const setEyedropperTarget = useCallback((target: "foreground" | "background") => setSettings((all) => ({ ...all, eyedropper: { ...all.eyedropper, target } })), []);
  const setSampleLayer = useCallback((layer: SampleLayers) => setSettings((all) => ({ ...all, eyedropper: { ...all.eyedropper, sampleLayer: layer } })), []);

  return useMemo<PaintingGestureSettings>(() => ({
    settings,
    update,
    setBlendMode,
    setSymmetryMode,
    eyedropperTarget: settings.eyedropper.target,
    setEyedropperTarget,
    setSampleLayer,
    compileStroke(tool, points, color, options) {
      switch (tool) {
        case "pencil": {
          const params = buildPencil(points, { ...settings.pencil, color }, { ...options, mode: settings.blendMode as PaintBlendMode });
          return params ? { id: "paint.pencil", params } : null;
        }
        case "colorReplacement": {
          const params = buildColorReplacement(points, settings.colorReplacement, {
            size: settings.colorReplacement.size ?? DEFAULT_BACKGROUND_ERASER.size,
            color,
            ...options
          });
          return params ? { id: "paint.colorReplacement", params } : null;
        }
        case "backgroundEraser": {
          const params = buildBackgroundEraser(points, settings.backgroundEraser, options);
          return params ? { id: "paint.backgroundEraser", params } : null;
        }
        default:
          return null;
      }
    },
    compilePoint(tool, point, color, options) {
      switch (tool) {
        case "bucket": {
          const params = buildBucket(point, color, settings.bucket, options);
          return params ? { id: "paint.bucket", params } : null;
        }
        case "magicEraser": {
          const params = buildMagicEraser(point, settings.magicEraser, options);
          return params ? { id: "paint.magicEraser", params } : null;
        }
        default:
          return null;
      }
    },
    compileGradient(from, to, options) {
      const params = buildGradient(from, to, settings.gradient, { ...options, mode: settings.blendMode as PaintBlendMode });
      return params ? { id: "paint.gradient", params } : null;
    },
    compileSample(point) {
      return buildSampleColor(point, settings.eyedropper);
    },
    compileSymmetry() {
      const params = buildSymmetry(settings.symmetry);
      return params ? { id: "paint.setSymmetry", params } : null;
    },
    compileSymmetryFromPath(source) {
      const params = buildSymmetryFromPath(source);
      return params ? { id: "paint.symmetryFromPath", params } : null;
    },
    compileSymmetryDisable() {
      return { id: "paint.symmetryDisable", params: buildSymmetryDisable() };
    }
  }), [settings, update, setBlendMode, setSymmetryMode, setEyedropperTarget, setSampleLayer]);
}
