//! 选区与蒙版工作流的隔离草稿（U17–U24）。
//!
//! 本文件只持有**候选文档**与提交所需的最小状态：预览在临时会话里跑真实上游命令，确认时
//! 在活动会话里再执行一次同样的参数，取消即丢弃。草稿不推进修订／指纹／历史；确认只提交
//! 一次。上游命令仍是唯一内容写入口，绝不在这里维护第二份选区或蒙版模型。

use photocraft_doc::Document;
use photocraft_engine::DocState;
use photocraft_project_verify::limits::MAX_OPEN_DOCUMENTS;
use serde_json::{Value, json};

use crate::error::{EditorError, Result};

/// 边缘细化的输出目标（与上游 `output` 取值一致）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefineOutput {
    Selection,
    LayerMask,
    NewLayer,
    NewLayerWithMask,
    NewDocument,
    NewDocumentWithMask,
}

impl RefineOutput {
    /// 输出目标的内核参数值。
    pub fn command(self) -> &'static str {
        match self {
            RefineOutput::Selection => "selection",
            RefineOutput::LayerMask => "layerMask",
            RefineOutput::NewLayer => "newLayer",
            RefineOutput::NewLayerWithMask => "newLayerWithMask",
            RefineOutput::NewDocument => "newDocument",
            RefineOutput::NewDocumentWithMask => "newDocumentWithMask",
        }
    }

    /// 该输出是否换成**新文档**（占一个打开文档名额）。
    pub fn opens_document(self) -> bool {
        matches!(self, RefineOutput::NewDocument | RefineOutput::NewDocumentWithMask)
    }

    /// 解析 `output`；缺省为 `selection`。
    pub fn parse(value: Option<&Value>) -> Result<Self> {
        let Some(text) = value.and_then(Value::as_str) else {
            return Ok(RefineOutput::Selection);
        };
        Ok(match text {
            "selection" => RefineOutput::Selection,
            "layerMask" => RefineOutput::LayerMask,
            "newLayer" => RefineOutput::NewLayer,
            "newLayerWithMask" => RefineOutput::NewLayerWithMask,
            "newDocument" => RefineOutput::NewDocument,
            "newDocumentWithMask" => RefineOutput::NewDocumentWithMask,
            other => {
                return Err(error(
                    "select.refineEdge",
                    format!("未知输出目标：{other}（selection|layerMask|newLayer|newLayerWithMask|newDocument|newDocumentWithMask）"),
                ))
            }
        })
    }
}

/// 草稿种类；每一种都对应**一条**真实上游命令。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftKind {
    /// 选区修改（扩展／收缩／平滑／边界／羽化）。
    Modify,
    /// 磁性套索追踪。
    Magnetic,
    /// 色彩范围（多点取样／局部颜色群组／色调区间）。
    ColorRange,
    /// 按颜色扩大选取（`select.grow`）。
    Grow,
    /// 按颜色选取相似（`select.similar`）。
    Similar,
    /// 选择并遮住（边缘细化 + 输出目标）。
    Refine,
    /// 快速蒙版会话（进入 → 临时笔迹 → 退出转选区）。
    QuickMask,
    /// 传统分割（对象／主体／天空／焦点／移除背景）。
    Smart,
}

impl DraftKind {
    /// 稳定的对外名称（TS 会话与诊断共用）。
    pub fn id(self) -> &'static str {
        match self {
            DraftKind::Modify => "modify",
            DraftKind::Magnetic => "magnetic",
            DraftKind::ColorRange => "colorRange",
            DraftKind::Grow => "grow",
            DraftKind::Similar => "similar",
            DraftKind::Refine => "refine",
            DraftKind::QuickMask => "quickMask",
            DraftKind::Smart => "smart",
        }
    }

    /// 从对外名称解析（未知种类返回 `None`，不静默当成别的草稿）。
    pub fn from_id(text: &str) -> Option<Self> {
        Some(match text {
            "modify" => DraftKind::Modify,
            "magnetic" => DraftKind::Magnetic,
            "colorRange" => DraftKind::ColorRange,
            "grow" => DraftKind::Grow,
            "similar" => DraftKind::Similar,
            "refine" => DraftKind::Refine,
            "quickMask" => DraftKind::QuickMask,
            "smart" => DraftKind::Smart,
            _ => return None,
        })
    }

    /// 提交时使用的上游命令 id。
    fn command(self) -> &'static str {
        match self {
            DraftKind::Modify => "select.modify",
            DraftKind::Magnetic => "select.magneticLasso",
            DraftKind::ColorRange => "select.colorRange",
            DraftKind::Grow => "select.grow",
            DraftKind::Similar => "select.similar",
            DraftKind::Refine => "select.refineEdge",
            DraftKind::QuickMask => "select.editInQuickMaskMode",
            DraftKind::Smart => "select.smart",
        }
    }

    /// 历史步骤名称（确认时写入一次）。
    fn label(self) -> &'static str {
        match self {
            DraftKind::Modify => "修改选区",
            DraftKind::Magnetic => "磁性套索",
            DraftKind::ColorRange => "色彩范围",
            DraftKind::Grow => "扩大选取",
            DraftKind::Similar => "选取相似",
            DraftKind::Refine => "选择并遮住",
            DraftKind::QuickMask => "快速蒙版",
            DraftKind::Smart => "传统分割选区",
        }
    }
}

fn error(id: &'static str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

/// U21 智能选择确认时的输出目标：缺省是选区，`mask` 表示同一候选再转成图层蒙版。
fn smart_output_is_mask(params: &Value) -> bool {
    matches!(params.get("output").and_then(Value::as_str), Some("mask" | "layerMask"))
}

/// 在活动文档的副本上跑真实命令，得到候选文档；正式会话不被触碰。
fn scratch_execute(base: &DocState, id: &str, params: Value) -> Result<DocState> {
    let mut scratch = photocraft_engine::Session::new();
    scratch.add_document((*base.doc).clone(), None);
    if let Some(active) = scratch.active_mut() {
        *active = base.clone();
    }
    scratch
        .execute(id, params)
        .map_err(|failure| error(static_command(id), failure))?;
    scratch
        .active()
        .cloned()
        .ok_or_else(|| error(static_command(id), "临时会话没有活动文档"))
}

fn static_command(id: &str) -> &'static str {
    match id {
        "select.magneticLasso" => "select.magneticLasso",
        "select.refineEdge" => "select.refineEdge",
        "select.colorRange" => "select.colorRange",
        "select.grow" => "select.grow",
        "select.similar" => "select.similar",
        "select.editInQuickMaskMode" => "select.editInQuickMaskMode",
        _ => "select.modify",
    }
}

/// 一次选区／蒙版草稿：候选文档 + 一次确认要提交的命令与参数。
pub(crate) struct SelectionDraft {
    base: DocState,
    /// 候选文档（`preview_document` 直接读它，供画布与边界预览）。
    pub document: std::sync::Arc<Document>,
    kind: DraftKind,
    /// 传统分割真正要执行的命令（其余草稿由 [`DraftKind::command`] 决定）。
    smart_command: Option<&'static str>,
    /// 提交参数（已经过校验，可原样交给上游）。
    pub params: Value,
    /// 候选结果摘要（传统分割的覆盖度/包围盒；其余草稿为空对象）。
    preview: Value,
    /// 修改／按颜色扩大草稿的数值（旧 `describe()` 契约与回执用）。
    amount: f64,
    /// 最后一次输入非法：拒绝确认上一份成功候选。
    invalid: bool,
    /// 快速蒙版会话里已经画上去的笔迹数（回执与测试用）。
    strokes: usize,
}

impl SelectionDraft {
    /// 选区修改草稿：没有可修改选区、半径非法或结果为空时拒绝。
    pub fn new(base: &DocState, operation: &str, radius: f64) -> Result<Self> {
        let modify = SelectionModify::from_str(operation)
            .ok_or_else(|| error("select.modify", format!("未知选区修改：{operation}")))?;
        if base.doc.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
            return Err(error("select.modify", "没有可修改的选区"));
        }
        if !radius.is_finite() || radius <= 0.0 {
            return Err(error("select.modify", "半径必须是正的有限数值"));
        }
        let max = match modify {
            SelectionModify::Feather => 100.0,
            _ => f64::from(photocraft_project_verify::limits::MAX_SELECTION_RADIUS),
        };
        if radius > max {
            return Err(error("select.modify", format!("半径超过上限 {max} 源像素")));
        }
        let params = json!({ "radius": radius });
        let document = scratch_execute(base, modify.command(), params.clone())?.doc;
        if document.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
            return Err(error("select.modify", "修改后的选区为空，请调整半径"));
        }
        Ok(Self {
            base: base.clone(),
            document,
            kind: DraftKind::Modify,
            smart_command: None,
            params: json!({ "operation": operation, "radius": radius }),
            preview: json!({}),
            amount: radius,
            invalid: false,
            strokes: 0,
        })
    }

    /// 磁性套索草稿：至少 3 个锚点，预览使用真实追踪后的内核边界。
    pub fn magnetic(base: &DocState, params: Value) -> Result<Self> {
        let points = params
            .get("points")
            .and_then(Value::as_array)
            .ok_or_else(|| error("select.magneticLasso", "缺少 points（至少 3 个锚点）"))?;
        if points.len() < 3 {
            return Err(error("select.magneticLasso", "磁性套索至少需要 3 个锚点"));
        }
        let mut compiled = params.clone();
        if let Some(object) = compiled.as_object_mut() {
            // 预览与确认走同一份参数；默认由内核追踪，界面不自己猜边界。
            object.entry("trace").or_insert(json!(true));
        }
        let document = scratch_execute(base, "select.magneticLasso", compiled.clone())?.doc;
        if document.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
            return Err(error("select.magneticLasso", "追踪结果为空，请调整锚点或宽度"));
        }
        Ok(Self {
            base: base.clone(),
            document,
            kind: DraftKind::Magnetic,
            smart_command: None,
            params: compiled,
            preview: json!({}),
            amount: 0.0,
            invalid: false,
            strokes: 0,
        })
    }

    /// 色彩范围草稿：至少一个取样点、预设或颜色。
    pub fn color_range(base: &DocState, params: Value) -> Result<Self> {
        let has_points = params
            .get("points")
            .and_then(Value::as_array)
            .is_some_and(|points| !points.is_empty());
        let has_minus = params
            .get("subtractPoints")
            .and_then(Value::as_array)
            .is_some_and(|points| !points.is_empty());
        let has_preset = params
            .get("select")
            .and_then(Value::as_str)
            .is_some_and(|preset| preset != "sampledColors");
        let has_color = params.get("color").is_some() || params.get("colors").is_some();
        if !has_points && !has_minus && !has_preset && !has_color {
            return Err(error("select.colorRange", "缺少取样点、预设范围或颜色"));
        }
        if params.get("detectFaces").and_then(Value::as_bool) == Some(true) {
            return Err(error("select.colorRange", "detectFaces 未实现；请去掉该选项再取样"));
        }
        let mut compiled = params.clone();
        if let Some(object) = compiled.as_object_mut() {
            object.entry("sampleAllLayers").or_insert(json!(true));
            // 局部颜色群组范围是画布长边的百分比；越界直接拒绝而不是悄悄改值。
            if let Some(range) = object.get("range").and_then(Value::as_f64) {
                if !range.is_finite() || !(0.0..=100.0).contains(&range) {
                    return Err(error("select.colorRange", "群组范围必须在 0–100 之间"));
                }
            }
            if object.get("localized").and_then(Value::as_bool) == Some(true) && !has_points {
                return Err(error("select.colorRange", "局部颜色群组需要至少一个取样点"));
            }
        }
        let document = scratch_execute(base, "select.colorRange", compiled.clone())?.doc;
        if document.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
            return Err(error("select.colorRange", "取样没有命中任何像素，请调整容差或取样点"));
        }
        Ok(Self {
            base: base.clone(),
            document,
            kind: DraftKind::ColorRange,
            smart_command: None,
            params: compiled,
            preview: json!({}),
            amount: 0.0,
            invalid: false,
            strokes: 0,
        })
    }

    /// 按颜色扩大／选取相似草稿：与几何扩展不同，必须已有选区。
    pub fn color_grow(base: &DocState, similar: bool, params: Value) -> Result<Self> {
        let kind = if similar { DraftKind::Similar } else { DraftKind::Grow };
        if base.doc.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
            return Err(error(kind.command(), "没有可扩大或相似的选区"));
        }
        let tolerance = match params.get("tolerance") {
            None | Some(Value::Null) => 32.0,
            Some(value) => value
                .as_f64()
                .filter(|value| value.is_finite() && (0.0..=255.0).contains(value))
                .ok_or_else(|| error(kind.command(), "容差必须是 0–255 之间的数值"))?,
        };
        let compiled = json!({
            "tolerance": tolerance,
            "sampleAllLayers": params.get("sampleAllLayers").and_then(Value::as_bool).unwrap_or(false),
        });
        let document = scratch_execute(base, kind.command(), compiled.clone())?.doc;
        if document.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
            return Err(error(kind.command(), "扩大后选区为空，请调整容差"));
        }
        Ok(Self {
            base: base.clone(),
            document,
            kind,
            smart_command: None,
            params: compiled,
            preview: json!({}),
            amount: tolerance,
            invalid: false,
            strokes: 0,
        })
    }

    /// 选择并遮住草稿：真实像素边缘预览；新文档输出先核对打开文档名额。
    pub fn refine(base: &DocState, params: Value) -> Result<Self> {
        let output = RefineOutput::parse(params.get("output"))?;
        let mut compiled = refine_edge_params(&params, output)?;
        let strokes = refine_brushes(&params)?;
        if !strokes.is_empty() {
            compiled["refineStrokes"] = json!(strokes);
        }
        if let Some(amount) = params.get("amount") {
            let amount = amount
                .as_f64()
                .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
                .ok_or_else(|| error("select.refineEdge", "净化颜色量必须在 0–100 之间"))?;
            compiled["amount"] = json!(amount);
        }
        if params.get("decontaminate").and_then(Value::as_bool) == Some(true) {
            compiled["decontaminate"] = json!(true);
        }
        let has_mask = base
            .active_layer
            .and_then(|id| base.doc.layer(id))
            .and_then(|layer| layer.mask.as_ref())
            .is_some();
        if base.doc.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) && !has_mask {
            return Err(error("select.refineEdge", "没有可细化的选区或蒙版"));
        }
        if output.opens_document() {
            // 预览不创建文档：先确认命令能算出结果，候选文档仍是当前文档（画面不被新文档替换）；
            // 名额在确认时再核对一次。
            scratch_execute(base, "select.refineEdge", compiled.clone())?;
            return Ok(Self {
                base: base.clone(),
                document: base.doc.clone(),
                kind: DraftKind::Refine,
                smart_command: None,
                params: compiled,
                preview: json!({}),
                amount: 0.0,
                invalid: false,
                strokes: strokes.len(),
            });
        }
        let document = scratch_execute(base, "select.refineEdge", compiled.clone())?.doc;
        Ok(Self {
            base: base.clone(),
            document,
            kind: DraftKind::Refine,
            smart_command: None,
            params: compiled,
            preview: json!({}),
            amount: 0.0,
            invalid: false,
            strokes: 0,
        })
    }

    /// 快速蒙版会话：候选文档已进入 Quick Mask（保留进入时的选区基线）。
    pub fn quick_mask(base: &DocState) -> Result<Self> {
        if base.doc.quick_mask.is_some() {
            return Err(error("select.editInQuickMaskMode", "已在快速蒙版模式"));
        }
        let params = json!({ "on": true });
        let document = scratch_execute(base, "select.editInQuickMaskMode", params.clone())?.doc;
        if document.quick_mask.is_none() {
            return Err(error("select.editInQuickMaskMode", "进入快速蒙版失败"));
        }
        Ok(Self {
            base: base.clone(),
            document,
            kind: DraftKind::QuickMask,
            smart_command: None,
            params,
            preview: json!({}),
            amount: 0.0,
            invalid: false,
            strokes: 0,
        })
    }

    /// 传统分割草稿：候选结果由真实上游命令算出，确认时用同一份参数执行一次。
    pub fn smart_select(base: &DocState, command: &'static str, params: Value, preview: Value) -> Result<Self> {
        Ok(Self {
            base: base.clone(),
            document: base.doc.clone(),
            kind: DraftKind::Smart,
            smart_command: Some(command),
            params,
            preview,
            amount: 0.0,
            invalid: false,
            strokes: 0,
        })
    }

    /// 快速蒙版笔迹：只写候选文档的临时选择通道，不触碰图层像素或像素蒙版。
    pub fn paint_quick_mask(&mut self, params: Value) -> Result<Value> {
        if self.kind != DraftKind::QuickMask {
            return Err(error("select.editInQuickMaskMode", "当前草稿不是快速蒙版"));
        }
        let mut stroke = params;
        let Some(object) = stroke.as_object_mut() else {
            return Err(error("select.editInQuickMaskMode", "笔迹参数必须是对象"));
        };
        // 快速蒙版是临时选择目标：显式指定，避免落到画笔当前目标的图层像素上。
        object.insert("target".into(), json!("quickMask"));
        let candidate = scratch_execute(&self.candidate_state(), "paint.stroke", stroke)
            .map_err(|failure| error("select.editInQuickMaskMode", failure.message()))?;
        self.document = candidate.doc;
        self.strokes += 1;
        Ok(json!({ "strokes": self.strokes, "quickMask": true }))
    }

    /// 候选文档的会话快照（笔迹需要以候选为基线，而不是正式文档）。
    fn candidate_state(&self) -> DocState {
        let mut state = self.base.clone();
        state.doc = self.document.clone();
        state
    }

    /// 草稿种类。
    pub fn kind(&self) -> DraftKind {
        self.kind
    }

    /// 最近一次输入是否非法（非法时禁止确认旧候选）。
    pub fn invalid(&self) -> bool {
        self.invalid
    }

    /// 标记最后一份输入非法。
    pub fn mark_invalid(&mut self) {
        self.invalid = true;
    }

    /// 草稿所属文档与修订（调用方据此丢弃过期候选）。
    pub fn owner(&self) -> (u64, u64) {
        (self.base.doc.id.0, self.base.revision)
    }

    /// 打开草稿时的文档快照：更新预览时以它为基线重新计算，避免叠加在旧候选上。
    pub fn base_state(&self) -> DocState {
        self.base.clone()
    }

    /// 候选选区包围盒（预览叠加用）。
    pub fn bounds(&self) -> Option<[i32; 4]> {
        selection_bounds(&self.document)
    }

    /// 候选边界线段：预览显示的就是确认后内核的边界（同一份候选文档）。
    pub fn outline(&self) -> Vec<[i32; 4]> {
        self.document
            .selection
            .as_ref()
            .map(crate::selection_outline::selection_outline)
            .unwrap_or_default()
    }

    /// 候选文档里的蒙版包围盒（细化到蒙版时预览用）。
    pub fn mask_bounds(&self) -> Option<[i32; 4]> {
        let layer = self.base.active_layer?;
        let rect = self.document.layer(layer)?.mask.as_ref()?.surface.content_bounds();
        (!rect.is_empty()).then(|| [rect.x0, rect.y0, rect.width() as i32, rect.height() as i32])
    }

    /// 候选结果的行数（快速蒙版之外的草稿用它报告“真的改了”）。
    pub fn describe(&self) -> Value {
        match self.kind {
            DraftKind::Modify => json!({ "command": "select.modify", "radius": self.amount }),
            DraftKind::QuickMask => json!({
                "command": self.kind.command(),
                "kind": self.kind.id(),
                "strokes": self.strokes,
                "quickMask": true,
                // U20「覆盖色查看」：候选文档里临时通道真正的覆盖色/不透明度/着色的那一侧。
                // 视图层要用它画叠色；缺了它就只能显示一句"正在快速蒙版"而没有颜色依据。
                "overlay": quick_mask_overlay(&self.document),
            }),
            _ => json!({
                "command": self.smart_command.unwrap_or_else(|| self.kind.command()),
                "kind": self.kind.id(),
                "params": self.params,
                "preview": self.preview,
                "invalid": self.invalid,
            }),
        }
    }

    /// 确认：修改草稿整份候选作为一步历史；其余草稿把同一份参数交给活动会话。
    ///
    /// 快速蒙版先把候选（已退出 Quick Mask 并转回选区）整份提交一次，不额外增加历史。
    pub fn apply(&self, session: &mut photocraft_engine::Session) -> Result<Value> {
        if self.invalid {
            return Err(error(static_command(self.kind.command()), "最后一次输入非法，请修正或取消后再确认"));
        }
        match self.kind {
            DraftKind::Modify | DraftKind::QuickMask => {
                let document = match self.kind {
                    DraftKind::QuickMask => {
                        // 退出快速蒙版：候选里的临时通道按内核规则转回选区。
                        scratch_execute(&self.candidate_state(), "select.editInQuickMaskMode", json!({ "on": false }))?.doc
                    }
                    _ => self.document.clone(),
                };
                crate::preview_history::commit(session, document, Some(self.base.active_layer), self.kind.label())
                    .map_err(|failure| error(static_command(self.kind.command()), failure))?;
                Ok(json!({ "committed": true, "bounds": self.bounds(), "kind": self.kind.id() }))
            }
            _ => {
                if self.kind == DraftKind::Refine && RefineOutput::parse(self.params.get("output"))?.opens_document() {
                    let count = session.documents().len();
                    if count >= MAX_OPEN_DOCUMENTS {
                        return Err(error(
                            "select.refineEdge",
                            format!("已打开 {count} 个文档，达到上限 {MAX_OPEN_DOCUMENTS}；请先关闭其他文档"),
                        ));
                    }
                }
                let mut params = self.params.clone();
                let to_mask = self.kind == DraftKind::Smart && smart_output_is_mask(&self.params);
                if let Some(object) = params.as_object_mut() {
                    // 预览专用标记不能交给上游命令。
                    object.remove("previewOnly");
                    // `output` 只有传统分割的草稿意图才要剥掉：选择并遮住的 `output` 是上游真参数。
                    if self.kind == DraftKind::Smart {
                        object.remove("output");
                    }
                }
                let command = self.smart_command.unwrap_or_else(|| self.kind.command());
                // U21：确认时可按「蒙版」输出。传统分割命令本身只写选区，这里在同一会话里补一步
                // 选区→图层蒙版的转换。两条命令带上同一个 `coalesce` 键，合并成**一步**历史，
                // 用户一次撤销就能回到确认前。
                let coalesce = format!("select.draft.{}.{}", command, self.base.revision);
                if to_mask {
                    if let Some(object) = params.as_object_mut() {
                        object.insert("coalesce".into(), json!(coalesce));
                    }
                }
                let result = session
                    .execute(command, params)
                    .map_err(|failure| error(static_command(command), failure))?;
                if to_mask {
                    let mask_params = json!({ "coalesce": coalesce });
                    session
                        .execute("layer.layerMask.revealSelection", mask_params)
                        .map_err(|failure| error(static_command(command), format!("输出到蒙版失败：{failure}")))?;
                }
                // 确认后的边界以正式会话为准（新文档/新层输出不改当前文档的选区）。
                let bounds = session
                    .active()
                    .and_then(|state| selection_bounds(&state.doc))
                    .or_else(|| self.bounds());
                Ok(json!({
                    "committed": true,
                    "kind": self.kind.id(),
                    "bounds": bounds,
                    "result": result,
                }))
            }
        }
    }

    /// 与 [`Self::apply`] 相同，但只报告成功（既有 `commit_selection_modify` 契约）。
    pub fn commit(&self, session: &mut photocraft_engine::Session) -> Result<()> {
        self.apply(session).map(|_| ())
    }
}

/// 快速蒙版叠色的可读描述：`#rrggbb` + 0..1 不透明度 + 着色的是遮住还是选中的一侧。
///
/// 直接读候选文档里的临时通道，不另存一份；没有快速蒙版时返回 `null`。
pub(crate) fn quick_mask_overlay(document: &Document) -> Option<Value> {
    let channel = document.quick_mask.as_ref()?;
    let [r, g, b, _] = channel.color.to_rgba8();
    Some(json!({
        "color": format!("#{r:02x}{g:02x}{b:02x}"),
        "opacity": channel.opacity,
        "indicates": match channel.indicates {
            photocraft_doc::ColorIndicates::MaskedAreas => "maskedAreas",
            photocraft_doc::ColorIndicates::SelectedAreas => "selectedAreas",
        },
    }))
}

/// 候选选区包围盒 `[x, y, w, h]`（与 `selectionBounds` 视图同一约定）。
pub(crate) fn selection_bounds(document: &Document) -> Option<[i32; 4]> {
    document
        .selection
        .as_ref()
        .map(|selection| selection.content_bounds())
        .filter(|rect| !rect.is_empty())
        .map(|rect| [rect.x0, rect.y0, rect.width() as i32, rect.height() as i32])
}

/// 选区修改操作（预览草稿用）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionModify {
    Expand,
    Contract,
    Smooth,
    Border,
    Feather,
}

impl SelectionModify {
    fn command(self) -> &'static str {
        match self {
            SelectionModify::Expand => "select.modify.expand",
            SelectionModify::Contract => "select.modify.contract",
            SelectionModify::Smooth => "select.modify.smooth",
            SelectionModify::Border => "select.modify.border",
            SelectionModify::Feather => "select.modify.feather",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "expand" => SelectionModify::Expand,
            "contract" => SelectionModify::Contract,
            "smooth" => SelectionModify::Smooth,
            "border" => SelectionModify::Border,
            "feather" => SelectionModify::Feather,
            _ => return None,
        })
    }
}

/// 把边缘细化参数编译成上游命令参数，并校验范围。
pub fn refine_edge_params(params: &Value, output: RefineOutput) -> Result<Value> {
    let number = |key: &str, range: (f64, f64), fallback: f64| -> Result<f64> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(fallback),
            Some(value) => value
                .as_f64()
                .filter(|value| value.is_finite() && *value >= range.0 && *value <= range.1)
                .ok_or_else(|| error("select.refineEdge", format!("{key} 必须在 {}–{} 之间", range.0, range.1))),
        }
    };
    // 上游 `radius` 上限 250 源像素；界面沿用同一范围，避免“看起来能调、确认才报错”。
    let radius = number("radius", (0.0, 250.0), 0.0)?;
    let smooth = number("smooth", (0.0, 100.0), 0.0)?;
    let feather = number("feather", (0.0, 1000.0), 0.0)?;
    let contrast = number("contrast", (0.0, 100.0), 0.0)?;
    let shift = number("shiftEdge", (-100.0, 100.0), 0.0)?;
    Ok(json!({
        "radius": radius,
        "smartRadius": params.get("smartRadius").and_then(Value::as_bool).unwrap_or(false),
        "smooth": smooth,
        "feather": feather,
        "contrast": contrast,
        "shiftEdge": shift,
        "output": output.command(),
        "sampleAllLayers": params.get("sampleAllLayers").and_then(Value::as_bool).unwrap_or(false),
    }))
}

/// 手工修边笔迹（前景／背景刷）：只是 refineEdge 的参数，不引入 AI 主体识别。
///
/// 上游 `refineStrokes` 的 `mode` 是 `add|subtract`；本域的界面用语是前景（add：按图像重新
/// 细化画过的区域）与背景（subtract：保留原边缘）。两者只在这里换算一次。
pub fn refine_brushes(params: &Value) -> Result<Vec<Value>> {
    let Some(list) = params.get("refineStrokes") else {
        return Ok(Vec::new());
    };
    let list = list
        .as_array()
        .ok_or_else(|| error("select.refineEdge", "refineStrokes 必须是数组"))?;
    if list.len() > 4096 {
        return Err(error("select.refineEdge", "手工修边笔迹最多 4096 条"));
    }
    let mut total = 0usize;
    let mut out = Vec::with_capacity(list.len());
    for stroke in list {
        let points = stroke
            .get("points")
            .and_then(Value::as_array)
            .ok_or_else(|| error("select.refineEdge", "修边笔迹缺少 points"))?;
        if points.is_empty() {
            return Err(error("select.refineEdge", "修边笔迹至少要有一个点"));
        }
        total = total.saturating_add(points.len());
        if total > 100_000 {
            return Err(error("select.refineEdge", "修边笔迹总点数超过上限（100000）"));
        }
        let mode = match stroke.get("mode").and_then(Value::as_str) {
            None | Some("foreground") | Some("add") => "add",
            Some("background") | Some("subtract") => "subtract",
            Some(other) => {
                return Err(error(
                    "select.refineEdge",
                    format!("修边笔迹模式必须是前景（foreground/add）或背景（background/subtract），收到 {other}"),
                ))
            }
        };
        let size = stroke.get("size").and_then(Value::as_f64).unwrap_or(20.0);
        if !size.is_finite() || !(1.0..=500.0).contains(&size) {
            return Err(error("select.refineEdge", "修边笔刷尺寸必须在 1–500"));
        }
        out.push(json!({ "points": points, "mode": mode, "size": size }));
    }
    Ok(out)
}
