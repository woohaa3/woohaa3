//! U57：纯色/渐变/图案填充层是可重编层类型，不是烘好的像素层。
//!
//! 三条写入路径都复用固定上游命令（`layer.newFillLayer.*`、`layer.fill.*.set`、
//! `gradient.fill.*`），本模块只加域内职责：
//! - 写入前按工程预算检查参数、图案资源与图层容量（拒绝时不改文档、不刷新编辑器）；
//! - 参数编辑分两步：`preview_fill_layer` 是**纯函数**，只返回候选合成像素；
//!   `apply_fill_layer` 重新校验后一步提交（无变化不增历史）；
//! - 读回规范参数，面板重开后仍能改填充参数。
//!
//! 草稿不保存在内核算术状态里：预览结果只属于调用方，晚到的预览由宿主代际门禁丢弃，
//! 因此不存在「确认了上一份失败预览」的路径。
use std::sync::Arc;

use photocraft_doc::{Document, Fill, LayerContent, LayerId};
use photocraft_engine::{DocState, Session};
use serde_json::{Value, json};

use crate::error::{EditorError, Result};

pub(crate) const CREATE_IDS: [&str; 3] = [
    "layer.newFillLayer.solidColor",
    "layer.newFillLayer.gradient",
    "layer.newFillLayer.pattern",
];
pub(crate) const EDIT_IDS: [&str; 3] = ["layer.fill.solidColor.set", "layer.fill.pattern.set", "gradient.fill.set"];

/// 预览图最长边（与图层缩略图同量级，避免把整幅画布读回 JS）。
pub(crate) const PREVIEW_SIDE: u32 = 1024;

fn error(id: &str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

fn create_kind(id: &str) -> Option<&'static str> {
    match id {
        "layer.newFillLayer.solidColor" => Some("solid"),
        "layer.newFillLayer.gradient" => Some("gradient"),
        "layer.newFillLayer.pattern" => Some("pattern"),
        _ => None,
    }
}

fn edit_kind(id: &str) -> Option<&'static str> {
    match id {
        "layer.fill.solidColor.set" => Some("solid"),
        "layer.fill.pattern.set" => Some("pattern"),
        "gradient.fill.set" => Some("gradient"),
        _ => None,
    }
}

/// 面板只允许这些键；未知键在写入前拒绝，避免上游忽略后静默执行默认值。
///
/// `path` 只在**创建**时有效：上游 `mask_new_layer` 用它把填充层变成带矢量蒙版的形状层
/// （缺省时用选区做图层蒙版）。忽略它会让「用路径建填充层」静默退化成选区蒙版。
fn allowed_keys(kind: &str) -> &'static [&'static str] {
    match kind {
        "solid" => &["layer", "color", "path"],
        "gradient" => &[
            "layer", "from", "to", "style", "angle", "scale", "offset", "reverse", "dither", "align", "stops", "transparency", "midpoints", "path",
        ],
        _ => &["layer", "pattern", "scale", "angle", "link", "phase", "path"],
    }
}

/// 编辑既有填充层时不接受 `path`：那会悄悄改蒙版类型，而参数命令只改填充本身。
fn allowed_edit_keys(kind: &str) -> &'static [&'static str] {
    match kind {
        "solid" => &["layer", "color"],
        "gradient" => &[
            "layer", "from", "to", "style", "angle", "scale", "offset", "reverse", "dither", "align", "stops", "transparency", "midpoints",
        ],
        _ => &["layer", "pattern", "scale", "angle", "link", "phase"],
    }
}

fn check_params(id: &str, params: &Value, allowed: &[&str]) -> Result<()> {
    let fields = params.as_object().ok_or_else(|| error(id, "填充参数必须为对象"))?;
    if fields.is_empty() {
        return Err(error(id, "填充参数不能为空"));
    }
    if let Some(key) = fields.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(error(id, format!("填充参数不接受 {key}")));
    }
    if let Some(layer) = fields.get("layer") {
        if layer.as_u64().is_none() {
            return Err(error(id, "图层 id 必须为非负整数"));
        }
    }
    Ok(())
}

/// 解析填充参数里的图案：文档资源 → 会话目录 → **用户图案库**。
///
/// 上游 `pattern_cmds::resolve` 只看文档与会话目录；而面板的图案下拉列的是用户图案库
/// （`pattern_library.list`），因此本域必须把库项一起纳入解析，否则「列表里选得到、
/// 一用就报找不到」。
fn resolve_pattern(session: &Session, key: &str, library: &[photocraft_doc::Pattern]) -> Option<photocraft_doc::Pattern> {
    photocraft_engine::pattern_cmds::resolve(session, key)
        .or_else(|| photocraft_doc::pattern::find(library, key, key).cloned())
}

/// 图案资源进入工程预算：与图案样式共用同一组上限，库项本身仍是独立偏好。
fn check_pattern(session: &Session, id: &str, params: &Value, library: &[photocraft_doc::Pattern]) -> Result<()> {
    let key = params.get("pattern").and_then(Value::as_str).unwrap_or("");
    let pattern = resolve_pattern(session, key, library)
        .ok_or_else(|| error(id, format!("找不到图案“{key}”（见图案列表）")))?;
    let mut patterns = session.active().map(|state| state.doc.patterns.clone()).unwrap_or_default();
    if !patterns.iter().any(|existing| existing.id == pattern.id) {
        patterns.push(pattern);
    }
    if !photocraft_project_verify::pattern_support::supported(&patterns) {
        return Err(error(id, "图案资源超过工程上限（数量、单边或累计像素）"));
    }
    Ok(())
}

/// 渐变至少两个端点、至多 1024 个，位置有限且在 0..1。
///
/// 透明度端点沿用上游单位：**百分比 0–100**（`transparency_param` 除以 100 后存盘）。
/// 早期按 0–1 校验会让 `[[0,100],[1,0]]` 通过、`[[0,1]]` 也通过，面板发 0–1 时静默变成
/// 「几乎不透明」，因此这里与上游同单位并写明。
fn check_gradient(id: &str, params: &Value) -> Result<()> {
    for (key, minimum, max_value) in [("stops", 2usize, None), ("transparency", 0usize, Some(100.0))] {
        let Some(list) = params.get(key) else { continue };
        let list = list.as_array().ok_or_else(|| error(id, format!("{key} 必须是数组")))?;
        if list.len() < minimum {
            return Err(error(id, "渐变至少需要两个颜色端点"));
        }
        if list.len() > 1024 {
            return Err(error(id, "渐变端点超过上限（1024）"));
        }
        for stop in list {
            let pair = stop.as_array().filter(|pair| pair.len() == 2).ok_or_else(|| error(id, "端点必须是 [位置, 值]"))?;
            if !pair[0].as_f64().is_some_and(|at| at.is_finite() && (0.0..=1.0).contains(&at)) {
                return Err(error(id, "端点位置必须是 0–1 的有限数"));
            }
            if pair[1].is_null() {
                return Err(error(id, "端点缺少颜色或透明度值"));
            }
            if let Some(max_value) = max_value {
                if !pair[1].as_f64().is_some_and(|value| value.is_finite() && (0.0..=max_value).contains(&value)) {
                    return Err(error(id, "透明度端点必须是 0–100 的百分比"));
                }
            }
        }
    }
    for key in ["reverse", "dither", "align"] {
        if params.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(error(id, format!("{key} 必须是布尔值")));
        }
    }
    if let Some(midpoints) = params.get("midpoints") {
        let list = midpoints.as_array().ok_or_else(|| error(id, "midpoints 必须是数组"))?;
        if list.len() > 1023 {
            return Err(error(id, "渐变中点超过上限（1023）"));
        }
        if !list.iter().all(|value| value.as_f64().is_some_and(|value| value.is_finite() && (0.05..=0.95).contains(&value))) {
            return Err(error(id, "渐变中点必须是 0.05–0.95 的数值"));
        }
    }
    if let Some(offset) = params.get("offset") {
        let valid = offset.as_array().is_some_and(|offset| offset.len() == 2
            && offset.iter().all(|value| value.as_f64().is_some_and(|value| value.is_finite() && value.abs() <= 100_000.0)));
        if !valid {
            return Err(error(id, "渐变偏移必须是 [x%, y%] 两个有限数"));
        }
    }
    if let Some(scale) = params.get("scale") {
        if !scale.as_f64().is_some_and(|scale| scale.is_finite() && scale > 0.0 && scale <= 1000.0) {
            return Err(error(id, "渐变缩放必须是 0–1000 的百分比"));
        }
    }
    Ok(())
}

fn check_create(id: &str, params: &Value, session: &Session, library: &[photocraft_doc::Pattern]) -> Result<&'static str> {
    let kind = create_kind(id).ok_or_else(|| error(id, format!("不是填充层创建命令（{}）", CREATE_IDS.join("、"))))?;
    check_params(id, params, allowed_keys(kind))?;
    if session.active().is_none() {
        return Err(EditorError::NoDocument);
    }
    if let Some(path) = params.get("path") {
        check_path(id, path)?;
    }
    if kind == "pattern" {
        check_pattern(session, id, params, library)?;
    }
    if kind == "gradient" {
        check_gradient(id, params)?;
    }
    Ok(kind)
}

/// `path` 的三种上游形态：`"work"`、已保存路径名、或路径几何对象/数组。
///
/// 这里只拒绝明显不是路径的值，具体几何与「有没有这条路径」仍由上游判定；
/// 但空串必须现在拒绝——上游会把它当成「没有路径」，静默退回选区蒙版。
fn check_path(id: &str, path: &Value) -> Result<()> {
    match path {
        Value::String(name) if !name.trim().is_empty() && name.encode_utf16().count() <= 200 => Ok(()),
        Value::Object(_) | Value::Array(_) => Ok(()),
        Value::String(_) => Err(error(id, "path 必须是 \"work\"、已保存路径名或路径几何，且不能为空")),
        _ => Err(error(id, "path 必须是 \"work\"、已保存路径名或路径几何对象")),
    }
}

fn check_edit(id: &str, params: &Value, session: &Session, library: &[photocraft_doc::Pattern]) -> Result<(&'static str, LayerId)> {
    let kind = edit_kind(id).ok_or_else(|| error(id, format!("不是填充层参数命令（{}）", EDIT_IDS.join("、"))))?;
    // 编辑不接受 `path`：改填充参数不该顺手换掉蒙版类型（那需要显式的蒙版命令）。
    check_params(id, params, allowed_edit_keys(kind))?;
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let target = params.get("layer").and_then(Value::as_u64).map(LayerId).or(state.active_layer)
        .ok_or_else(|| error(id, "没有活动图层"))?;
    let item = state.doc.layer(target).ok_or_else(|| error(id, "图层不存在"))?;
    match (kind, &item.content) {
        ("solid", LayerContent::Fill(Fill::Solid(_)))
        | ("gradient", LayerContent::Fill(Fill::Gradient { .. }))
        | ("pattern", LayerContent::Fill(Fill::Pattern { .. })) => {}
        _ => return Err(error(id, format!("活动图层不是{kind}填充层"))),
    }
    if kind == "pattern" {
        check_pattern(session, id, params, library)?;
    }
    if kind == "gradient" {
        check_gradient(id, params)?;
    }
    Ok((kind, target))
}

/// 面板颜色表示：不透明用 `#rrggbb`，带透明用 `#rrggbbaa`。
fn hex(color: &photocraft_doc::Color) -> String {
    let [r, g, b] = color.to_rgb();
    let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    if color.alpha >= 1.0 {
        format!("#{:02x}{:02x}{:02x}", channel(r), channel(g), channel(b))
    } else {
        format!("#{:02x}{:02x}{:02x}{:02x}", channel(r), channel(g), channel(b), channel(color.alpha))
    }
}

/// 填充层的规范参数：重开后仍能改填充参数。
pub(crate) fn describe(doc: &Document, id: LayerId) -> Result<Value> {
    let layer = doc.layer(id).ok_or_else(|| error("layer.fill", "图层不存在"))?;
    let LayerContent::Fill(fill) = &layer.content else {
        return Err(error("layer.fill", "目标不是填充层"));
    };
    let frame = photocraft_compose::fill_frame(layer, doc.bounds());
    let mut value = match fill {
        Fill::Solid(color) => json!({"kind":"solid","color":hex(color),"alpha":color.alpha}),
        Fill::Gradient { .. } => json!({"kind":"gradient","gradient":photocraft_engine::gradient_fill_cmds::describe_fill(fill, frame)}),
        Fill::Pattern { name, scale, id: pattern, angle, link, phase } => json!({
            "kind":"pattern",
            "pattern":{"id":pattern,"name":name,"scale":scale*100.0,"angle":angle,"link":link,"phase":[phase.0,phase.1]},
        }),
    };
    value["layer"] = json!(id.0);
    value["frame"] = json!([frame.x0, frame.y0, frame.width().max(1), frame.height().max(1)]);
    Ok(value)
}

/// 把用户图案库并入会话目录：上游 `pattern_cmds::resolve` 只查文档与
/// `session.patterns`，而面板下拉列的是用户库，因此写路径必须先把库项送进去。
fn add_library_patterns(session: &mut Session, library: &[photocraft_doc::Pattern]) {
    for pattern in library {
        if !session.patterns.items.iter().any(|existing| existing.id == pattern.id) {
            session.patterns.items.push(pattern.clone());
        }
    }
}

/// 在隔离会话上算出候选文档（不改正式修订、历史或指纹）。
fn candidate(session: &Session, library: &[photocraft_doc::Pattern], command: &str, params: &Value) -> Result<Arc<Document>> {
    let base = session.active().ok_or(EditorError::NoDocument)?.clone();
    let mut scratch = Session::new();
    scratch.add_document((*base.doc).clone(), None);
    *scratch.active_mut().unwrap() = base;
    scratch.tools = session.tools.clone();
    scratch.patterns = session.patterns.clone();
    scratch.presets = session.presets.clone();
    add_library_patterns(&mut scratch, library);
    scratch.execute(command, params.clone()).map_err(|reason| error(command, reason))?;
    let doc = scratch.active().ok_or(EditorError::NoDocument)?.doc.clone();
    if !photocraft_project_verify::style_support::supported_document(&doc) {
        return Err(error(command, "填充结果无法通过样式及图案核验"));
    }
    Ok(doc)
}

/// 新建填充层时把「创建命令不认的参数」拆出来。
///
/// 上游 `layer.newFillLayer.gradient` 的参数只有 `from`/`to`/`angle`/`style`/`reverse`/`path`：
/// 它按两种颜色建一条线性/径向渐变，**不读** `stops`、`transparency`、`scale`、`offset`、
/// `dither`、`align`、`midpoints`。面板却同时提供这些输入，若原样透传，用户设置的端点和缩放会被
/// 静默换成「前景色→背景色」，看起来像「新建的渐变不听话」。因此创建后立刻在**同一隔离会话**上
/// 用 `gradient.fill.set` 落到该层，最后只提交一次——历史仍是一步。
fn split_create_params(id: &str, params: &Value) -> (Value, Option<Value>) {
    const CREATE_KEYS: [&str; 6] = ["from", "to", "angle", "style", "reverse", "path"];
    const FOLLOWUP_KEYS: [&str; 7] = ["stops", "transparency", "scale", "offset", "dither", "align", "midpoints"];
    if id != "layer.newFillLayer.gradient" {
        return (params.clone(), None);
    }
    let Some(fields) = params.as_object() else { return (params.clone(), None) };
    let mut create = serde_json::Map::new();
    let mut followup = serde_json::Map::new();
    for (key, value) in fields {
        if CREATE_KEYS.contains(&key.as_str()) {
            create.insert(key.clone(), value.clone());
        } else if FOLLOWUP_KEYS.contains(&key.as_str()) {
            followup.insert(key.clone(), value.clone());
        }
    }
    let followup = (!followup.is_empty()).then_some(Value::Object(followup));
    (Value::Object(create), followup)
}

/// 创建候选文档并返回新层 id；渐变的两步写入都在隔离会话上完成。
fn create_candidate(session: &Session, library: &[photocraft_doc::Pattern], id: &str, params: &Value) -> Result<(Arc<Document>, LayerId)> {
    let base = session.active().ok_or(EditorError::NoDocument)?.clone();
    let mut scratch = Session::new();
    scratch.add_document((*base.doc).clone(), None);
    *scratch.active_mut().unwrap() = base;
    scratch.tools = session.tools.clone();
    scratch.patterns = session.patterns.clone();
    scratch.presets = session.presets.clone();
    add_library_patterns(&mut scratch, library);
    let (create, followup) = split_create_params(id, params);
    scratch.execute(id, create).map_err(|reason| error(id, reason))?;
    let layer = scratch.active().and_then(|state| state.active_layer).ok_or_else(|| error(id, "填充层未建立"))?;
    if let Some(mut followup) = followup {
        followup["layer"] = json!(layer.0);
        scratch.execute("gradient.fill.set", followup).map_err(|reason| error(id, reason))?;
    }
    let doc = scratch.active().ok_or(EditorError::NoDocument)?.doc.clone();
    if !photocraft_project_verify::style_support::supported_document(&doc) {
        return Err(error(id, "填充层结果无法通过样式及图案核验"));
    }
    Ok((doc, layer))
}

/// 候选文档的合成预览（只读，供 UI 在确认前显示真实像素过渡）。
pub(crate) fn render_preview(doc: &Document, max_side: u32) -> Value {
    let image = photocraft_compose::thumbnail(doc, max_side.clamp(1, PREVIEW_SIDE));
    json!({ "width": image.width, "height": image.height, "pixels": image.pixels })
}

fn capacity(state: &DocState, id: &str) -> Result<()> {
    if crate::layer_preview::layer_count(&state.doc.layers) >= photocraft_project_verify::MAX_LAYERS {
        return Err(error(id, "图层已达工程上限（64 层）"));
    }
    Ok(())
}

impl crate::editor::Editor {
    /// 创建填充层（对外入口）：命令 id 必须先由集成侧发布到能力白名单。
    pub fn new_fill_layer(&mut self, id: &str, params: Value) -> Result<Value> {
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        self.new_fill_layer_inner(id, params)
    }

    /// 填充层的实际写入路径：预检容量与资源后一步提交。
    ///
    /// 渐变创建在隔离会话上先建层、再用 `gradient.fill.set` 落面板提供的端点/缩放等参数，
    /// 然后**整份文档一次提交**：用户看到一步历史，而不是「新建 + 改参数」两步。
    pub(crate) fn new_fill_layer_inner(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let library = self.library_patterns();
        check_create(id, &params, &self.session, &library)?;
        capacity(self.active_doc()?, id)?;
        let (document, layer) = create_candidate(&self.session, &library, id, &params)?;
        if !photocraft_project_verify::style_support::supported_document(&document) {
            return Err(error(id, "填充层结果无法通过样式及图案核验"));
        }
        crate::preview_history::commit_selected(&mut self.session, document, Some(layer), vec![layer], "Fill Layer")
            .map_err(|reason| error(id, reason))?;
        let state = self.active_doc()?;
        describe(&state.doc, layer)    }

    /// 填充层规范参数（只读）。
    pub fn fill_layer_info(&self, layer: u64) -> Result<Value> {
        describe(&self.active_doc()?.doc, LayerId(layer))
    }

    /// 改填充参数的预览（对外入口）：纯函数，正式内容指纹、修订与历史都不变。
    pub fn preview_fill_layer(&self, layer: u64, params: Value) -> Result<Value> {
        let id = edit_kind_for_params(&params)?;
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        self.preview_fill_layer_inner(layer, params, id)
    }

    pub(crate) fn preview_fill_layer_inner(&self, layer: u64, params: Value, id: &str) -> Result<Value> {
        self.require_no_tool_draft()?;
        let routed = route_params(id, layer, params)?;
        let library = self.library_patterns();
        let (_, target) = check_edit(id, &routed, &self.session, &library)?;
        let doc = candidate(&self.session, &library, id, &routed)?;
        let info = describe(&doc, target)?;
        Ok(json!({ "info": info, "preview": render_preview(&doc, PREVIEW_SIDE) }))
    }

    /// 确认填充参数（对外入口）：重新校验最新输入后一步提交；无变化不增历史。
    pub fn apply_fill_layer(&mut self, layer: u64, params: Value) -> Result<Value> {
        let id = edit_kind_for_params(&params)?;
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        self.apply_fill_layer_inner(layer, params, id)
    }

    pub(crate) fn apply_fill_layer_inner(&mut self, layer: u64, params: Value, id: &str) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let routed = route_params(id, layer, params)?;
        let library = self.library_patterns();
        let (_, target) = check_edit(id, &routed, &self.session, &library)?;
        let doc = candidate(&self.session, &library, id, &routed)?;
        let before = &self.active_doc()?.doc;
        let changed = !Arc::ptr_eq(before, &doc) && **before != *doc;
        if changed {
            crate::preview_history::commit(&mut self.session, doc, None, "Fill Layer").map_err(|reason| error(id, reason))?;
        }
        let state = self.active_doc()?;
        let mut info = describe(&state.doc, target)?;
        info["changed"] = json!(changed);
        Ok(info)
    }
}

/// 把面板参数转成上游命令参数：`fillKind` 只是面板的路由标记，不属于写入参数。
fn route_params(id: &str, layer: u64, params: Value) -> Result<Value> {
    let kind = edit_kind(id).ok_or_else(|| error(id, "不是填充层参数命令"))?;
    let Value::Object(mut fields) = params else {
        return Err(error(id, "填充参数必须为对象"));
    };
    if fields.remove("fillKind").is_some_and(|value| value.as_str() != Some(kind)) {
        return Err(error(id, "fillKind 与填充命令不匹配"));
    }
    fields.insert("layer".into(), json!(layer));
    Ok(Value::Object(fields))
}

/// 参数类型由 `fillKind` 决定（面板已知目标层种类，不需要再猜）。
fn edit_kind_for_params(params: &Value) -> Result<&'static str> {
    match params.get("fillKind").and_then(Value::as_str) {
        Some("solid") => Ok("layer.fill.solidColor.set"),
        Some("gradient") => Ok("gradient.fill.set"),
        Some("pattern") => Ok("layer.fill.pattern.set"),
        Some(other) => Err(error("layer.fill", format!("未知填充参数类型：{other}"))),
        None => Err(error("layer.fill", "填充参数缺少 fillKind（solid、gradient 或 pattern）")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::Editor;
    use serde_json::json;

    fn sample_png(width: u32, height: u32) -> Vec<u8> {
        use photocraft_doc::{Color, ColorMode, Document, SampleType, Size};
        let doc = Document::with_background("sample", Size { width, height }, ColorMode::Rgb, SampleType::U8, Color::rgb(0.2, 0.4, 0.6));
        photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default()).unwrap().bytes
    }

    fn preview(editor: &Editor, layer: u64, params: Value) -> Result<Value> {
        let id = edit_kind_for_params(&params)?;
        editor.preview_fill_layer_inner(layer, params, id)
    }

    fn apply(editor: &mut Editor, layer: u64, params: Value) -> Result<Value> {
        let id = edit_kind_for_params(&params)?;
        editor.apply_fill_layer_inner(layer, params, id)
    }

    fn editor() -> Editor {
        let mut editor = Editor::new();
        editor.open_image("photo.png", None, &sample_png(48, 32)).unwrap();
        editor.execute("layer.new.layer", Value::Null).unwrap();
        editor
    }

    #[test]
    fn all_three_fill_kinds_stay_editable_and_survive_reopen() {
        let mut editor = editor();
        for (index, (command, params, kind)) in [
            ("layer.newFillLayer.solidColor", json!({"color":"#3366ff"}), "solid"),
            ("layer.newFillLayer.gradient", json!({"from":"#ff0000","to":"#0000ff","angle":45}), "gradient"),
            ("layer.newFillLayer.pattern", json!({"pattern":"Checkerboard","scale":200}), "pattern"),
        ].into_iter().enumerate() {
            let created = editor.new_fill_layer_inner(command, params).unwrap();
            assert_eq!(created["kind"], kind, "{command}");
            let layer = created["layer"].as_u64().unwrap();
            let bytes = editor.save_project().unwrap();
            let mut reopened = Editor::new();
            reopened.open_project(&bytes, None).unwrap();
            assert_eq!(reopened.fill_layer_info(layer).unwrap()["kind"], kind);
            // 每种填充层都随工程保存并可重开核验。
            assert_eq!(photocraft_project_verify::verify(&bytes).unwrap().layer_count, 3 + index);
        }
        // 填充层是可重编内容，不是烘成像素层。
        assert!(editor.active_doc().unwrap().doc.walk().iter().any(|(_, _, layer)| matches!(layer.content, LayerContent::Fill(_))));
    }

    #[test]
    fn gradient_create_applies_panel_params_that_the_create_command_drops() {
        let mut editor = editor();
        let before = editor.active_doc().unwrap().history.past_len();
        // 面板会同时给 stops / transparency / scale / offset / reverse / dither / align；
        // 上游创建命令只认 from/to/angle/style/reverse，其余必须在同一提交里落到该层。
        let created = editor.new_fill_layer_inner("layer.newFillLayer.gradient", json!({
            "stops":[[0.0,"#ff0000"],[0.5,"#00ff00"],[1.0,"#0000ff"]],
            "transparency":[[0.0,100],[1.0,20]],
            "style":"radial","angle":30,"scale":70,"offset":[10,-5],
            "reverse":true,"dither":true,"align":true
        })).unwrap();
        assert_eq!(created["kind"], "gradient");
        let gradient = &created["gradient"];
        // 端点是用户设的三色，不是「前景色→背景色」。
        let stops = gradient["stops"].as_array().unwrap();
        assert_eq!(stops.len(), 3);
        assert_eq!(stops[1][1], "#00ff00");
        // 透明度端点按百分比 0–100 存盘。
        let transparency = gradient["transparency"].as_array().unwrap();
        assert_eq!(transparency.len(), 2);
        assert_eq!(transparency[1][1], 20.0);
        assert_eq!(gradient["scale"], 70.0);
        assert_eq!(gradient["reverse"], true);
        assert_eq!(gradient["dither"], true);
        assert_eq!(gradient["style"], "radial");
        // 参数落盘后仍是一步历史（不是「新建 + 改参数」两步）。
        assert_eq!(editor.active_doc().unwrap().history.past_len(), before + 1);
        editor.undo().unwrap();
        assert_eq!(editor.active_doc().unwrap().history.past_len(), before);
        // 只给 from/to 的旧调用点仍然可用，端点就是这两种颜色。
        let legacy = editor.new_fill_layer_inner("layer.newFillLayer.gradient", json!({"from":"#112233","to":"#445566"})).unwrap();
        let stops = legacy["gradient"]["stops"].as_array().unwrap();
        assert_eq!(stops[0][1], "#112233");
        assert_eq!(stops[1][1], "#445566");
        // 透明度端点单位是百分比：101 越界。
        assert!(editor.new_fill_layer_inner("layer.newFillLayer.gradient", json!({"transparency":[[0,101]]})).is_err());
        // 布尔与中点也必须被校验，而不是静默透传。
        for params in [
            json!({"reverse":"yes"}),
            json!({"offset":[1]}),
            json!({"midpoints":[0.0]}),
        ] {
            assert!(editor.new_fill_layer_inner("layer.newFillLayer.gradient", params.clone()).is_err(), "{params}");
        }
    }

    #[test]
    fn create_and_edit_reject_bad_params_without_touching_the_document() {
        let mut editor = editor();
        let before = editor.active_doc().unwrap().doc.clone();
        let steps = editor.active_doc().unwrap().history.past_len();
        for (command, params) in [
            ("layer.newFillLayer.gradient", json!({"stops":[[0.0,"#ffffff"]]})),
            ("layer.newFillLayer.gradient", json!({"stops":[[0.5,"#ffffff"],[1.5,"#000000"]]})),
            ("layer.newFillLayer.pattern", json!({"pattern":"nope"})),
            ("layer.newFillLayer.solidColor", json!({"color":"#fff","opacity":20})),
            ("layer.newFillLayer.solidColor", Value::Null),
            ("layer.newFillLayer.gradient", json!({"pattern":"Checkerboard"})),
        ] {
            assert!(editor.new_fill_layer_inner(command, params.clone()).is_err(), "{command} {params}");
            assert!(Arc::ptr_eq(&before, &editor.active_doc().unwrap().doc));
            assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
        }
        let created = editor.new_fill_layer_inner("layer.newFillLayer.solidColor", json!({"color":"#123456"})).unwrap();
        let layer = created["layer"].as_u64().unwrap();
        for params in [
            json!({"fillKind":"solid","color":"#ffzz00"}),
            json!({"fillKind":"bogus"}),
            json!({}),
            json!({"fillKind":"gradient","stops":[[0.0,"#fff"]]}),
            json!({"fillKind":"pattern","pattern":"Checkerboard"}),
        ] {
            assert!(preview(&editor, layer, params.clone()).is_err(), "{params}");
            assert!(apply(&mut editor, layer, params.clone()).is_err(), "{params}");
        }
        assert!(preview(&editor, layer, json!({"fillKind":"solid","color":"#ffffff","extra":1})).is_err());
    }

    #[test]
    fn preview_is_read_only_and_apply_is_exactly_one_history_step() {
        let mut editor = editor();
        let created = editor.new_fill_layer_inner("layer.newFillLayer.solidColor", json!({"color":"#112233"})).unwrap();
        let layer = created["layer"].as_u64().unwrap();
        let hash = editor.content_hash().unwrap();
        let revision = editor.revision().unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();
        let preview = preview(&editor, layer, json!({"fillKind":"solid","color":"#ff8800"})).unwrap();
        assert_eq!(preview["info"]["kind"], "solid");
        assert!(preview["preview"]["width"].as_u64().unwrap() > 0);
        assert_eq!(editor.content_hash().unwrap(), hash, "预览不推进正式内容");
        assert_eq!(editor.revision().unwrap(), revision);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
        let applied = apply(&mut editor, layer, json!({"fillKind":"solid","color":"#ff8800"})).unwrap();
        assert_eq!(applied["changed"], true);
        // 内容身份贡献仍由集成侧 `document_content.rs` 接线（见 verification 的集成阻塞），
        // 这里以规范参数与历史边界作为实际写入证据。
        assert_eq!(applied["color"], "#ff8800");
        assert_eq!(editor.fill_layer_info(layer).unwrap()["color"], "#ff8800");
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps + 1);
        editor.undo().unwrap();
        assert_eq!(editor.fill_layer_info(layer).unwrap()["color"], "#112233");
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
        // 同一输入再确认不新增历史。
        let steps = editor.active_doc().unwrap().history.past_len();
        let applied = apply(&mut editor, layer, json!({"fillKind":"solid","color":"#112233"})).unwrap();
        assert_eq!(applied["changed"], false);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
    }

    #[test]
    fn gradient_and_pattern_parameters_round_trip_through_the_panel_model() {
        let mut editor = editor();
        let gradient = editor.new_fill_layer_inner("layer.newFillLayer.gradient", json!({"from":"#ff0000","to":"#0000ff","angle":30})).unwrap();
        let layer = gradient["layer"].as_u64().unwrap();
        let applied = apply(&mut editor, layer, json!({"fillKind":"gradient","angle":120,"style":"radial","reverse":true})).unwrap();
        assert_eq!(applied["gradient"]["style"], "radial");
        assert_eq!(applied["gradient"]["reverse"], true);
        let pattern = editor.new_fill_layer_inner("layer.newFillLayer.pattern", json!({"pattern":"Bricks","scale":50})).unwrap();
        let layer = pattern["layer"].as_u64().unwrap();
        let applied = apply(&mut editor, layer, json!({"fillKind":"pattern","scale":250,"angle":-45,"link":false,"phase":[3,-4]})).unwrap();
        assert_eq!(applied["pattern"]["scale"], 250.0);
        assert_eq!(applied["pattern"]["link"], false);
        // 图案应用后资源留在文档里，重开仍能渲染。
        let bytes = editor.save_project().unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();
        let mut reopened = Editor::new();
        reopened.open_project(&bytes, None).unwrap();
        assert_eq!(reopened.fill_layer_info(layer).unwrap()["pattern"]["scale"], 250.0);
    }

    /// U57 成功证据之一：填充层带**选区蒙版**，且蒙版不随参数编辑丢失。
    ///
    /// 上游 `layer.newFillLayer.*` 以选区生成图层蒙版（无选区则白蒙版）。
    /// 本域包装必须原样保留这条语义，否则「填充层 + 蒙版」会退化成整幅覆盖。
    #[test]
    fn fill_layers_take_the_selection_as_mask_and_keep_it_across_edits() {
        let mut editor = editor();
        editor.execute("select.rect", json!({"x":6,"y":4,"width":12,"height":10})).unwrap();
        let created = editor.new_fill_layer_inner("layer.newFillLayer.solidColor", json!({"color":"#112233"})).unwrap();
        let layer = LayerId(created["layer"].as_u64().unwrap());
        let mask = editor.active_doc().unwrap().doc.layer(layer).unwrap().mask.clone().expect("选区生成填充层蒙版");
        assert!(mask.linked, "新层蒙版默认跟随图层");
        // 蒙版确实只覆盖选区：左上角在选区外。
        assert_eq!(mask.value(0, 0), 0.0);
        assert_eq!(mask.value(10, 8), 1.0);
        // 改参数不丢蒙版，且不改变蒙版像素。
        let applied = apply(&mut editor, layer.0, json!({"fillKind":"solid","color":"#ff8800"})).unwrap();
        assert_eq!(applied["changed"], true);
        let after = editor.active_doc().unwrap().doc.layer(layer).unwrap().mask.clone().unwrap();
        assert_eq!(after.value(0, 0), 0.0);
        assert_eq!(after.value(10, 8), 1.0);
        // 无选区时新建填充层是白蒙版（整幅显示），而不是没有蒙版。
        editor.execute("select.deselect", Value::Null).unwrap();
        let plain = editor.new_fill_layer_inner("layer.newFillLayer.gradient", json!({"from":"#ffffff","to":"#000000"})).unwrap();
        let plain = LayerId(plain["layer"].as_u64().unwrap());
        let reveal = editor.active_doc().unwrap().doc.layer(plain).unwrap().mask.clone().expect("无选区也建立白蒙版");
        assert_eq!(reveal.value(0, 0), 1.0);
    }

    /// U57：`path` 让填充层带**矢量蒙版**（上游 `mask_new_layer` 的形状层分支）。
    ///
    /// 内核/API 面必须接受 `path`；若校验器把它当未知键拒绝，这条上游已有的能力就永远不可达。
    /// 编辑既有填充层时反过来必须拒绝 `path`：改参数不该顺手换掉蒙版类型。
    #[test]
    fn path_creates_a_vector_masked_fill_and_is_rejected_on_edit() {
        let mut editor = editor();
        let path = json!({
            "subpaths": [{
                "closed": true,
                "knots": [[4, 4], [20, 4], [20, 18], [4, 18]]
            }]
        });
        let created = editor.new_fill_layer_inner("layer.newFillLayer.solidColor", json!({"color":"#224466","path":path})).unwrap();
        let layer = LayerId(created["layer"].as_u64().unwrap());
        let item = editor.active_doc().unwrap().doc.layer(layer).unwrap();
        assert!(item.vector_mask.is_some(), "path 建立矢量蒙版");
        assert!(item.mask.is_none(), "矢量蒙版与像素蒙版二选一");
        // 编辑不接受 path：先看清这是显式拒绝，而不是静默换蒙版。
        let steps = editor.active_doc().unwrap().history.past_len();
        let reason = apply(&mut editor, layer.0, json!({"fillKind":"solid","color":"#ffffff","path":path})).unwrap_err();
        assert!(reason.to_string().contains("path"), "{reason}");
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
        assert!(editor.active_doc().unwrap().doc.layer(layer).unwrap().vector_mask.is_some());
        // 空串不能冒充路径：上游会当成「没有路径」退回选区蒙版。
        let reason = editor.new_fill_layer_inner("layer.newFillLayer.solidColor", json!({"color":"#ffffff","path":"  "})).unwrap_err();
        assert!(reason.to_string().contains("path"), "{reason}");
    }

    #[test]
    fn locks_and_capacity_block_creation_and_edits() {
        let mut editor = editor();
        let created = editor.new_fill_layer_inner("layer.newFillLayer.solidColor", json!({"color":"#123456"})).unwrap();
        let layer = created["layer"].as_u64().unwrap();
        editor.execute("layer.lockLayers", json!({"all":true})).unwrap();
        assert!(apply(&mut editor, layer, json!({"fillKind":"solid","color":"#ffffff"})).is_err());
        editor.undo().unwrap();
        // 填到工程上限后不再新建填充层（拒绝时不改文档、不增历史）。
        while editor.active_doc().unwrap().doc.walk().len() < photocraft_project_verify::MAX_LAYERS {
            editor.execute("layer.new.layer", Value::Null).unwrap();
        }
        assert_eq!(editor.active_doc().unwrap().doc.walk().len(), photocraft_project_verify::MAX_LAYERS);
        let before = editor.active_doc().unwrap().doc.clone();
        let steps = editor.active_doc().unwrap().history.past_len();
        let reason = editor.new_fill_layer_inner("layer.newFillLayer.solidColor", json!({"color":"#ffffff"})).unwrap_err();
        assert!(reason.to_string().contains("64"), "{reason}");
        assert!(Arc::ptr_eq(&before, &editor.active_doc().unwrap().doc));
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
    }
}
