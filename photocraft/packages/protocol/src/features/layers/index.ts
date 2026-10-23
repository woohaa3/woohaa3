/**
 * 本域能力声明。
 *
 * 能力清单是**跨语言契约**：Rust `capability.rs`（经 `FEATURES` 的各域 `CONTRIBUTION` 聚合）
 * ↔ 本文件 ↔ `tests/fixtures/contract.json` ↔ `tests/fixtures/feature-boundary-baseline.json`
 * ↔ 真实 WASM 快照 `tests/fixtures/feature-boundary-wasm-baseline.json`。五处必须同序同值，
 * `features:check` 与两侧 fixture 测试会立即发现漂移。
 *
 * U57–U64 的新能力 id 以 `order` 21 起追加在 `P0` 尾部：既有前缀（0–20，本域与
 * `compose.transform` / `selection.*` / `paint.*` / `text.horizontal` / `adjust.*` 共用）
 * 保持不变，新能力因此不影响任何既有序号与发布顺序。
 */
export const feature = {
  id: "layers",
  capabilities: [
    { stage: "P0", order: 0, id: "layers.composite" },
    { stage: "P0", order: 1, id: "layers.fill-opacity" },
    { stage: "P0", order: 2, id: "layers.styles.resource-free" },
    { stage: "P0", order: 3, id: "layers.styles.patterns" },
    { stage: "P0", order: 4, id: "layers.groups" },
    { stage: "P0", order: 5, id: "layers.blend.pass-through" },
    { stage: "P0", order: 6, id: "layers.blend.photoshop" },
    { stage: "P0", order: 7, id: "layers.blend.normal" },
    { stage: "P0", order: 8, id: "layers.blend.multiply" },
    { stage: "P0", order: 9, id: "layers.blend.screen" },
    { stage: "P0", order: 21, id: "layers.fill" },
    { stage: "P0", order: 22, id: "layers.links-and-labels" },
    { stage: "P0", order: 23, id: "layers.stamp-and-background" },
    { stage: "P0", order: 24, id: "layers.paste-into-outside" },
    { stage: "P0", order: 25, id: "layers.advanced-blending" },
    { stage: "P0", order: 26, id: "layers.style-presets" },
    { stage: "P0", order: 27, id: "layers.matting" },
    { stage: "P0", order: 28, id: "layers.layer-comps" },
    { stage: "P2", order: 0, id: "edit.layer-transfer" },
    { stage: "P2", order: 1, id: "edit.workspace-clipboard" },
    { stage: "P2", order: 2, id: "edit.paste-in-place" },
    { stage: "P7", order: 5, id: "layer.filter-list" },
  ]
} as const;

export {
  LAYER_EFFECT_KINDS,
  LAYER_FILL_KINDS,
  LAYER_FILL_LIMITS,
  LAYER_FILTER_COMBINATION_NOTE,
  LAYER_KNOCKOUTS,
  MAX_LAYER_COMPS,
  STYLE_PRESET_ACTIONS,
  blendingParamError,
  layerCompParamError,
  layerFillParamError,
  layerFilterActive,
  layerFilterParamError,
  layerFillCommandParams,
  layerStylePresetParamError,
  mattingParamError,
} from "./workflows.js";
export type {
  BlendIfEntry,
  BlendIfRange,
  LayerFillKind,
  LayerLabelColor,
  LayerKnockout,
  StylePresetAction,
} from "./workflows.js";
