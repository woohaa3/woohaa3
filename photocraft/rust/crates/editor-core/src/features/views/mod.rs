use super::{FeatureContribution, StagedId};
use crate::composition::{GUIDE_COMMANDS, GUIDE_LAYOUT_COMMANDS, VIEW_COMMANDS};

/// 旋转/缩放/平移的可逆视图变换（U72）；命中、标尺、吸附阈值共用一份。
pub mod view_geometry;

/// 持久颜色采样点（U73）：存在文档 `metadata.text` 的命名空间键里，随 `.pcraft` 往返。
pub mod samplers;

#[cfg(test)]
#[path = "tests_views.rs"]
mod tests_views;

/// ## 发布范围
///
/// 逐项工作流已接通（画布拖线/命中/原点拖动、参考线布局、Info/取样/测量/计数/注释、
/// 文档级原生核验），因此开放两条能力与对应命令：
///
/// - `view.guide-layout`：U71 的布局生成与画布参考线；
/// - `view.analysis`：U73 的取样、测量、计数与注释。
///
/// `view.rotate-navigator` **保持关闭**：旋转、Navigator 与同文档「并排」都已交付，但旋转目前
/// 只是**视图空间**变换——叠加层、命中、标尺与 Info 读数按同一公式反算，像素平面却由宿主按
/// `origin/zoom` 呈现（`renderCanvasBackground(origin, zoom)` 没有旋转参数），画布落笔映射走
/// 无旋转的共享 `coordinates.ts`。旋转后「看到的像素」与「旋转后的叠加层/命中」不同步，补齐
/// 需要宿主渲染端口；在此之前的入口都只是部分能力，提前开放会给出做不到的承诺。
///
/// 命令清单同时被跨语言 fixture 与真实 WASM 基线核对，因此本次发布的命令与能力记在
/// `notes/feature-boundary-baseline.json` 的 `publication` 里；两份基线的其余字段（命令行为、
/// 错误、8 个状态快照、PNG 字节）仍与 `bdc3c084` 一致，没有借发布之机重采。
pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "views",
    capabilities: &[
        StagedId { stage: "P7", order: 3, id: "view.guides" },
        StagedId { stage: "P7", order: 4, id: "view.grid-snap" },
        StagedId { stage: "P7", order: 11, id: "view.guide-layout" },
        StagedId { stage: "P7", order: 12, id: "view.analysis" },
    ],
    commands: &[
        StagedId { stage: "P0", order: 57, id: "view.layerMask" },
        StagedId { stage: "P7", order: 4, id: "view.newGuide" },
        StagedId { stage: "P7", order: 5, id: "view.moveGuide" },
        StagedId { stage: "P7", order: 6, id: "view.editGuide" },
        StagedId { stage: "P7", order: 7, id: "view.deleteGuide" },
        StagedId { stage: "P7", order: 8, id: "view.clearGuides" },
        StagedId { stage: "P7", order: 9, id: "view.setRulerOrigin" },
        StagedId { stage: "P7", order: 10, id: "view.resetRulerOrigin" },
        // U71 参考线布局与画布参考线。
        StagedId { stage: "P7", order: 11, id: "view.newGuideLayout" },
        StagedId { stage: "P7", order: 12, id: "view.newGuidesFromShape" },
        StagedId { stage: "P7", order: 13, id: "view.clearCanvasGuides" },
        // U73 取样、测量、计数、注释。
        StagedId { stage: "P7", order: 14, id: "view.colorSamplers.add" },
        StagedId { stage: "P7", order: 15, id: "view.colorSamplers.move" },
        StagedId { stage: "P7", order: 16, id: "view.colorSamplers.delete" },
        StagedId { stage: "P7", order: 17, id: "view.colorSamplers.clear" },
        StagedId { stage: "P7", order: 18, id: "view.colorSamplers.list" },
        StagedId { stage: "P7", order: 19, id: "image.analysis.setMeasurementScale" },
        StagedId { stage: "P7", order: 20, id: "image.analysis.rulerTool" },
        StagedId { stage: "P7", order: 21, id: "image.analysis.straightenLayer" },
        StagedId { stage: "P7", order: 22, id: "image.analysis.recordMeasurements" },
        StagedId { stage: "P7", order: 23, id: "image.analysis.info" },
        StagedId { stage: "P7", order: 24, id: "count.add" },
        StagedId { stage: "P7", order: 25, id: "count.remove" },
        StagedId { stage: "P7", order: 26, id: "count.move" },
        StagedId { stage: "P7", order: 27, id: "count.clear" },
        StagedId { stage: "P7", order: 28, id: "count.newGroup" },
        StagedId { stage: "P7", order: 29, id: "count.deleteGroup" },
        StagedId { stage: "P7", order: 30, id: "count.setGroup" },
        StagedId { stage: "P7", order: 31, id: "measurementLog.list" },
        StagedId { stage: "P7", order: 32, id: "measurementLog.delete" },
        StagedId { stage: "P7", order: 33, id: "measurementLog.export" },
        StagedId { stage: "P7", order: 34, id: "notes.add" },
        StagedId { stage: "P7", order: 35, id: "notes.set" },
        StagedId { stage: "P7", order: 36, id: "notes.delete" },
        StagedId { stage: "P7", order: 37, id: "notes.list" },
    ],
};

/// PSD 往返会丢失的视图/分析数据（U70/U73，供 io 域的导出损失报告汇总）。
///
/// 逐项按**实测**给出，而不是照能力表推测：
///
/// - 参考线位置、注释文字与测量比例有对应的 PSD 资源，往返保留 → 不列入；
/// - 参考线的**单条颜色**（`Guides::colors`）、**标尺原点**与**计数分组**没有可写回的
///   PSD 字段 → 往返丢失，必须在导出前明确告诉用户。
///
/// 返回 `(feature, reason)`：`feature` 是稳定的项名，`reason` 面向用户。
pub fn psd_loss_rows(document: &photocraft_doc::Document) -> Vec<(&'static str, String)> {
    psd_loss_rows_with_samplers(document, &[])
}

/// [`psd_loss_rows`] 的完整版：颜色采样点是**会话**数据，不在文档字段里，因此调用方要把
/// 当前文档的采样点数一并传进来，否则「导出 PSD 会丢采样点」永远不会出现在报告里。
pub fn psd_loss_rows_with_samplers(
    document: &photocraft_doc::Document,
    samplers: &[[f64; 2]],
) -> Vec<(&'static str, String)> {
    let mut rows = Vec::new();
    if !samplers.is_empty() {
        rows.push((
            "view.color-samplers",
            format!(
                "{} 个颜色采样点在 PSD 中没有对应字段，导出后丢失（工程里仍保留）",
                samplers.len()
            ),
        ));
    }
    if !document.guides.colors.is_empty() {
        rows.push((
            "view.guide-colors",
            format!("{} 条参考线的自定义颜色在 PSD 中没有对应字段，导出后回到默认色", document.guides.colors.len()),
        ));
    }
    if document.ruler_origin != [0.0, 0.0] {
        rows.push((
            "view.ruler-origin",
            "标尺原点在 PSD 中没有对应字段，导出后回到文档左上角".to_string(),
        ));
    }
    let marks: usize = document.measurement.count_groups.iter().map(|group| group.points.len()).sum();
    if marks > 0 {
        let groups = document.measurement.count_groups.iter().filter(|group| !group.points.is_empty()).count();
        rows.push((
            "view.count-marks",
            format!("{groups} 个计数分组的 {marks} 个标记在 PSD 中没有对应字段，导出后丢失"),
        ));
    }
    rows
}

/// 一条视图/分析命令属于哪条已发布能力。
///
/// 声明与控制必须是同一份数据：发布清单在 [`CONTRIBUTION`]，入口按它逐条放行。这样把某条能力
/// 重新关闭时，对应命令会一起关闭，而不是「声明关了、命令还能跑」。
///
/// 未登记的白名单命令返回 `None`，于是入口按 `CapabilityDisabled` 拒绝——新增命令忘了登记
/// 能力会立刻暴露，而不是悄悄生效。
pub fn required_capability(id: &str) -> Option<&'static str> {
    if GUIDE_COMMANDS.contains(&id) {
        Some("view.guides")
    } else if GUIDE_LAYOUT_COMMANDS.contains(&id) {
        Some("view.guide-layout")
    } else if VIEW_COMMANDS.contains(&id) {
        Some("view.analysis")
    } else {
        None
    }
}
