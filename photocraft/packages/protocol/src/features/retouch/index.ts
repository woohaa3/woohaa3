/**
 * 修饰域的能力声明（change: 2026-10-22-add-photocraft-retouch-workflows，U37/U38/U39）。
 *
 * **本域暂不在此处新增能力 id。** 能力 id 是全局聚合数据：`PHOTOCRAFT_STAGE_CAPABILITIES`
 * 由 `features/*` 汇总，并与 `tests/fixtures/contract.json`、`tests/fixtures/feature-boundary-baseline.json`
 * 逐项对照，这三处由集成负责人单一写入。U37/U38/U39 的像素/历史/工程往返验收与聚合必须同时
 * 完成，否则会出现「UI 声明已开放、链路未接通」或与共享 fixture 不一致的假交付。
 *
 * 本域已经可以通过唯一命令门立即放行的是**命令**（见 Rust `features/retouch/mod.rs` 的
 * `commands`）；待聚合的能力 id 与阻塞细节见该 change 的 `verification.md`「集成阻塞」。
 */
export const feature = {
  id: "retouch",
  capabilities: [
    { stage: "P6", order: 0, id: "tool.clone" },
    { stage: "P6", order: 1, id: "tool.healing" },
    { stage: "P6", order: 2, id: "tool.retouch-brush" },
    // U37：区域命令与移除。
    { stage: "P6", order: 40, id: "retouch.patch" },
    { stage: "P6", order: 41, id: "retouch.content-aware-move" },
    { stage: "P6", order: 42, id: "retouch.remove" },
    { stage: "P6", order: 43, id: "retouch.red-eye" },
    // U38：图案图章与历史画笔。
    { stage: "P6", order: 44, id: "retouch.pattern-stamp" },
    { stage: "P6", order: 45, id: "retouch.history-brush" },
    // U39：逐工具参数与多仿制源。
    { stage: "P6", order: 46, id: "retouch.tool-options" },
    { stage: "P6", order: 47, id: "retouch.clone-sources" },
  ]
} as const;

/**
 * 本域发布的能力 id（U37/U38/U39）。
 *
 * 与 Rust `features/retouch/mod.rs` 的 `PENDING_CAPABILITIES` 同序同值，且已同时进入
 * `feature.capabilities`、`tests/fixtures/contract.json` 的 `P6` 与两份
 * `tests/fixtures/feature-boundary-*.json`。任一侧漏改都会让 `contract_fixture`/`features:check` 失败，
 * 因此不存在「UI 说有、链未接通」的假开放。
 */
export const PENDING_RETOUCH_CAPABILITIES = [
  "retouch.patch",
  "retouch.content-aware-move",
  "retouch.remove",
  "retouch.red-eye",
  "retouch.pattern-stamp",
  "retouch.history-brush",
  "retouch.tool-options",
  "retouch.clone-sources"
] as const;

export type PendingRetouchCapability = (typeof PENDING_RETOUCH_CAPABILITIES)[number];
