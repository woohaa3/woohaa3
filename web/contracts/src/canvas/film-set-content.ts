/**
 * `composite-asset` 片场内部内容契约公共入口
 * （change: 2026-10-08-make-film-set-model-only，任务 1.2 / design D3；
 *  change: 2026-10-09-add-film-set-object-motion-and-editing，任务 2.1 / design D1；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R19 —— 拆分为
 *  类型、codec、motion、import-plan 与 part-identity 子模块）。
 *
 * 片场（`composite-asset`）在自身 flat nodeData 中额外保存一个**严格版本化**的内容集合
 * `filmSetContent`：内部模型快照、图片/视频平面与可编辑地面。集合是片场身份的一部分，
 * 参与保存、复制、历史与资产引用保护；**不**借用通用 envelope 或任何 opaque plugin state。
 *
 * 设计要点：
 * - 每个对象有稳定、集合内唯一的 `id` 与合法 `kind`、名称、有限 `localTransform`；
 * - `model` 对象保存完整 `ModelDefinition` 快照；
 * - `image`/`video` 只引用匹配类型的稳定 ready asset（`assetId` + 固有宽高比）；
 * - `ground` 为普通可编辑可删除对象；
 * - 集合可为空；缺失集合按新空集合解释；
 * - schema 3 仅保存几何，所有动作只保存于片段 binding；旧 schema 1/2 只由离线 reader 转换。
 *
 * 本文件为稳定 barrel；解码/身份/导入实现分别在 `film-set-content/` 子模块，内部直接导入
 * 叶子模块，不反向 import 本文件。
 */

// 类型与常量叶子。
export * from "./film-set-content/types.js";

// 严格解码、读取与克隆。
export * from "./film-set-content/codec.js";

// 对象动作：局部时间、适配关联、源码预算。
export * from "./film-set-content/motion.js";

// 内容身份、默认内容、导入规划与时间线时长。
export * from "./film-set-content/import-plan.js";

// 稳定对象/部件身份编码。
export * from "./film-set-content/part-identity.js";
