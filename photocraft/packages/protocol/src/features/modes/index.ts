/**
 * 图像模式与调色板（U45）的协议声明
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 1.2 / design D1/D3）。
 *
 * 与其他域一致，协议域只声明能力/命令清单；模式参数、上限、工具与导出矩阵在编辑器的本域目录
 * （`packages/editor/src/features/modes/`），模式数据与像素的权威表示在 Rust 内核
 * （`rust/crates/editor-core/src/features/modes/`）。内容身份字段见 [`content.ts`](./content.ts)。
 *
 * 能力在 P7 发布：`capabilities` 里的三个 id 与 Rust
 * `features/modes::CAPABILITIES`、`tests/fixtures/contract.json` 逐项一致，由测试锁定。
 */

/** 本域能力 id（已在 P7 发布；与 Rust `features/modes::CAPABILITIES` 逐项一致）。 */
export const IMAGE_MODE_CAPABILITIES = ["image.modes", "image.color-table", "image.duotone"] as const;
export type ImageModeCapability = (typeof IMAGE_MODE_CAPABILITIES)[number];

/** 本域命令 id（与 Rust `features/modes::COMMANDS` 逐项一致）。 */
export const IMAGE_MODE_COMMANDS = [
  "image.mode.rgb",
  "image.mode.grayscale",
  "image.mode.indexedColor",
  "image.mode.bitmap",
  "image.mode.duotone",
  "image.mode.colorTable"
] as const;
export type ImageModeCommand = (typeof IMAGE_MODE_COMMANDS)[number];

export const feature = {
  id: "modes",
  capabilities: [
    { stage: "P7", order: 40, id: "image.modes" },
    { stage: "P7", order: 41, id: "image.color-table" },
    { stage: "P7", order: 42, id: "image.duotone" }
  ]
} as const;

/**
 * 命令清单（发布事实，供编辑器与核验对齐）。
 *
 * 注意：能力握手只包含 `capabilities`；命令白名单由 Rust `capability::allowed_command_ids`
 * 唯一持有，这里列出来是为了让两端清单可逐项核对，不构成第二套门禁。
 */
export const featureCommands = [
  { stage: "P7", order: 40, id: "image.mode.rgb" },
  { stage: "P7", order: 41, id: "image.mode.grayscale" },
  { stage: "P7", order: 42, id: "image.mode.indexedColor" },
  { stage: "P7", order: 43, id: "image.mode.bitmap" },
  { stage: "P7", order: 44, id: "image.mode.duotone" },
  { stage: "P7", order: 45, id: "image.mode.colorTable" }
] as const;
