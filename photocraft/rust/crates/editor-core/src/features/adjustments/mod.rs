use super::{FeatureContribution, StagedId};

/// U40/U41/U42 直接调整的目标与参数白名单（草稿由 `adjustment_preview` 统一持有）。
pub mod direct_adjustment;

/// 两条流程（直接像素 / 调整层）的事务证据；只查状态、历史与指纹，不渲染。
#[cfg(test)]
#[path = "tests_direct_workflow.rs"]
mod tests_direct_workflow;

/// U43/U44 逐类效果证据：在隔离会话里跑真实上游命令，只读像素样本。
#[cfg(test)]
#[path = "tests_kind_effects.rs"]
mod tests_kind_effects;

/// 调整域的能力与命令贡献。
///
/// 本 change 之前，`image.adjustments.*` 与 `layer.newAdjustmentLayer.*` 的既有六类散落在
/// `composition` / `layers` 两个兄弟域里，新增类型只能由集成负责人跨域追加。发布本 change 时
/// 反过来落位：**调整域自己发布自己的类型与命令**，兄弟域保持不动。聚合端
/// （[`crate::features::commands_for_stage`] / [`crate::capability::allowed_command_ids`]）只做
/// 拼接、排序与去重，所以同一个 id 由哪个贡献声明不影响最终白名单；这里不再声明兄弟域已有的
/// 六个 id，避免同一 id 在能力表里出现两次。
///
/// 每条命令都对应上游注册表里真实存在的命令（`capability.rs` 的
/// `every_allowed_command_exists_in_the_engine_registry` 会逐条核对）。
pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "adjustments",
    capabilities: &[
        StagedId { stage: "P0", order: 18, id: "adjust.brightness-contrast" },
        StagedId { stage: "P0", order: 19, id: "adjust.hue-saturation" },
        StagedId { stage: "P0", order: 20, id: "adjust.curves" },
        StagedId { stage: "P5", order: 0, id: "adjust.levels" },
        StagedId { stage: "P5", order: 1, id: "adjust.channel-curves" },
        StagedId { stage: "P5", order: 2, id: "adjust.vibrance" },
        StagedId { stage: "P5", order: 3, id: "adjust.black-white" },
        StagedId { stage: "P5", order: 4, id: "analysis.histogram" },
        // U41/U42 的高级选项：输出端点、铅笔/平滑、六色域、Tint 都是可保存的持久参数，
        // 与「能改」的入口分开计数（它们的界面控件与核验各自独立）。
        StagedId { stage: "P5", order: 10, id: "adjust.levels-output" },
        StagedId { stage: "P5", order: 11, id: "adjust.curve-pencil" },
        StagedId { stage: "P5", order: 12, id: "adjust.hue-ranges" },
        StagedId { stage: "P5", order: 13, id: "adjust.black-white-tint" },
        // U43：九类新增逐类调整（直接调整 + 调整层）。
        StagedId { stage: "P5", order: 14, id: "adjust.exposure" },
        StagedId { stage: "P5", order: 15, id: "adjust.color-balance" },
        StagedId { stage: "P5", order: 16, id: "adjust.photo-filter" },
        StagedId { stage: "P5", order: 17, id: "adjust.channel-mixer" },
        StagedId { stage: "P5", order: 18, id: "adjust.invert" },
        StagedId { stage: "P5", order: 19, id: "adjust.posterize" },
        StagedId { stage: "P5", order: 20, id: "adjust.threshold" },
        StagedId { stage: "P5", order: 21, id: "adjust.gradient-map" },
        StagedId { stage: "P5", order: 22, id: "adjust.selective-color" },
        // U44：自动校正与匹配/替换颜色。
        StagedId { stage: "P5", order: 23, id: "adjust.auto-tone" },
        StagedId { stage: "P5", order: 24, id: "adjust.auto-contrast" },
        StagedId { stage: "P5", order: 25, id: "adjust.auto-color" },
        StagedId { stage: "P5", order: 26, id: "adjust.desaturate" },
        StagedId { stage: "P5", order: 27, id: "adjust.equalize" },
        StagedId { stage: "P5", order: 28, id: "adjust.shadows-highlights" },
        StagedId { stage: "P5", order: 29, id: "adjust.replace-color" },
        StagedId { stage: "P5", order: 30, id: "adjust.match-color" },
    ],
    commands: &[
        StagedId { stage: "P5", order: 20, id: "image.adjustments.exposure" },
        StagedId { stage: "P5", order: 21, id: "image.adjustments.colorBalance" },
        StagedId { stage: "P5", order: 22, id: "image.adjustments.photoFilter" },
        StagedId { stage: "P5", order: 23, id: "image.adjustments.channelMixer" },
        StagedId { stage: "P5", order: 24, id: "image.adjustments.invert" },
        StagedId { stage: "P5", order: 25, id: "image.adjustments.posterize" },
        StagedId { stage: "P5", order: 26, id: "image.adjustments.threshold" },
        StagedId { stage: "P5", order: 27, id: "image.adjustments.gradientMap" },
        StagedId { stage: "P5", order: 28, id: "image.adjustments.selectiveColor" },
        StagedId { stage: "P5", order: 29, id: "layer.newAdjustmentLayer.exposure" },
        StagedId { stage: "P5", order: 30, id: "layer.newAdjustmentLayer.colorBalance" },
        StagedId { stage: "P5", order: 31, id: "layer.newAdjustmentLayer.photoFilter" },
        StagedId { stage: "P5", order: 32, id: "layer.newAdjustmentLayer.channelMixer" },
        StagedId { stage: "P5", order: 33, id: "layer.newAdjustmentLayer.invert" },
        StagedId { stage: "P5", order: 34, id: "layer.newAdjustmentLayer.posterize" },
        StagedId { stage: "P5", order: 35, id: "layer.newAdjustmentLayer.threshold" },
        StagedId { stage: "P5", order: 36, id: "layer.newAdjustmentLayer.gradientMap" },
        StagedId { stage: "P5", order: 37, id: "layer.newAdjustmentLayer.selectiveColor" },
        StagedId { stage: "P5", order: 38, id: "image.autoTone" },
        StagedId { stage: "P5", order: 39, id: "image.autoContrast" },
        StagedId { stage: "P5", order: 40, id: "image.autoColor" },
        StagedId { stage: "P5", order: 41, id: "image.adjustments.desaturate" },
        StagedId { stage: "P5", order: 42, id: "image.adjustments.equalize" },
        StagedId { stage: "P5", order: 43, id: "image.adjustments.shadowsHighlights" },
        StagedId { stage: "P5", order: 44, id: "image.adjustments.replaceColor" },
        StagedId { stage: "P5", order: 45, id: "image.adjustments.matchColor" },
    ],
};
