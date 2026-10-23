use super::*;

/// 已发布并能在运行时重编的调整类型。
///
/// 接受集合必须与唯一命令门（`crate::capability::command_allowed` 背后的
/// `features::adjustments` 命令表）一致：门禁放开的类型，核验器必须接受；门禁没放开的类型，
/// 核验器必须拒绝，否则会出现「核验通过、运行时拒绝」。范围外的 LUT（`adjust.lut` 是永久非
/// 目标）与无法求值的 PSD 块（`Unsupported`）因此继续保持拒绝。
pub(super) fn inspect_adjustment(adjustment: &Adjustment) -> Result<(), VerifyError> {
    match adjustment {
        // P0 三类。
        Adjustment::BrightnessContrast { .. }
        | Adjustment::HueSaturation { .. }
        | Adjustment::Curves { .. }
        // P5 四类（change: 2026-10-22）。
        | Adjustment::Levels { .. }
        | Adjustment::Vibrance { .. }
        | Adjustment::BlackWhite { .. }
        // U43：九类新增逐类调整（change: 2026-10-22-add-photocraft-adjustment-workflows）。
        | Adjustment::Exposure { .. }
        | Adjustment::ColorBalance { .. }
        | Adjustment::PhotoFilter { .. }
        | Adjustment::ChannelMixer { .. }
        | Adjustment::Invert
        | Adjustment::Posterize { .. }
        | Adjustment::Threshold { .. }
        | Adjustment::GradientMap { .. }
        | Adjustment::SelectiveColor { .. } => Ok(()),
        _ => Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("工程包含未开放的调整类型：{}", adjustment.label()),
        )),
    }
}
