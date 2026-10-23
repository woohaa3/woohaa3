use super::*;

/// 参考线／标尺命令（视图状态，不进内容身份）。
pub const GUIDE_COMMANDS: &[&str] = &[
    "view.newGuide",
    "view.moveGuide",
    "view.editGuide",
    "view.deleteGuide",
    "view.clearGuides",
    "view.setRulerOrigin",
    "view.resetRulerOrigin",
];

/// 参考线布局与画布参考线命令（U71）。
pub const GUIDE_LAYOUT_COMMANDS: &[&str] = &["view.newGuideLayout", "view.newGuidesFromShape", "view.clearCanvasGuides"];

/// 颜色取样点（U73）：上游按文档保存为**会话**视图状态，不写入 `.pcraft`/PSD。
pub const SAMPLER_COMMANDS: &[&str] = &[
    "view.colorSamplers.add",
    "view.colorSamplers.move",
    "view.colorSamplers.delete",
    "view.colorSamplers.clear",
    "view.colorSamplers.list",
];

/// 测量、计数与注释（U73）：计数分组、标尺、比例与注释是**文档**数据。
pub const ANALYSIS_COMMANDS: &[&str] = &[
    "image.analysis.setMeasurementScale",
    "image.analysis.rulerTool",
    "image.analysis.straightenLayer",
    "image.analysis.recordMeasurements",
    "image.analysis.info",
    "count.add",
    "count.remove",
    "count.move",
    "count.clear",
    "count.newGroup",
    "count.deleteGroup",
    "count.setGroup",
    "measurementLog.list",
    "measurementLog.delete",
    "measurementLog.export",
    "notes.add",
    "notes.set",
    "notes.delete",
    "notes.list",
];

/// 本域唯一写入口接受的命令集（视图状态 + 文档分析数据）。
pub const VIEW_COMMANDS: &[&str] = &[
    // U70/U71 参考线与原点
    "view.newGuide",
    "view.moveGuide",
    "view.editGuide",
    "view.deleteGuide",
    "view.clearGuides",
    "view.setRulerOrigin",
    "view.resetRulerOrigin",
    "view.newGuideLayout",
    "view.newGuidesFromShape",
    "view.clearCanvasGuides",
    // U73 取样、测量、计数、注释
    "view.colorSamplers.add",
    "view.colorSamplers.move",
    "view.colorSamplers.delete",
    "view.colorSamplers.clear",
    "view.colorSamplers.list",
    "image.analysis.setMeasurementScale",
    "image.analysis.rulerTool",
    "image.analysis.straightenLayer",
    "image.analysis.recordMeasurements",
    "image.analysis.info",
    "count.add",
    "count.remove",
    "count.move",
    "count.clear",
    "count.newGroup",
    "count.deleteGroup",
    "count.setGroup",
    "measurementLog.list",
    "measurementLog.delete",
    "measurementLog.export",
    "notes.add",
    "notes.set",
    "notes.delete",
    "notes.list",
];

/// 本域只读快照命令：不写文档、不造历史、不产生 dirty。
pub const VIEW_READ_COMMANDS: &[&str] = &[
    "image.analysis.info",
    "view.colorSamplers.list",
    "measurementLog.list",
    "measurementLog.export",
    "notes.list",
];

/// 画布指针几何动作（U70/U72/U73）：命中参考线、拖动参考线、拖动标尺原点、光标源像素读数。
///
/// 都是**只读换算**——命中不动文档，拖动只在 UI 草稿里显示位置，提交时才走
/// `view.moveGuide` / `view.setRulerOrigin`；`probe` 只读一个合成像素。因此它们都不走草稿
/// 门禁、不产生历史、不改文档。
///
/// `probe` 存在的理由：Info 面板要跟随光标显示**源像素**读数，而客户坐标→源坐标必须经过
/// 视图矩阵（旋转/缩放/平移）。把换算留在内核，TS 侧就只消费结果，不会出现「面板自己按
/// 缩放算一遍、和命中/落笔差半个像素」的第二套几何。
pub const VIEW_POINTER_ACTIONS: &[&str] = &["hit-guide", "drag-guide", "drag-origin", "probe"];

/// 标尺单位（U71 单位参数；与上游 `prefs::Unit` 的取值一致）。
pub const VIEW_UNITS: &[&str] = &["px", "in", "cm", "mm", "pt", "pc", "%"];

/// 吸附目标（与上游 `engine::snap::SnapOptions` 的开关一一对应）。
pub const SNAP_TARGETS: &[&str] = &["document", "guides", "grid", "layers", "selection"];

/// 每个文档最多几个视图（多视图只共享内容，不复制内核）。
pub const MAX_VIEWS: usize = 4;

/// 视图辅助状态（工作区级，不进文档、不进内容 hash、不进历史）。
#[derive(Clone, Debug, PartialEq)]
pub struct ViewAids {
    pub rulers: bool,
    pub grid: bool,
    pub grid_step: [f64; 2],
    /// 网格细分（每格再分的条数，U71）。
    pub grid_subdivisions: u32,
    pub guides: bool,
    pub lock_guides: bool,
    pub snap: SnapOptions,
    /// 智能参考线（图层/画布中心的洋红对齐提示，U71）。
    pub smart_guides: bool,
    /// 临时关闭吸附（按住修饰键）。
    pub snap_suspended: bool,
    /// 标尺单位（`VIEW_UNITS`）。
    pub units: String,
    /// 画布旋转角度（度，顺时针为正；U72 视图状态，不是图像旋转）。
    pub rotation_degrees: f64,
    /// Navigator 是否展开（U72 视图状态）。
    pub navigator: bool,
    /// 并排显示多个视图（U72 视图状态）。需要至少两个视图；`false` 时只渲染活动视图。
    pub side_by_side: bool,
    /// 同文档多个视图；`views[0]` 始终存在。
    pub views: Vec<ViewModel>,
}

/// 一个独立取景的视图（U72）。内容、历史与保存基线由会话共享，这里只有取景。
#[derive(Clone, Debug, PartialEq)]
pub struct ViewModel {
    pub id: String,
    pub label: String,
    pub zoom: f64,
    pub offset: [f64; 2],
    pub rotation_degrees: f64,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SnapOptions {
    pub document: bool,
    pub guides: bool,
    pub grid: bool,
    pub layers: bool,
    pub selection: bool,
}

fn default_view() -> ViewModel {
    ViewModel {
        id: "view-1".into(),
        label: "视图 1".into(),
        zoom: 1.0,
        offset: [0.0, 0.0],
        rotation_degrees: 0.0,
        active: true,
    }
}

impl Default for ViewAids {
    fn default() -> Self {
        Self {
            rulers: false,
            grid: false,
            grid_step: [18.0, 18.0],
            grid_subdivisions: 1,
            guides: true,
            lock_guides: false,
            snap: SnapOptions { document: true, guides: true, grid: false, layers: true, selection: false },
            smart_guides: true,
            snap_suspended: false,
            units: "px".into(),
            rotation_degrees: 0.0,
            navigator: false,
            side_by_side: false,
            views: vec![default_view()],
        }
    }
}

impl ViewAids {
    /// 视图辅助是否参与吸附（临时关闭时全关）。
    pub fn snapping(&self) -> bool {
        !self.snap_suspended
    }

    /// 活动视图（`views[0]` 兜底，保证永远有一个）。
    pub fn active_view(&self) -> &ViewModel {
        self.views.iter().find(|view| view.active).unwrap_or(&self.views[0])
    }

    /// 活动视图的索引。
    pub fn active_view_index(&self) -> usize {
        self.views.iter().position(|view| view.active).unwrap_or(0)
    }

    /// 按 id 找视图索引（按视图 id 写取景用）。
    pub fn view_index(&self, id: &str) -> Option<usize> {
        self.views.iter().position(|view| view.id == id)
    }

    /// 视图的复合变换（旋转 × 缩放 × 平移）。
    pub fn transform(&self) -> crate::features::views::view_geometry::ViewTransform {
        let view = self.active_view();
        crate::features::views::view_geometry::ViewTransform {
            zoom: view.zoom,
            offset: view.offset,
            rotation_degrees: view.rotation_degrees,
        }
    }

    pub fn to_json(&self) -> Value {
        self.to_json_with_origin([0.0, 0.0])
    }

    /// 带文档标尺零点的会话视图状态（叠加层/标尺刻度用）。
    pub fn to_json_with_origin(&self, ruler_origin: [f64; 2]) -> Value {
        json!({
            "rulers": self.rulers,
            "grid": self.grid,
            "gridStep": self.grid_step,
            "gridSubdivisions": self.grid_subdivisions,
            "guides": self.guides,
            "lockGuides": self.lock_guides,
            "smartGuides": self.smart_guides,
            "snap": {
                "document": self.snap.document,
                "guides": self.snap.guides,
                "grid": self.snap.grid,
                "layers": self.snap.layers,
                "selection": self.snap.selection,
            },
            "suspend": self.snap_suspended,
            "units": self.units,
            // 标尺零点属于文档，但叠加层与标尺读数需要和轮换角一起拿到：跨文档读快照会多一次
            // 内核调用，而界面每帧都要画刻度。没有文档时退回文档左上角，不伪造别的值。
            "rulerOrigin": ruler_origin,
            "rotation": self.rotation_degrees,
            "navigator": self.navigator,
            "activeView": self.active_view().id,
            "views": self.views.iter().map(|view| json!({
                "id": view.id,
                "label": view.label,
                "zoom": view.zoom,
                "offset": view.offset,
                "rotation": view.rotation_degrees,
                "active": view.active,
            })).collect::<Vec<_>>(),
            "maxViews": MAX_VIEWS,
            "sideBySide": self.side_by_side,
        })
    }
}

/// 吸附结果：吸附后的点与对齐反馈线（源坐标）。
#[derive(Clone, Debug, PartialEq)]
pub struct SnapResult {
    pub point: [f64; 2],
    pub lines: Vec<SnapLine>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnapLine {
    pub vertical: bool,
    pub position: f64,
    pub from: f64,
    pub to: f64,
    /// `guide`、`grid`、`documentEdge`、`documentCenter`、`layerEdge`、`layerCenter`、`selection`。
    pub kind: &'static str,
    /// 图层/画布中心对齐（Photoshop 的智能参考线）。
    pub smart: bool,
}

fn snap_kind(kind: photocraft_engine::snap::SnapKind) -> &'static str {
    use photocraft_engine::snap::SnapKind;
    match kind {
        SnapKind::Guide => "guide",
        SnapKind::Grid => "grid",
        SnapKind::DocumentEdge => "documentEdge",
        SnapKind::DocumentCenter => "documentCenter",
        SnapKind::LayerEdge => "layerEdge",
        SnapKind::LayerCenter => "layerCenter",
        SnapKind::Selection => "selection",
    }
}

/// 按工作区视图状态计算吸附。
///
/// `tolerance` 是**屏幕像素**阈值，调用方按当前缩放换算成源像素（`tolerance / zoom`），
/// 因此缩放不改变吸附的屏幕手感。智能参考线关闭时只去掉图层/画布中心那两类目标。
pub fn snap_point(document: &Document, aids: &ViewAids, point: [f64; 2], tolerance_px: f64) -> SnapResult {
    if !aids.snapping() || !point[0].is_finite() || !point[1].is_finite() || !tolerance_px.is_finite() {
        return SnapResult { point, lines: Vec::new() };
    }
    let options = photocraft_engine::snap::SnapOptions {
        guides: aids.snap.guides,
        grid: aids.snap.grid,
        layers: aids.snap.layers && aids.smart_guides,
        document: aids.snap.document,
        selection: aids.snap.selection,
        grid_step: aids.grid_step,
    };
    let targets = photocraft_engine::snap::SnapTargets::from_document(document, &options, &[]);
    let (snapped, lines) = targets.snap_point(point, tolerance_px.max(0.0));
    SnapResult {
        point: snapped,
        lines: lines
            .into_iter()
            .filter(|line| aids.smart_guides || !line.kind.is_smart())
            .map(|line| SnapLine {
                vertical: line.vertical,
                position: line.pos,
                from: line.from,
                to: line.to,
                kind: snap_kind(line.kind),
                smart: line.kind.is_smart(),
            })
            .collect(),
    }
}

/// 单位是否合法（`VIEW_UNITS`，也接受单位别名）。
pub fn canonical_unit(unit: &str) -> Option<&'static str> {
    let lower = unit.trim().to_ascii_lowercase();
    VIEW_UNITS.iter().copied().find(|candidate| candidate.eq_ignore_ascii_case(&lower))
}

/// 把像素长度换成单位读数（只用于 Info/标尺显示，不改文档）。
// 只有 wasm 侧（`features/views/wasm.rs`）调用；原生构建照常编译避免分支漂移。
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn format_length(px: f64, unit: &str, resolution_dpi: f64, extent: f64) -> Option<String> {
    let unit = canonical_unit(unit)?;
    if !px.is_finite() || !resolution_dpi.is_finite() || !extent.is_finite() || resolution_dpi <= 0.0 {
        return None;
    }
    let dpi = resolution_dpi.max(1e-6);
    let value = match unit {
        "px" => px,
        "in" => px / dpi,
        "cm" => px / dpi * 2.54,
        "mm" => px / dpi * 25.4,
        "pt" => px / dpi * 72.0,
        "pc" => px / dpi * 6.0,
        _ => px / extent.max(1e-6) * 100.0,
    };
    let decimals = match unit {
        "px" => 0,
        "pt" | "%" => 1,
        "mm" | "cm" | "pc" => 2,
        _ => 3,
    };
    Some(format!("{} {unit}", trim_number(value, decimals)))
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn trim_number(value: f64, decimals: usize) -> String {
    if !value.is_finite() { return "—".into(); }
    let text = format!("{value:.decimals$}");
    if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.').to_string() } else { text }
}

/// 参考线／标尺：视图状态走内核文档（`Guides` 属于文档视图字段，不进内容 hash）。
pub fn guide(session: &mut Session, id: &str, params: Value) -> Result<Value> {
    if !GUIDE_COMMANDS.contains(&id) {
        return Err(error("view.guides", format!("{id} 不是已开放的参考线命令")));
    }
    validate_document_ready(session)?;
    session.execute(id, params).map_err(|failure| error("view.guides", failure))
}

/// 文档命令与视图命令的归属判定（供核验与 UI 使用）。
#[allow(dead_code)]
pub fn is_view_command(id: &str) -> bool {
    VIEW_COMMANDS.contains(&id)
}

/// 命令族到 U 编号的追溯（能力矩阵与验收记录共用）。
#[allow(dead_code)]
pub fn command_groups() -> Value {
    let mut analysis = SAMPLER_COMMANDS.to_vec();
    analysis.extend_from_slice(ANALYSIS_COMMANDS);
    json!({
        "U70": GUIDE_COMMANDS,
        "U71": GUIDE_LAYOUT_COMMANDS,
        "U73": analysis,
        "U72": ["view.rotate", "view.view", "view.setRulerOrigin", "view.resetRulerOrigin"],
    })
}
