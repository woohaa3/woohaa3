//! 矢量域：形状、路径、布尔运算、矢量蒙版与形状预设
//! （change: 2026-10-22-add-photocraft-vector-canvas-tools，U08–U16）。
//!
//! 目录分工（与 `notes/feature-boundaries.md` 一致）：
//! - `mod.rs`：本域阶段能力与命令贡献，是 `capability.rs` 白名单的唯一来源之一；
//! - `composition_domain.rs`：命令白名单、参数范围校验、形状/蒙版/布尔/预设入口与快照；
//! - `gestures.rs`：画布拖绘 → 规范形状参数的纯几何换算（拖绘预览与数值创建共用）；
//! - `presets.rs`：自定形状库的有界快照/恢复/删除与几何摘要；
//! - `path_edit.rs`：锚点级编辑的参数裁定与命中换算；
//! - `tools.rs` / `wasm.rs`：`Editor` 与 WASM 的入口，不另建引擎或文档。
//!
//! 装配（画布手势注册、属性面板位置、工具条按钮）由集成会话写入共享 shell；本域只提供
//! 显式贡献，供其直接引用，不复制第二套几何或历史。
use super::{FeatureContribution, StagedId};

pub mod gestures;
pub mod path_edit;
pub mod presets;

#[cfg(test)]
mod tests;

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "vectors",
    capabilities: &[
        StagedId { stage: "P7", order: 7, id: "vector.path" },
        StagedId { stage: "P7", order: 8, id: "vector.shape" },
        StagedId { stage: "P7", order: 9, id: "vector.mask" },
    ],
    commands: &[
        StagedId { stage: "P7", order: 15, id: "path.list" },
        StagedId { stage: "P7", order: 16, id: "path.info" },
        StagedId { stage: "P7", order: 17, id: "path.set" },
        StagedId { stage: "P7", order: 18, id: "path.delete" },
        StagedId { stage: "P7", order: 19, id: "path.rename" },
        StagedId { stage: "P7", order: 20, id: "path.transform" },
        StagedId { stage: "P7", order: 21, id: "path.toSelection" },
        StagedId { stage: "P7", order: 22, id: "path.fill" },
        StagedId { stage: "P7", order: 23, id: "path.stroke" },
        StagedId { stage: "P7", order: 24, id: "path.clippingPath.set" },
        StagedId { stage: "P7", order: 25, id: "path.clippingPath.clear" },
        // U12：锚点级编辑（上游 `path_edit_cmds`，一次拖动一步历史）。
        StagedId { stage: "P7", order: 38, id: "path.moveAnchors" },
        StagedId { stage: "P7", order: 39, id: "path.moveHandle" },
        StagedId { stage: "P7", order: 40, id: "path.bendSegment" },
        StagedId { stage: "P7", order: 41, id: "path.convertPoint" },
        StagedId { stage: "P7", order: 42, id: "path.addAnchor" },
        StagedId { stage: "P7", order: 43, id: "path.deleteAnchor" },
        // U14：形状布尔运算（整体提交，一步撤销恢复原组件）。
        StagedId { stage: "P7", order: 44, id: "layer.combineShapes.unite" },
        StagedId { stage: "P7", order: 45, id: "layer.combineShapes.subtractFrontShape" },
        StagedId { stage: "P7", order: 46, id: "layer.combineShapes.intersectShapeAreas" },
        StagedId { stage: "P7", order: 47, id: "layer.combineShapes.excludeOverlappingShapes" },
        StagedId { stage: "P7", order: 48, id: "layer.combineShapes.mergeShapeComponents" },
        // U16：形状预设库与 Define Custom Shape。
        StagedId { stage: "P7", order: 49, id: "shape.presets.list" },
        StagedId { stage: "P7", order: 50, id: "shape.presets.place" },
        StagedId { stage: "P7", order: 51, id: "shape.presets.new" },
        StagedId { stage: "P7", order: 52, id: "shape.presets.edit" },
        StagedId { stage: "P7", order: 53, id: "shape.presets.reset" },
        StagedId { stage: "P7", order: 54, id: "edit.defineCustomShape" },
        // U15：直接编辑现有矢量蒙版路径（全显/全隐与栅格化在 layers 域已开放）。
        StagedId { stage: "P7", order: 55, id: "layer.vectorMask.edit" },
        StagedId { stage: "P7", order: 56, id: "layer.vectorMask.currentPath" },
    ],
};

#[cfg(test)]
mod contribution_tests {
    use super::*;

    /// 本 change 之前就存在的 P7 命令（序号由集成基线固定，不能重排）。
    const PRIOR_VECTOR_COMMANDS: &[&str] = &[
        "path.list",
        "path.info",
        "path.set",
        "path.delete",
        "path.rename",
        "path.transform",
        "path.toSelection",
        "path.fill",
        "path.stroke",
        "path.clippingPath.set",
        "path.clippingPath.clear",
    ];

    fn ids() -> Vec<&'static str> {
        CONTRIBUTION.commands.iter().map(|entry| entry.id).collect()
    }

    #[test]
    fn every_contributed_command_is_also_in_the_domain_whitelist() {
        // 两处清单必须逐项一致：能力白名单（`capability.rs`）与 `vector_command` 入口共用。
        for id in ids() {
            assert!(
                crate::composition::VECTOR_COMMANDS.contains(&id)
                    || crate::features::layers::CONTRIBUTION.commands.iter().any(|entry| entry.id == id),
                "{id} 在能力贡献里但没有执行入口，UI 会渲染出不可用按钮"
            );
        }
    }

    #[test]
    fn p7_command_orders_stay_unique_and_new_ones_follow_the_prior_block() {
        let mut orders: Vec<usize> = CONTRIBUTION
            .commands
            .iter()
            .filter(|entry| entry.stage == "P7")
            .map(|entry| entry.order)
            .collect();
        let count = orders.len();
        orders.sort_unstable();
        orders.dedup();
        assert_eq!(orders.len(), count, "同一域内 P7 命令序号重复");
        // 既有 11 条（path.list … path.clippingPath.clear）保持原序号；新增命令接在 37 之后。
        for entry in CONTRIBUTION.commands.iter().filter(|entry| entry.stage == "P7") {
            if !PRIOR_VECTOR_COMMANDS.contains(&entry.id) {
                assert!(entry.order >= 38, "{} 的序号必须接在 37（select.convertToShape）之后", entry.id);
            }
        }
    }

    #[test]
    fn new_command_ids_exist_in_the_engine_registry_and_pass_the_gate() {
        for id in [
            "path.moveAnchors",
            "path.moveHandle",
            "path.bendSegment",
            "path.convertPoint",
            "path.addAnchor",
            "path.deleteAnchor",
            "layer.combineShapes.unite",
            "layer.combineShapes.subtractFrontShape",
            "layer.combineShapes.intersectShapeAreas",
            "layer.combineShapes.excludeOverlappingShapes",
            "layer.combineShapes.mergeShapeComponents",
            "shape.presets.list",
            "shape.presets.place",
            "shape.presets.new",
            "shape.presets.edit",
            "shape.presets.reset",
            "edit.defineCustomShape",
            "layer.vectorMask.edit",
            "layer.vectorMask.currentPath",
        ] {
            assert!(photocraft_engine::commands::find(id).is_some(), "{id} 不在上游注册表");
            assert!(crate::capability::command_allowed(id), "{id} 未被能力门放行");
        }
    }
}
