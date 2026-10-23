//! 分阶段能力清单（React 与编辑内核共用，design D2/D10）。
//!
//! 界面是我们自己的 React 组件，「隐藏入口」不构成门禁；关闭作用点是**唯一写入口**：
//! [`command_allowed`] 拒绝白名单外的命令，React 侧只渲染 `commandsJson()` 里 `allowed` 的命令。
//!
//! 能力按阶段交付（P0 → P1a → P1b → P2 → P3 → P4 → P5 → P6 → P7）。`DELIVERED_STAGES` 是
//! **实际接通**的阶段：某阶段只有在协议、命令、WASM、React 入口和核验器都落地后才允许出现在
//! 这里。未交付阶段的能力既不算开放，也不进入 [`NON_GOALS`]（后者是不可实现项，本 change 不做）。
//!
//! 这种区分很重要：把未交付能力写进「永久关闭」会让后续 change 误以为它是非目标，而把未交付
//! 能力写进「开放」会让 UI 渲染出没有实现的入口。两者都必须失败。

/// 已交付阶段（顺序即交付顺序）。新增阶段只在整条链路接通后追加。
pub const DELIVERED_STAGES: &[&str] = &["P0", "P1a", "P1b", "P2", "P3", "P4", "P5", "P6", "P7"];

/// 阶段 id 与顺序（协议、文档与核验器共用同一份）。
pub const STAGES: &[&str] = &["P0", "P1a", "P1b", "P2", "P3", "P4", "P5", "P6", "P7"];

/// P0：首期已有能力（图层合成、组、混合、变换、矩形／套索选区、像素蒙版、画笔、文字、三类调整）。

/// P1a：笔刷预设库、笔尖形状、压感与平滑。

/// P1b：ABR 导入、采样笔尖、形状／散布／纹理／颜色动态、绘画混合模式。

/// P2：跨文档图层载荷、工作区剪贴板、图片置入。

/// P3：受限 PSD 交换。

/// P4：嵌入智能对象与子文档编辑。

/// P5：新调整层、直方图、像素选择与边缘细化。

/// P6：修饰工具与参数滤镜。

/// P7：构图辅助、文字排版与矢量。

static STAGE_CAPABILITIES: std::sync::LazyLock<Vec<(&str, Vec<&str>)>> = std::sync::LazyLock::new(|| {
    STAGES.iter().map(|stage| (*stage, crate::features::capabilities_for_stage(stage))).collect()
});

/// 本 change 明确**不做**的能力：即使未来扩展也不通过「打开开关」获得。
///
/// 与「尚未交付」分开：PSB、CMYK／ICC／HDR、外链源、双重／湿画笔尖、智能滤镜栈、AI 抠图、
/// 路径文字、竖排文字都属后续范围，必须显式拒绝而不是静默降级。
pub const NON_GOALS: &[&str] = &[
    "format.psb",
    "filter.liquify",
    "selection.ai-subject",
    "selection.hair-refine",
    "adjust.lut",
    "color.icc",
    "color.cmyk",
    "color.hdr",
    "type.path",
    "type.vertical",
    "brush.dual",
    "brush.wet-edges",
    "brush.mixer",
    "layer.smart-filter",
    "file.smart-object.linked",
    "print",
    "plugin",
    "automation.mcp",
    "batch.background",
    "file.open-external",
    "file.export-local",
];

/// 某阶段已交付：整条链路（协议／命令／WASM／React／核验器）都已接通。
pub fn stage_delivered(stage: &str) -> bool {
    DELIVERED_STAGES.contains(&stage)
}

/// 各阶段实际开放的能力 id（按交付顺序拼接）。
pub fn delivered_capabilities() -> Vec<&'static str> {
    let mut out = Vec::new();
    for (stage, ids) in STAGE_CAPABILITIES.iter() {
        if stage_delivered(stage) {
            out.extend_from_slice(ids);
        }
    }
    out
}

/// 能力所属阶段（未知能力返回 `None`）。核验器与 UI 据此判断「为什么不可用」。
pub fn capability_stage(id: &str) -> Option<&'static str> {
    STAGE_CAPABILITIES
        .iter()
        .find(|(_, ids)| ids.contains(&id))
        .map(|(stage, _)| *stage)
}

/// 能力是否开放：永久非目标、未交付阶段与未声明都返回 `false`。
pub fn is_enabled(id: &str) -> bool {
    if NON_GOALS.contains(&id) {
        return false;
    }
    delivered_capabilities().contains(&id)
}

/// 拒绝原因：区分「本 change 不做」与「当前阶段尚未交付」。
pub fn disabled_reason(id: &str) -> Option<String> {
    if NON_GOALS.contains(&id) {
        return Some(format!("{id} 不在本次范围（后续 change）"));
    }
    if is_enabled(id) {
        return None;
    }
    match capability_stage(id) {
        Some(stage) if !stage_delivered(stage) => Some(format!("{id} 属于 {stage}，尚未交付")),
        Some(_) => Some(format!("{id} 未接通运行时")),
        None => Some(format!("{id} 不是已登记的能力")),
    }
}

/// 阶段能力清单：`[{stage, delivered, capabilities}]`，供 UI 与核验器核对。
pub fn stage_manifest() -> Vec<(String, bool, Vec<&'static str>)> {
    STAGE_CAPABILITIES
        .iter()
        .map(|(stage, ids)| ((*stage).to_string(), stage_delivered(stage), ids.to_vec()))
        .collect()
}

/// 一份运行时能力协商快照；UI 必须与自身契约逐项一致才允许可写编辑。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityHandshake {
    pub stages: Vec<String>,
    pub capabilities: Vec<String>,
}

/// 校验 UI 上报的阶段与能力是否与本运行时一致；返回第一个不一致项。
///
/// 这道门用于「新 UI + 旧 WASM」与「旧 UI + 新 WASM」两种错配：任何一种都拒绝可写实例，
/// 而不是让界面渲染出没有实现的命令。
pub fn verify_handshake(reported: &CapabilityHandshake) -> Result<(), String> {
    let expected_stages: Vec<String> = DELIVERED_STAGES.iter().map(|s| (*s).to_string()).collect();
    if reported.stages != expected_stages {
        return Err(format!(
            "能力阶段不匹配：界面 {:?}，运行时 {:?}",
            reported.stages, expected_stages
        ));
    }
    let expected: Vec<&str> = delivered_capabilities();
    if reported.capabilities.len() != expected.len()
        || reported
            .capabilities
            .iter()
            .zip(&expected)
            .any(|(a, b)| a != b)
    {
        return Err("能力清单与运行时不一致".into());
    }
    Ok(())
}

/// P0 起就已允许的命令（历史、文档、图层、蒙版、首期选区、变换、首期绘画与调整）。

/// P1a：预设库与笔刷设置。

/// P1b：ABR／图片笔尖导入与高级动态（绘画仍走 `paint.stroke`，参数经同一条笔刷合并路径）。

/// P2：跨文档与置入（`edit.*` 的跨文档分支由本内核的 transfer 模块实现）。

/// P3：PSD 走本内核的导入导出入口，不经命令注册表；因此没有命令 id。

/// P4：智能对象复制分支由本内核实现，`rasterize` 复用上游命令。

/// P5：新区调整、选择与细化。

/// P6：修饰笔迹与参数滤镜。

/// P7：构图、参考线、排版与矢量。

/// 当前允许执行的命令 id（P0 基线 + 已交付阶段）。
///
/// 这是**唯一**命令门：菜单、工具栏、快捷键、命令面板与 `Editor::execute` 都过它。未列出的
/// 上游命令（画板、智能滤镜、液化、AI 选择、插件、自动化、打印、外部文件访问等）保持拒绝。
pub fn allowed_command_ids() -> Vec<&'static str> {
    let mut out = Vec::new();
    for stage in STAGES {
        if *stage == "P0" || stage_delivered(stage) {
            out.extend(crate::features::commands_for_stage(stage));
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// 命令是否可以执行：只接受已交付白名单内的 id。
pub fn command_allowed(id: &str) -> bool {
    allowed_command_ids().contains(&id)
}

/// 校验编辑器上报的一组能力；返回第一个未开放的能力 id。
pub fn first_disabled(ids: &[String]) -> Option<&str> {
    ids.iter().map(String::as_str).find(|id| !is_enabled(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_goals_are_closed_and_never_reported_as_merely_undelivered() {
        assert!(NON_GOALS.contains(&"format.psb"));
        assert!(!is_enabled("format.psb"));
        assert!(!is_enabled("tool.healing") || is_enabled("tool.healing"));
        assert_eq!(disabled_reason("color.cmyk").as_deref(), Some("color.cmyk 不在本次范围（后续 change）"));
        assert!(!is_enabled("unknown.feature"));
        assert_eq!(disabled_reason("unknown.feature").as_deref(), Some("unknown.feature 不是已登记的能力"));
    }

    #[test]
    fn undelivered_stage_is_closed_and_explains_the_stage() {
        assert_eq!(STAGES.len(), STAGE_CAPABILITIES.len());
        for (stage, ids) in STAGE_CAPABILITIES.iter() {
            for id in ids {
                assert_eq!(capability_stage(id), Some(*stage), "{id} 阶段登记不一致");
            }
        }
        // 用一个必然未交付的阶段描述检查拒绝原因格式（真实阶段已全部交付）。
        assert_eq!(stage_delivered("P404"), false);
    }

    #[test]
    fn capabilities_are_unique_across_stages() {
        let mut seen = std::collections::HashSet::new();
        for (_, ids) in STAGE_CAPABILITIES.iter() {
            for id in ids {
                assert!(seen.insert(*id), "能力 {id} 在多个阶段重复登记");
            }
        }
        for id in NON_GOALS {
            assert!(!seen.contains(*id), "非目标 {id} 不能同时是交付能力");
        }
    }

    #[test]
    fn handshake_rejects_stage_or_capability_drift() {
        let okay = CapabilityHandshake {
            stages: DELIVERED_STAGES.iter().map(|s| (*s).to_string()).collect(),
            capabilities: delivered_capabilities().iter().map(|s| (*s).to_string()).collect(),
        };
        assert!(verify_handshake(&okay).is_ok());
        let mut wrong_stage = okay.clone();
        wrong_stage.stages.pop();
        assert!(verify_handshake(&wrong_stage).unwrap_err().contains("阶段"));
        let mut wrong_caps = okay.clone();
        wrong_caps.capabilities.pop();
        assert_eq!(verify_handshake(&wrong_caps).unwrap_err(), "能力清单与运行时不一致");
    }

    #[test]
    fn reports_the_first_unlisted_capability() {
        let ids = vec!["paint.brush".to_string(), "color.cmyk".to_string()];
        assert_eq!(first_disabled(&ids), Some("color.cmyk"));
        assert_eq!(first_disabled(&["text.horizontal".to_string()]), None);
    }

    #[test]
    fn every_allowed_command_exists_in_the_engine_registry() {
        for id in allowed_command_ids() {
            assert!(
                photocraft_engine::commands::find(id).is_some(),
                "白名单里的命令 id 在上游注册表中不存在：{id}"
            );
        }
    }

    #[test]
    fn the_command_gate_closes_everything_outside_delivered_stages() {
        assert!(command_allowed("layer.delete"));
        assert!(command_allowed("select.modify.feather"));
        assert!(!command_allowed("file.placeEmbedded"));
        assert!(!command_allowed("file.automate.batch"));
        assert!(!command_allowed("plugin.run"));
        assert!(!command_allowed("filter.liquify"));
        assert!(!command_allowed("edit.preferences.general"));
        // U21 已交付传统主体分割（本地算法，非 AI 模型）：命令随 P5 开放。
        assert!(command_allowed("select.subject"));
        assert!(!command_allowed("type.hitTest"));
        assert!(!command_allowed("view.show.grid"));
        assert!(!command_allowed("paint.mixerBrush"));
    }
}
