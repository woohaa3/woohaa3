/**
 * 绘画域装配
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U36）。
 *
 * 工具轨发布**有真实画布落笔路径**的工具（任务 3.4 已完成共享接线）：
 *
 * | 工具 | 手势 | 落笔命令 | 共享画布分支 |
 * | --- | --- | --- | --- |
 * | 画笔／橡皮 | `stroke` | `paint.stroke`（共享临时笔迹 + 预览） | 已有 |
 * | 铅笔 | `stroke` | `paint.pencil` | 拖动收集 → 抬笔提交一次 |
 * | 颜色替换 | `stroke` | `paint.colorReplacement` | 同上 |
 * | 背景橡皮擦 | `stroke` | `paint.backgroundEraser` | 同上 |
 * | 渐变 | `stroke` | `paint.gradient` | 起点→终点，抬笔提交一次 |
 * | 油漆桶 | `point` | `paint.bucket` | 单击提交 |
 * | 魔术橡皮擦 | `point` | `paint.magicEraser` | 单击提交 |
 * | 吸管 | `sample` | `document.sampleColor`（只读） | 单击/拖动采样后写回前/背景色 |
 *
 * 参数编译在 `tool-modes.ts`，命令通道在 `workspace.ts`，面板在 `panels.tsx`；
 * `tool-manifest.ts` 保留同一份清单作为接线契约，域内回归逐条核对两者一致（id/手势/顺序/命令）。
 */
import { canRunPixelTool, canRunTool } from "../tool-contracts.js";
import { sections } from "./sections.js";
import { Paintbrush, Pencil, PaintBucket, Pipette, Blend } from "lucide-react";
import { EraserIcon } from "../../ui/icons.js";

export const feature = {
  id: "painting",
  tools: [
    { id: "brush", gesture: "stroke", targets: ["pixels", "mask"], canRun: canRunTool, label: "画笔", Icon: Paintbrush, order: 5 },
    { id: "eraser", gesture: "stroke", targets: ["pixels", "mask"], canRun: canRunTool, label: "橡皮", Icon: EraserIcon, order: 6 },
    { id: "pencil", gesture: "stroke", targets: ["pixels", "mask"], canRun: canRunTool, label: "铅笔", Icon: Pencil, order: 5.1 },
    { id: "colorReplacement", gesture: "stroke", targets: ["pixels"], canRun: canRunPixelTool, label: "颜色替换", Icon: Paintbrush, order: 5.2 },
    { id: "backgroundEraser", gesture: "stroke", targets: ["pixels"], canRun: canRunPixelTool, label: "背景橡皮擦", Icon: EraserIcon, order: 6.1 },
    { id: "magicEraser", gesture: "point", targets: ["pixels"], canRun: canRunPixelTool, label: "魔术橡皮擦", Icon: EraserIcon, order: 6.2 },
    { id: "gradient", gesture: "stroke", targets: ["pixels", "mask"], canRun: canRunTool, label: "渐变", Icon: Blend, order: 6.3 },
    { id: "bucket", gesture: "point", targets: ["pixels", "mask"], canRun: canRunTool, label: "油漆桶", Icon: PaintBucket, order: 6.4 },
    { id: "eyedropper", gesture: "sample", targets: ["pixels"], canRun: canRunPixelTool, label: "吸管", Icon: Pipette, order: 6.5 }
  ],
  sections,
  panels: {}
} as const;
