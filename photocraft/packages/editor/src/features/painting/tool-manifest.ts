/**
 * 绘画工具接线契约
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27/U28/U29/U31/U34）。
 *
 * 工具轨条目（`index.ts`）、面板工具（`panels.tsx` 的 `PAINTING_PANEL_TOOLS`）、像素命令通道
 * （`workspace.ts` 的 `PAINT_CONTENT_COMMANDS`）与共享画布分支（`photo-editor-app.tsx` 的
 * `canvasTool`/`beginPaintStroke`/`commitPaintPoint`）说的是同一批工具。这个模块只声明
 * **唯一的接线表**：
 *
 * - `id` 与面板、协议 `PAINTING_TOOL_IDS` 同名；
 * - `gesture` 决定共享画布用哪种手势（`stroke` 拖动 / `point` 单击 / `sample` 采样）；
 * - `command` 是落笔时提交的内核命令 id（吸管走只读采样，不是像素命令）；
 * - `order` 决定工具轨位置。
 *
 * 域内回归（`workflow-state.test.ts`）逐条比对它与 `feature.tools` 一致，因此「清单写了但没发布」
 * 或「发布了但清单没写」都会失败，不会再出现点了没反应的假入口。这些工具**已全部发布**在工具轨
 * 上，所以这张表如今是「已接线事实」而非待办清单。
 */

export type PaintingToolWiring = {
  /** 与 `painting/panels.tsx` 的 `PAINTING_PANEL_TOOLS`、协议 `PAINTING_TOOL_IDS` 同名。 */
  id: "pencil" | "colorReplacement" | "backgroundEraser" | "magicEraser" | "gradient" | "bucket" | "eyedropper";
  label: string;
  /** 画布手势：拖动 / 单击 / 采样（沿用共享画布已有的四种）。 */
  gesture: "stroke" | "point" | "sample";
  /** 可写目标。 */
  targets: readonly ("pixels" | "mask")[];
  /** 落笔时提交的内核命令。 */
  command: string;
  /** 工具轨顺序（插在画笔/橡皮附近，与 Photoshop 一致）。 */
  order: number;
  /** 共享画布/宿主需要在哪个分支处理它（一句话说明，防止接线时漏一半）。 */
  wiring: string;
};

export const PAINTING_TOOL_WIRING: readonly PaintingToolWiring[] = [
  {
    id: "pencil",
    label: "铅笔",
    gesture: "stroke",
    targets: ["pixels", "mask"],
    command: "paint.pencil",
    order: 5.1,
    wiring: "已接线：`stroke` 手势收集点位，抬笔用 `buildPencil` 提交一次（hardness=1、autoErase、mode），`color` 取当前前景色。"
  },
  {
    id: "colorReplacement",
    label: "颜色替换",
    gesture: "stroke",
    targets: ["pixels"],
    command: "paint.colorReplacement",
    order: 5.2,
    wiring: "已接线：`stroke` 手势，抬笔用 `buildColorReplacement`（mode/tolerance/sampling/limits/antiAlias + 自己的 size）。"
  },
  {
    id: "backgroundEraser",
    label: "背景橡皮擦",
    gesture: "stroke",
    targets: ["pixels"],
    command: "paint.backgroundEraser",
    order: 6.1,
    wiring: "已接线：`stroke` 手势，抬笔用 `buildBackgroundEraser`，不走 `erase` 布尔。"
  },
  {
    id: "magicEraser",
    label: "魔术橡皮擦",
    gesture: "point",
    targets: ["pixels"],
    command: "paint.magicEraser",
    order: 6.2,
    wiring: "已接线：`point` 手势按下即提交 `buildMagicEraser`（一个事务，无拖动预览）。"
  },
  {
    id: "gradient",
    label: "渐变",
    gesture: "stroke",
    targets: ["pixels", "mask"],
    command: "paint.gradient",
    order: 6.3,
    wiring: "已接线：`stroke` 手势取首末点交给 `buildGradient`；拖动中不落像素，松手提交一次（端点重合则提示不提交）。"
  },
  {
    id: "bucket",
    label: "油漆桶",
    gesture: "point",
    targets: ["pixels", "mask"],
    command: "paint.bucket",
    order: 6.4,
    wiring: "已接线：`point` 手势按下即提交 `buildBucket`（容差 0–255、contiguous、sampleAllLayers、opacity）。"
  },
  {
    id: "eyedropper",
    label: "吸管",
    gesture: "sample",
    targets: ["pixels"],
    command: "document.sampleColor",
    order: 6.5,
    wiring: "已接线：`sample` 手势不需 Alt，按下与拖动持续走 `sampleColorOptions`（尺寸/图层策略），抬笔再取一次；结果经 `setColor` 写前景或背景色。"
  }
];
