/**
 * 滤镜域（U46–U49）的纯数据声明：交互形态、预算下限与明确排除项。
 *
 * 这里**不新增能力 id**：已交付能力清单由 `tests/fixtures/contract.json` 与 Rust 侧能力握手
 * 共同钉住，新增 id 需要集成负责人同步两端。本文件只为滤镜工作流提供可比较的纯数据，
 * 供界面解码内核清单时做下界校验（内核可以更严，不能比这里宽），以及发布说明逐项列明暂缓范围。
 *
 * 数值与 `rust/crates/editor-core/src/features/filters/catalog.rs` 的 `MAX_*` 常量一致；
 * 运行时权威是内核 `catalogue().limits`，本文件是协议声明的**下界**。
 */

/** 滤镜交互形态（与 Rust `catalog::Kind` 一一对应）。 */
export const FILTER_WORKFLOW_KINDS = [
  "simple",
  "random",
  "gallery",
  "galleryStack",
  "blurGallery",
  "lens",
  "cameraRaw",
  "vanishingPoint"
] as const;

export type FilterWorkflowKind = (typeof FILTER_WORKFLOW_KINDS)[number];

/**
 * 滤镜工作流的协议预算下限。
 *
 * - `maxEffects`：一次 Filter Gallery 组合最多的效果层数；
 * - `maxPins`：模糊画廊控制点与光照/粘贴项上限；
 * - `maxPlanes`：消失点透视平面上限；
 * - `maxParams`：单条命令的参数项上限；
 * - `maxResourcePoints`：位移点、约束线与克隆路径的点数上限；
 * - `seedMax`：随机滤镜冻结 seed 的合法上界（u32）。
 */
export const FILTER_WORKFLOW_LIMITS = {
  maxEffects: 32,
  maxPins: 16,
  maxPlanes: 8,
  maxParams: 96,
  maxResourcePoints: 64,
  seedMax: 4_294_967_295
} as const;

export type FilterWorkflowLimits = Record<keyof typeof FILTER_WORKFLOW_LIMITS, number>;

/**
 * 明确不在本域范围的行为：不提供入口、也不作为「暂未接通」计入完成度。
 *
 * 与 `PHOTOCRAFT_NON_GOALS` 的措辞一致；这里只列滤镜域相关的四项加原生执行路径。
 */
export const FILTER_WORKFLOW_NON_GOALS = [
  { id: "filter.liquify", label: "液化", reason: "液化工作区不在本 change 范围，入口保持关闭" },
  { id: "layer.smart-filter", label: "智能滤镜栈", reason: "不引入持久智能滤镜栈；画廊组合按 D4 一次性落为像素" },
  { id: "format.raw-decode", label: "RAW 解码", reason: "Camera Raw 滤镜只是 RGB/U8 摄影调节，不提供 RAW 文件解码" },
  { id: "modes.hdr", label: "HDR", reason: "不引入高动态范围色彩承诺" },
  { id: "filter.native-only", label: "原生专用执行路径", reason: "不能编译进 WASM 的原生路径不随本域发布" }
] as const;

export type FilterWorkflowNonGoal = (typeof FILTER_WORKFLOW_NON_GOALS)[number];

/** 某命令是否落在明确排除项里（面板据此不显示入口，也不需要「暂缓」占位）。 */
export function isFilterWorkflowExcluded(id: string): boolean {
  return FILTER_WORKFLOW_NON_GOALS.some((entry) => entry.id === id);
}

export const feature = {
  id: "filters",
  capabilities: [
    { stage: "P6", order: 3, id: "filter.blur-gaussian" },
    { stage: "P6", order: 4, id: "filter.sharpen-usm" },
  ]
} as const;
