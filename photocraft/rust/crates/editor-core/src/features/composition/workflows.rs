//! U50–U56：裁剪、尺寸、裁边、变换、填充、照片合并与画板/切片的**参数规划**。
//!
//! 本模块只做两件事：
//!
//! 1. 把 UI 语义（比例、锚点、网格、描边位置、投影方式…）编译成上游 `engine` 的命令参数；
//! 2. 在分配像素或写历史之前拒绝非法输入，并把「命令已登记但尚未开放」如实报告。
//!
//! 真正的像素与结构变更全部复用上游算法：本模块不复制另一套图像实现。执行入口是
//! [`crate::Editor::run_workflow`]，它最终仍经 `Editor::execute` 的唯一命令门，所以
//! `capability::allowed_command_ids` 里没有的 id 不可能被绕过。
//!
//! 未接通的子能力（透视裁剪、Reveal All、任意角度旋转、Warp/Puppet、内容识别填充、
//! 自动对齐/混合、Photomerge、画板/Frame/切片、画板/切片导出）在
//! [`manifest`] 里以 `allowed:false` + 具体原因呈现，界面据此禁用入口而不是渲染空按钮。

use photocraft_doc::{Document, LayerContent};
use photocraft_engine::Session;
use serde_json::{json, Value};

use crate::error::{EditorError, Result};

/// 一个可执行工作流：UI 入口、分组与它最终落到的上游命令。
#[derive(Debug, Clone, Copy)]
pub struct WorkflowSpec {
    /// 界面使用的稳定 id（与命令 id 不同：一个入口可能编译成不同命令）。
    pub id: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    /// 上游命令名；`None` 表示该能力需要宿主端口（本地文件夹导出）而不是内核命令。
    pub command: Option<&'static str>,
}

const fn workflow(id: &'static str, group: &'static str, label: &'static str, command: &'static str) -> WorkflowSpec {
    WorkflowSpec { id, group, label, command: Some(command) }
}

/// 本域全部工作流。顺序即界面顺序。
pub const WORKFLOWS: &[WorkflowSpec] = &[
    // U50 裁剪与透视裁剪
    workflow("crop", "crop", "裁剪…", "image.crop"),
    workflow("perspectiveCrop", "crop", "透视裁剪…", "image.perspectiveCrop"),
    // U51 图像/画布尺寸
    workflow("imageSize", "size", "图像尺寸…", "image.imageSize"),
    workflow("canvasSize", "size", "画布尺寸…", "image.canvasSize"),
    // U52 裁边、显示全部、任意角度旋转
    workflow("trim", "trim", "裁边…", "image.trim"),
    // 上游 `image.revealAll` 本身就是「算出画面外内容并调一次不删像素的 `image.crop`」，
    // 而 `image.crop` 已在白名单里。这里落到同一个命令，不复制算法、也不额外开放能力。
    workflow("revealAll", "trim", "显示全部", "image.crop"),
    workflow("rotateArbitrary", "trim", "任意角度旋转…", "image.rotation.arbitrary"),
    // U53 变换、变形与再次变换
    workflow("transformAgain", "transform", "再次变换", "edit.transform.again"),
    workflow("transformAgainCopy", "transform", "再次变换副本", "edit.transform.againCopy"),
    workflow("warp", "transform", "变形…", "edit.transform.warp"),
    workflow("warpGrid", "transform", "变形网格…", "edit.transform.warpGrid"),
    workflow("splitWarpCrosswise", "transform", "横向并纵向拆分变形", "edit.transform.splitWarpCrosswise"),
    workflow("splitWarpHorizontally", "transform", "横向拆分变形", "edit.transform.splitWarpHorizontally"),
    workflow("splitWarpVertically", "transform", "纵向拆分变形", "edit.transform.splitWarpVertically"),
    workflow("removeWarpSplit", "transform", "移除变形拆分", "edit.transform.removeWarpSplit"),
    workflow("perspectiveWarp", "transform", "透视变形…", "edit.perspectiveWarp"),
    workflow("puppetWarp", "transform", "操控变形…", "edit.puppetWarp"),
    // U54 填充、描边与渐隐
    workflow("fill", "fill", "填充…", "edit.fill"),
    workflow("contentAwareFill", "fill", "内容识别填充…", "edit.contentAwareFill"),
    workflow("contentAwareScale", "fill", "内容识别缩放…", "edit.contentAwareScale"),
    workflow("stroke", "fill", "描边…", "edit.stroke"),
    workflow("fade", "fill", "渐隐…", "edit.fade"),
    // U55 内容识别对齐/混合与照片合并
    workflow("autoAlign", "photo", "自动对齐图层…", "edit.autoAlignLayers"),
    workflow("autoBlend", "photo", "自动混合图层…", "edit.autoBlendLayers"),
    workflow("photomerge", "photo", "Photomerge…", "file.automate.photomerge"),
    workflow("mergeToHdr", "photo", "合并到 HDR…", "file.automate.mergeToHdrPro"),
    workflow("cropAndStraighten", "photo", "裁剪并拉直照片", "file.automate.cropAndStraightenPhotos"),
    // U56 画板、框架与切片
    workflow("newArtboard", "structure", "新建画板…", "layer.new.artboard"),
    workflow("artboardFromLayers", "structure", "从图层新建画板…", "layer.new.artboardFromLayers"),
    workflow("setArtboard", "structure", "编辑画板…", "layer.artboard.set"),
    workflow("newFrame", "structure", "新建框架…", "layer.new.frame"),
    workflow("frameFromLayers", "structure", "从图层新建框架…", "layer.new.frameFromLayers"),
    workflow("newSlice", "structure", "新建切片…", "slice.new"),
    workflow("slicesFromGuides", "structure", "从参考线建立切片", "slice.fromGuides"),
    workflow("layerSlice", "structure", "从图层新建切片", "layer.newLayerBasedSlice"),
    // `slice.list` 只读且不写内容，但仍要经内核读取切片表；它不是宿主交付。
    workflow("listSlices", "structure", "列出切片", "slice.list"),
    // 宿主交付：内核能编码这些结果，但浏览器无权写任意路径/读任意文件夹。
    host_delivery("artboardsToFiles", "structure", "导出画板到文件…"),
    host_delivery("artboardsToPdf", "structure", "导出画板到 PDF…"),
    host_delivery("slicesToFiles", "structure", "导出切片…"),
    host_delivery("photomergeFromFolder", "photo", "Photomerge（从文件夹）…"),
    host_delivery("stackStatistics", "photo", "堆栈统计…"),
];

/// 需要宿主本地文件夹端口的入口：`command` 为 `None`，界面据此禁用并显示原因。
///
/// 这些能力不伪造命令 id：内核没有「写任意路径」的入口，硬编码一个 id 只会让界面拿到
/// 无法解释的能力门错误。
const fn host_delivery(id: &'static str, group: &'static str, label: &'static str) -> WorkflowSpec {
    WorkflowSpec { id, group, label, command: None }
}

/// 工作流清单：`[{id,group,label,command,allowed,reason}]`。
///
/// `allowed` 严格来自唯一命令门 + 宿主端口判定；`reason` 是给用户看的具体原因。
pub fn manifest() -> Value {
    Value::Array(
        WORKFLOWS
            .iter()
            .map(|entry| {
                let (allowed, reason) = availability(entry);
                json!({
                    "id": entry.id,
                    "group": entry.group,
                    "label": entry.label,
                    "command": entry.command,
                    "allowed": allowed,
                    "reason": reason,
                })
            })
            .collect(),
    )
}

fn availability(entry: &WorkflowSpec) -> (bool, Option<String>) {
    match entry.command {
        None => (false, Some("该能力需要宿主本地文件夹端口，内核不直接写盘".into())),
        Some(command) if crate::capability::command_allowed(command) => (true, None),
        Some(command) => (false, crate::capability::disabled_reason(command)),
    }
}

/// `prepare` 的结果：要么执行一条上游命令，要么**什么都不用做**。
///
/// 后者是真实存在的（例如「显示全部」时所有内容都已在画布内）：上游 `image.revealAll` 对此
/// 返回 `{changed:false}` 且**不写历史**。如果没有这条分支，等价实现会退化成「裁剪到同一矩形」，
/// 白白多出一条 `Crop` 历史步骤——那是我们引入的缺陷，不是上游行为。
#[derive(Debug)]
pub enum Prepared {
    Command(&'static str, Value),
    Unchanged(Value),
}

/// 把工作流参数编译成上游命令 + 参数；不修改任何文档。
///
/// 拒绝顺序刻意与「先算后写」一致：格式 → 范围 → 预算 → 能力门。这样非法输入与未开放能力
/// 得到不同错误码，界面可以分别提示「参数不对」和「尚未接通」。
pub fn prepare(session: &Session, id: &str, params: Value) -> Result<Prepared> {
    let document = session.active().ok_or(EditorError::NoDocument)?;
    let spec = WORKFLOWS
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| unknown(id))?;
    let command = spec
        .command
        .ok_or_else(|| error(id, "该能力需要宿主本地文件夹端口，内核不直接写盘"))?;
    let compiled = compile(&document.doc, session, id, &params)?;
    // 能力门：参数先编译（非法输入的提示优先），再由唯一白名单决定能否执行。
    if !crate::capability::command_allowed(command) {
        return Err(EditorError::CapabilityDisabled(command.into()));
    }
    // 「显示全部」已经是全部内容时与上游同样返回 `changed:false`，不提交空步骤。
    if id == "revealAll" && photocraft_engine::extra_cmds::reveal_all_bounds(&document.doc) == document.doc.bounds() {
        return Ok(Prepared::Unchanged(json!({"changed": false})));
    }
    Ok(Prepared::Command(command, compiled))
}

fn unknown(id: &str) -> EditorError {
    error(id, "不是已登记的构图工作流")
}

fn error(id: &str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

fn bad(id: &str, message: impl std::fmt::Display) -> EditorError {
    error(id, message)
}

fn number(params: &Value, key: &str, range: (f64, f64), id: &str) -> Result<f64> {
    params
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= range.0 && *value <= range.1)
        .ok_or_else(|| bad(id, format!("{key} 必须在 {}–{} 之间", range.0, range.1)))
}

fn optional_number(params: &Value, key: &str, range: (f64, f64), id: &str) -> Result<Option<f64>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => number(params, key, range, id).map(Some),
    }
}

fn boolean(params: &Value, key: &str, id: &str) -> Result<Option<bool>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(bad(id, format!("{key} 必须是 true 或 false"))),
    }
}

fn choice(params: &Value, key: &str, options: &[&str], id: &str) -> Result<Option<String>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let name = value
                .as_str()
                .ok_or_else(|| bad(id, format!("{key} 必须是字符串")))?;
            if !options.contains(&name) {
                return Err(bad(id, format!("{key} 必须是 {} 之一", options.join("|"))));
            }
            Ok(Some(name.to_string()))
        }
    }
}

/// 单边与累计像素预算（分配前拒绝，避免半成品）。
fn check_canvas(width: u32, height: u32, id: &str, message: &str) -> Result<()> {
    let max_side = photocraft_project_verify::limits::MAX_CANVAS_SIDE;
    if width == 0 || height == 0 || width > max_side || height > max_side {
        return Err(bad(id, format!("{width} × {height} 超过单边 {max_side} 像素上限")));
    }
    if u64::from(width).saturating_mul(u64::from(height)) > photocraft_project_verify::limits::MAX_CANVAS_PIXELS {
        return Err(bad(id, message));
    }
    Ok(())
}

/// 颜色：`#rrggbb` 或 `[r,g,b(,a)]`（0–255 整数或 0–1 浮点，与内核一致）。
fn check_color(value: &Value, id: &str, key: &str) -> Result<()> {
    match value {
        Value::String(text) if text.starts_with('#') => {
            let hex = text.trim_start_matches('#');
            if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                Ok(())
            } else {
                Err(bad(id, format!("{key} 必须是 #rrggbb")))
            }
        }
        Value::Array(values) if (3..=4).contains(&values.len()) => {
            if values.iter().all(|component| component.as_f64().is_some_and(|v| v.is_finite() && (0.0..=255.0).contains(&v))) {
                Ok(())
            } else {
                Err(bad(id, format!("{key} 的分量必须是 0–255 的有限数值")))
            }
        }
        _ => Err(bad(id, format!("{key} 必须是 #rrggbb 或 [r,g,b(,a)]"))),
    }
}

/// 变形族的矩形：上游 `edit.transform.*` 的 `rect` 是 **`[x0,y0,x1,y1]`**（两个角），
/// 不是 `[x,y,w,h]`。两套约定并存，所以这里单独解析，绝不与 [`rect`] 混用。
fn transform_rect(params: &Value, id: &str) -> Result<Option<[f64; 4]>> {
    let Some(bounds) = params.get("rect") else {
        return Ok(None);
    };
    let values = bounds
        .as_array()
        .filter(|values| values.len() == 4)
        .ok_or_else(|| bad(id, "rect 必须是 [x0,y0,x1,y1] 四个数值"))?;
    let numbers: Option<Vec<f64>> = values.iter().map(Value::as_f64).collect();
    let Some([x0, y0, x1, y1]) = numbers.map(|v| [v[0], v[1], v[2], v[3]]) else {
        return Err(bad(id, "rect 的角坐标必须是有限数值"));
    };
    if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
        return Err(bad(id, "rect 的角坐标必须是有限数值"));
    }
    if x1 <= x0 || y1 <= y0 {
        return Err(bad(id, "rect 必须是 x1>x0、y1>y0 的框"));
    }
    Ok(Some([x0, y0, x1, y1]))
}

/// 一个矩形参数：`rect:[x,y,w,h]` 或 `x`/`y`/`width`/`height`。
fn rect(params: &Value, id: &str) -> Result<[i64; 4]> {
    if let Some(values) = params.get("rect").and_then(Value::as_array) {
        let numbers: Option<Vec<f64>> = values.iter().map(Value::as_f64).collect();
        let numbers = numbers.filter(|values| values.len() == 4 && values.iter().all(|v| v.is_finite()));
        let Some([x, y, w, h]) = numbers.map(|v| [v[0], v[1], v[2], v[3]]) else {
            return Err(bad(id, "rect 必须是 [x,y,width,height] 四个有限数值"));
        };
        if w <= 0.0 || h <= 0.0 {
            return Err(bad(id, "rect 的宽高必须为正"));
        }
        return Ok([x.round() as i64, y.round() as i64, w.round() as i64, h.round() as i64]);
    }
    let x = number(params, "x", (-1e6, 1e6), id)?.round() as i64;
    let y = number(params, "y", (-1e6, 1e6), id)?.round() as i64;
    let w = number(params, "width", (1.0, 1e6), id)?.round() as i64;
    let h = number(params, "height", (1.0, 1e6), id)?.round() as i64;
    Ok([x, y, w, h])
}

fn compile(document: &Document, session: &Session, id: &str, params: &Value) -> Result<Value> {
    match id {
        // ---------------------------------------------------------------- U50
        "crop" => crop(document, id, params),
        "perspectiveCrop" => perspective_crop(document, id, params),
        // ---------------------------------------------------------------- U51
        "imageSize" => image_size(document, id, params),
        "canvasSize" => canvas_size(document, id, params),
        // ---------------------------------------------------------------- U52
        "trim" => trim(id, params),
        "revealAll" => reveal_all(document, id),
        "rotateArbitrary" => rotate_arbitrary(document, id, params),
        // ---------------------------------------------------------------- U53
        "transformAgain" | "transformAgainCopy" => transform_again(session, id),
        "warp" => warp(document, id, params),
        "warpGrid" => warp_grid(document, id, params),
        "splitWarpCrosswise" | "splitWarpHorizontally" | "splitWarpVertically" | "removeWarpSplit" => {
            warp_split(document, id, params)
        }
        "perspectiveWarp" => perspective_warp(document, id, params),
        "puppetWarp" => puppet_warp(document, id, params),
        // ---------------------------------------------------------------- U54
        "fill" => fill(document, id, params),
        "contentAwareFill" => content_aware_fill(document, id, params),
        "contentAwareScale" => content_aware_scale(document, id, params),
        "stroke" => stroke(document, id, params),
        "fade" => fade(session, id, params),
        // ---------------------------------------------------------------- U55
        "autoAlign" => auto_align(document, id, params),
        "autoBlend" => auto_blend(document, id, params),
        "photomerge" => photomerge(session, id, params),
        "mergeToHdr" => merge_to_hdr(session, id, params),
        "cropAndStraighten" => Ok(json!({})),
        // ---------------------------------------------------------------- U56
        "newArtboard" => new_artboard(document, id, params),
        "artboardFromLayers" => artboard_from_layers(id, params),
        "setArtboard" => set_artboard(id, params),
        "newFrame" => new_frame(document, id, params),
        "frameFromLayers" => frame_from_layers(session, id, params),
        "newSlice" => new_slice(document, id, params),
        "slicesFromGuides" => slices_from_guides(document, id, params),
        "layerSlice" => layer_slice(id, params),
        "listSlices" => Ok(json!({})),
        other => Err(unknown(other)),
    }
}

/// 画板/切片导出计划：只产出「名称 + 文档矩形」，渲染与写盘由调用方按自己的通道完成。
///
/// 这样浏览器侧不需要任意路径写权限（scope 的明确边界），却仍满足 U56 的「导出范围和命名
/// 正确」：范围来自内核解析后的切片表 / 画板矩形，命名沿用内核给的 `name`，重名与非法字符
/// 在这里一次性去重，调用方不必各自实现一遍。
///
/// `kind` 只能是 `slices` 或 `artboards`。返回 `[{name, rect:[x,y,w,h], layer?}]`。
pub fn export_plan(document: &Document, kind: &str, params: &Value) -> Result<Value> {
    let doc_name = sanitize_file_stem(document.name.as_str());
    let entries: Vec<Value> = match kind {
        "slices" => photocraft_doc::slices::resolve(document)
            .into_iter()
            .map(|slice| {
                json!({
                    // 内核已给出最终名称（含 `_NN` 自动编号），导出不应再拼一遍前缀。
                    "name": slice.name,
                    "rect": [slice.rect.x0, slice.rect.y0, slice.rect.width(), slice.rect.height()],
                    "kind": format!("{:?}", slice.kind).to_lowercase(),
                })
            })
            .collect(),
        "artboards" => document
            .layers
            .iter()
            .filter_map(|layer| match &layer.content {
                LayerContent::Group(group) => group.artboard.as_ref().map(|artboard| (layer, artboard)),
                _ => None,
            })
            .map(|(layer, artboard)| {
                let rect = artboard.rect;
                json!({
                    "name": layer.name,
                    "rect": [rect.x0, rect.y0, rect.width(), rect.height()],
                    "layer": layer.id.0,
                })
            })
            .collect(),
        other => return Err(bad(other, "导出计划只支持 slices 与 artboards")),
    };
    if entries.is_empty() {
        return Err(bad(kind, match kind {
            "slices" => "文档里没有切片可导出",
            _ => "文档里没有画板可导出",
        }));
    }
    let prefix = params
        .get("prefix")
        .and_then(Value::as_str)
        .map(sanitize_file_stem)
        .filter(|prefix| !prefix.is_empty())
        .unwrap_or(doc_name);
    // 切片名由内核给成最终名（自动编号已在里面），再加前缀会变成 `doc_doc_01`；
    // 画板只有图层名，需要文档名前缀把同一次导出成组。
    let plan = name_exports(&entries, &prefix, kind)?;
    Ok(json!({ "files": plan }))
}

/// 把内核给的名字转成可用文件名：去掉路径分隔与控制字符，保留中文与空格。
fn sanitize_file_stem(name: &str) -> String {
    name.chars()
        .filter(|ch| !matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !ch.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// 去重且保持顺序：同名按 `_2`、`_3` 递增，避免覆盖已在目标位置的既有文件。
fn name_exports(entries: &[Value], prefix: &str, kind: &str) -> Result<Vec<Value>> {
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let raw = entry
            .get("name")
            .and_then(Value::as_str)
            .map(sanitize_file_stem)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("{kind}-{}", index + 1));
        // 切片名已是最终名，直接用；画板名加文档前缀成组。
        let base = if kind == "slices" { raw.clone() } else { format!("{prefix}_{raw}") };
        let mut stem = base.clone();
        let mut suffix = 1;
        while !used.insert(stem.clone()) {
            suffix += 1;
            stem = format!("{base}_{suffix}");
        }
        out.push(json!({
            "fileName": format!("{stem}.png"),
            "name": raw,
            "rect": entry["rect"].clone(),
            "kind": entry["kind"].clone(),
            "layer": entry["layer"].clone(),
        }));
    }
    Ok(out)
}

// ---------------------------------------------------------------- U50

/// 裁剪：`x`/`y`/`width`/`height` 必填（可超出画布以扩展），可选拉直角度、目标尺寸、
/// 分辨率、重采样与「删除裁剪像素」。保留模式只在上游支持时才允许（裁剪像素不被剪切）。
fn crop(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let frame = rect(params, id)?;
    let (x, y, w, h) = (frame[0], frame[1], frame[2], frame[3]);
    let max_side = i64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE);
    if w > max_side || h > max_side {
        return Err(bad(id, format!("裁剪结果超过单边 {max_side} 像素上限")));
    }
    check_canvas(w as u32, h as u32, id, "裁剪后像素超过工程上限")?;
    let mut out = json!({"x": x, "y": y, "width": w, "height": h});
    if let Some(angle) = optional_number(params, "angle", (-3600.0, 3600.0), id)? {
        // 与上游一致：模 360 为 0 时不进入旋转路径。
        let normalized = angle.rem_euclid(360.0);
        if (normalized - 360.0).abs() > 1e-9 && normalized.abs() > 1e-9 {
            let rotated = photocraft_engine::mode_cmds::rotated_size(document.size, angle);
            check_canvas(rotated.width, rotated.height, id, "拉直后的画布像素超过工程上限")?;
            out["angle"] = json!(normalized);
        }
    }
    let target = match (
        optional_number(params, "targetWidth", (1.0, f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE)), id)?,
        optional_number(params, "targetHeight", (1.0, f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE)), id)?,
    ) {
        (Some(tw), Some(th)) => {
            check_canvas(tw.round() as u32, th.round() as u32, id, "裁剪目标像素超过工程上限")?;
            out["targetWidth"] = json!(tw.round() as u32);
            out["targetHeight"] = json!(th.round() as u32);
            true
        }
        (None, None) => false,
        _ => return Err(bad(id, "targetWidth 与 targetHeight 必须同时给出")),
    };
    if let Some(resolution) = optional_number(params, "resolution", (1.0, 10_000.0), id)? {
        out["resolution"] = json!(resolution);
    }
    if let Some(resample) = choice(
        params,
        "resample",
        &[
            "automatic",
            "preserveDetails",
            "bicubicSmoother",
            "bicubicSharper",
            "bicubicAutomatic",
            "bicubic",
            "nearest",
            "bilinear",
            "lanczos",
            "none",
        ],
        id,
    )? {
        if resample == "none" && target {
            return Err(bad(id, "给出目标尺寸时必须重采样，resample 不能是 none"));
        }
        out["resample"] = json!(resample);
    } else if target {
        out["resample"] = json!("bicubic");
    }
    if let Some(delete) = boolean(params, "deleteCroppedPixels", id)? {
        out["deleteCroppedPixels"] = json!(delete);
    }
    if let Some(aware) = boolean(params, "contentAware", id)? {
        out["contentAware"] = json!(aware);
    }
    // 拉直裁剪必须显式给出画布框（上游拒绝缺框的 angle）。
    if out.get("angle").is_some() && params.get("rect").is_none()
        && ["x", "y", "width", "height"].iter().any(|key| params.get(*key).is_none())
    {
        return Err(bad(id, "拉直裁剪需要显式的 x、y、width、height"));
    }
    Ok(out)
}

/// 透视裁剪：四个角（左上、右上、右下、左下）必须构成凸四边形，输出尺寸受预算约束。
///
/// 凸性与尺寸直接复用上游 `photocraft_algo::transform`，避免本模块与内核出现两套判据。
fn perspective_crop(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let corners = params
        .get("corners")
        .and_then(Value::as_array)
        .ok_or_else(|| bad(id, "corners 必须是四个 [x,y] 点"))?;
    if corners.len() != 4 {
        return Err(bad(id, "corners 必须是四个 [x,y] 点"));
    }
    let mut quad = [[0.0f64; 2]; 4];
    for (index, corner) in corners.iter().enumerate() {
        let pair = corner
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| bad(id, "每个角必须是 [x,y]"))?;
        let numbers: Option<Vec<f64>> = pair.iter().map(Value::as_f64).collect();
        let Some(values) = numbers.filter(|values| values.iter().all(|value| value.is_finite())) else {
            return Err(bad(id, "角坐标必须是有限数值"));
        };
        quad[index] = [values[0], values[1]];
    }
    if !photocraft_algo::transform::convex_quad(&quad) {
        return Err(bad(
            id,
            "四个角必须构成顺时针凸四边形（左上、右上、右下、左下），面积至少 1 像素",
        ));
    }
    let (quad_width, quad_height) = photocraft_algo::transform::quad_size(&quad);
    let max = f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE);
    let (width, height) = match (
        optional_number(params, "width", (1.0, max), id)?,
        optional_number(params, "height", (1.0, max), id)?,
    ) {
        (Some(width), Some(height)) => (width.round() as u32, height.round() as u32),
        (Some(width), None) => {
            let width = width.round();
            (width as u32, (width * quad_height / quad_width).round().max(1.0) as u32)
        }
        (None, Some(height)) => {
            let height = height.round();
            ((height * quad_width / quad_height).round().max(1.0) as u32, height as u32)
        }
        (None, None) => (
            quad_width.round().max(1.0) as u32,
            quad_height.round().max(1.0) as u32,
        ),
    };
    check_canvas(width, height, id, "透视裁剪输出像素超过工程上限")?;
    let mut out = json!({
        "corners": corners,
        "width": width,
        "height": height,
    });
    if let Some(resolution) = optional_number(params, "resolution", (1.0, 10_000.0), id)? {
        out["resolution"] = json!(resolution);
    }
    if let Some(interpolation) = choice(params, "interpolation", &["bicubic", "bilinear", "nearest"], id)? {
        out["interpolation"] = json!(interpolation);
    }
    // 文档里存在文字/形状/填充/智能对象时上游会先栅格化；这里提前确认不会超出层数预算。
    let rasterized = document
        .walk()
        .iter()
        .filter(|(_, _, layer)| {
            matches!(
                layer.content,
                photocraft_doc::LayerContent::Text(_)
                    | photocraft_doc::LayerContent::Shape(_)
                    | photocraft_doc::LayerContent::Fill(_)
                    | photocraft_doc::LayerContent::Smart(_)
            )
        })
        .count();
    if rasterized > photocraft_project_verify::limits::MAX_ENTRIES {
        return Err(bad(id, "需要栅格化的图层超过结构条目上限"));
    }
    Ok(out)
}

// ---------------------------------------------------------------- U51

fn image_size(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let max = f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE);
    let (ow, oh) = (f64::from(document.size.width), f64::from(document.size.height));
    let mut width = optional_number(params, "width", (1.0, max), id)?;
    let mut height = optional_number(params, "height", (1.0, max), id)?;
    if let Some(percent) = optional_number(params, "percent", (0.01, 1600.0), id)? {
        width = width.or(Some(ow * percent / 100.0));
        height = height.or(Some(oh * percent / 100.0));
    }
    let resolution = optional_number(params, "resolution", (1.0, 10_000.0), id)?;
    let keep_print = boolean(params, "keepPrintSize", id)?.unwrap_or(false);
    if keep_print && width.is_none() && height.is_none() {
        let dpi = resolution.ok_or_else(|| bad(id, "keepPrintSize 需要同时给出 resolution"))?;
        let old = f64::from(document.resolution_dpi).max(1.0);
        width = Some(ow * dpi / old);
        height = Some(oh * dpi / old);
    }
    let resample = choice(
        params,
        "resample",
        &[
            "automatic",
            "preserveDetails",
            "bicubicSmoother",
            "bicubicSharper",
            "bicubicAutomatic",
            "bicubic",
            "nearest",
            "bilinear",
            "lanczos",
            "none",
        ],
        id,
    )?;
    let (nw, nh) = match (width, height) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => (w, w * oh / ow.max(1.0)),
        (None, Some(h)) => (h * ow / oh.max(1.0), h),
        (None, None) => (ow, oh),
    };
    let (nw, nh) = (nw.round().max(1.0) as u32, nh.round().max(1.0) as u32);
    let resampling = resample.as_deref() != Some("none");
    if resampling && (nw, nh) != (document.size.width, document.size.height) {
        check_canvas(nw, nh, id, "图像尺寸像素超过工程上限")?;
    }
    let mut out = json!({});
    if width.is_some() {
        out["width"] = json!(nw);
    }
    if height.is_some() {
        out["height"] = json!(nh);
    }
    // 只改 DPI：保留原像素，只写元数据。
    if let Some(resolution) = resolution {
        out["resolution"] = json!(resolution);
    }
    if let Some(resample) = resample {
        out["resample"] = json!(resample);
    }
    if keep_print {
        out["keepPrintSize"] = json!(true);
    }
    Ok(out)
}

fn canvas_size(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let max = f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE);
    let relative = boolean(params, "relative", id)?.unwrap_or(false);
    let (ow, oh) = (f64::from(document.size.width), f64::from(document.size.height));
    let width = match params.get("width") {
        None | Some(Value::Null) => if relative { 0.0 } else { ow },
        Some(_) => number(params, "width", (-max, max), id)?,
    };
    let height = match params.get("height") {
        None | Some(Value::Null) => if relative { 0.0 } else { oh },
        Some(_) => number(params, "height", (-max, max), id)?,
    };
    // 注意：上游 `image.canvasSize` **自己**做 `relative ? ow + w : w`。这里只能把增量
    // 原样传下去；预算按加过之后的尺寸算，避免「小增量 + 超大画布」绕过上限。
    let (nw, nh) = if relative { (ow + width, oh + height) } else { (width, height) };
    if nw < 1.0 || nh < 1.0 {
        return Err(bad(id, "画布尺寸至少为 1 × 1 像素"));
    }
    check_canvas(nw.round() as u32, nh.round() as u32, id, "画布尺寸像素超过工程上限")?;
    let anchor = choice(
        params,
        "anchor",
        &[
            "topLeft",
            "top",
            "topRight",
            "left",
            "center",
            "right",
            "bottomLeft",
            "bottom",
            "bottomRight",
        ],
        id,
    )?
    .unwrap_or_else(|| "center".into());
    let extension = match params.get("extensionColor") {
        None | Some(Value::Null) => "background".to_string(),
        Some(value) => {
            let name = value.as_str().ok_or_else(|| bad(id, "extensionColor 必须是字符串"))?;
            let named = ["background", "foreground", "white", "black", "transparent"];
            let hex = name.strip_prefix('#').is_some_and(|hex| {
                hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())
            });
            if !named.contains(&name) && !hex {
                return Err(bad(id, "extensionColor 必须是 background|foreground|white|black|transparent|#rrggbb"));
            }
            name.to_string()
        }
    };
    Ok(json!({
        // 相对模式下传的是**增减量**（可为负），不是算好的画布尺寸。
        "width": width.round() as i64,
        "height": height.round() as i64,
        "relative": relative,
        "anchor": anchor,
        "extensionColor": extension,
    }))
}

// ---------------------------------------------------------------- U52

fn trim(id: &str, params: &Value) -> Result<Value> {
    let based = choice(params, "basedOn", &["transparent", "topLeft", "bottomRight"], id)?
        .unwrap_or_else(|| "transparent".into());
    let mut out = json!({"basedOn": based});
    for side in ["top", "bottom", "left", "right"] {
        if let Some(value) = boolean(params, side, id)? {
            out[side] = json!(value);
        }
    }
    Ok(out)
}

/// 显示全部：把画布扩到「所有图层像素 + 原画布」的并集，不删任何像素。
///
/// 上游 `image.revealAll` 的实现就是算出同一并集后调一次
/// `image.crop{deleteCroppedPixels:false}`。这里直接落到**已在白名单**的 `image.crop`，
/// 因此不需要额外开放能力，也不复制上游算法（并集仍取自上游
/// `extra_cmds::reveal_all_bounds`）。与上游的逐字节等价性由
/// `reveal_all_matches_upstream_pixel_for_pixel` 守着。
///
/// 「已经是全部内容」由 [`prepare`] 提前判定为 `Prepared::Unchanged`，与上游 `changed:false`
/// 一样**不写历史**；否则退化成「裁剪到同一矩形」会多出一条 `Crop` 步骤。
/// 有变更时本入口返回的是上游 `image.crop` 的结果对象（含宽高），是上游 `{changed:true}`
/// 的超集，界面不依赖两者差异。
fn reveal_all(document: &Document, id: &str) -> Result<Value> {
    let all = photocraft_engine::extra_cmds::reveal_all_bounds(document);
    // 已经是全部内容：不改画布，交给上游的「无变化不增历史」判据。
    let (x, y, w, h) = (all.x0, all.y0, all.width(), all.height());
    if w < 1 || h < 1 {
        return Err(bad(id, "没有可显示的画布外内容"));
    }
    check_canvas(w as u32, h as u32, id, "显示全部后的画布像素超过工程上限")?;
    Ok(json!({
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "deleteCroppedPixels": false,
    }))
}

fn rotate_arbitrary(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let angle = number(params, "angle", (-359.99, 359.99), id)?;
    let direction = choice(params, "direction", &["cw", "ccw"], id)?.unwrap_or_else(|| "cw".into());
    let signed = if direction == "ccw" { -angle } else { angle };
    if signed.rem_euclid(360.0).abs() > 1e-9 {
        let rotated = photocraft_engine::mode_cmds::rotated_size(document.size, signed);
        check_canvas(rotated.width, rotated.height, id, "旋转后的画布像素超过工程上限")?;
        // 旋转后画布可能超出单边上限（check_canvas 已含单边）。
    }
    let mut out = json!({"angle": angle, "direction": direction});
    if let Some(interpolation) = choice(params, "interpolation", &["bicubic", "bilinear", "nearest"], id)? {
        out["interpolation"] = json!(interpolation);
    }
    Ok(out)
}

// ---------------------------------------------------------------- U53

/// 再次变换：必须有可重复的上一次变换；否则给出明确原因而不是让内核报通用错误。
///
/// 上游 `edit.transform.again` 的做法是「从 `journal` 里最后一条 `edit.transform` 推导参数，
/// 再执行 `edit.transform`」。这里只做**前置判定**，条件与上游 `transform_again_params` 的三分支
/// 一致：最后一条变换要么带 `rect`+`quad`（按当前图层边界重算），要么带 `matrix`；两者都没有就
/// 不可重复（纯 `{dx,dy}` 平移属于这一类）。真正的参数推导不在本域复制，理由见该入口的阻塞说明。
/// 再次变换 / 再次变换副本：参数为空，重复逻辑完全由上游 `edit.transform.again*` 执行。
///
/// 上游把「上一次变换」保存在引擎自己的会话里（`transform_again_params` 是其私有实现），
/// 这份状态无法从文档重建，因此本域**不**复制它的判定与参数：命令已开放，直接交给上游即可。
/// 本地重算只会随上游演进悄悄漂移，而且 `againCopy` 还要求 `history.purge_last` 与改标签，
/// 这些都属于上游命令的职责。
fn transform_again(_session: &Session, _id: &str) -> Result<Value> {
    Ok(json!({}))
}

/// 变形：预设样式或自定义网格；网格必须是 (3c+1)×(3r+1) 个控制点。
fn warp(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    if let Some(layer) = params.get("layer").and_then(Value::as_u64) {
        out["layer"] = json!(layer);
    }
    if let Some(bounds) = transform_rect(params, id)? {
        out["rect"] = json!(bounds);
    }
    if let Some(mesh) = params.get("mesh") {
        out["mesh"] = check_mesh(mesh, id)?;
    } else if let Some(style) = choice(
        params,
        "style",
        &[
            "custom",
            "none",
            "arc",
            "arcLower",
            "arcUpper",
            "arch",
            "bulge",
            "shellLower",
            "shellUpper",
            "flag",
            "wave",
            "fish",
            "rise",
            "fisheye",
            "inflate",
            "squeeze",
            "twist",
        ],
        id,
    )? {
        if style == "custom" {
            return Err(bad(id, "自定义样式需要 mesh"));
        }
        out["style"] = json!(style);
    } else {
        return Err(bad(id, "变形需要 style 或 mesh"));
    }
    for key in ["bend", "hDistort", "vDistort"] {
        if let Some(value) = optional_number(params, key, (-100.0, 100.0), id)? {
            out[key] = json!(value);
        }
    }
    if let Some(vertical) = boolean(params, "vertical", id)? {
        out["vertical"] = json!(vertical);
    }
    if let Some(interpolation) = choice(params, "interpolation", &["bicubic", "bilinear", "nearest"], id)? {
        out["interpolation"] = json!(interpolation);
    }
    let _ = document;
    Ok(out)
}

/// 网格合法性：`us`/`vs` 是**块边界**（0…1 严格递增，可任意块数），控制点必须是
/// `(3·块数+1) × (3·块数+1)` 的行主序点——与内核 `BezierMesh::is_valid` 同判据。
fn check_mesh(mesh: &Value, id: &str) -> Result<Value> {
    let us = mesh
        .get("us")
        .and_then(Value::as_array)
        .ok_or_else(|| bad(id, "mesh.us 缺失"))?;
    let vs = mesh
        .get("vs")
        .and_then(Value::as_array)
        .ok_or_else(|| bad(id, "mesh.vs 缺失"))?;
    let axis = |values: &[Value], name: &str| -> Result<Vec<f64>> {
        let numbers: Option<Vec<f64>> = values.iter().map(Value::as_f64).collect();
        let Some(numbers) = numbers.filter(|values| values.iter().all(|value| value.is_finite())) else {
            return Err(bad(id, format!("mesh.{name} 必须是有限数值")));
        };
        // 块数 = 边界数 - 1；上游 `BezierMesh::identity` 把块数夹到 1..=64。
        if numbers.len() < 2 || numbers.len() > 65 {
            return Err(bad(id, format!("mesh.{name} 必须有 2–65 个块边界（1–64 块）")));
        }
        if numbers[0] != 0.0 || numbers[numbers.len() - 1] != 1.0 {
            return Err(bad(id, format!("mesh.{name} 的块边界必须从 0 到 1")));
        }
        if numbers.iter().any(|value| !(0.0..=1.0).contains(value)) {
            return Err(bad(id, format!("mesh.{name} 必须在 0–1 之间")));
        }
        if numbers.windows(2).any(|pair| pair[1] <= pair[0]) {
            return Err(bad(id, format!("mesh.{name} 必须严格递增")));
        }
        Ok(numbers)
    };
    let us = axis(us, "us")?;
    let vs = axis(vs, "vs")?;
    let points = mesh
        .get("points")
        .and_then(Value::as_array)
        .ok_or_else(|| bad(id, "mesh.points 缺失"))?;
    let expected = (3 * (us.len() - 1) + 1) * (3 * (vs.len() - 1) + 1);
    if points.len() != expected {
        return Err(bad(
            id,
            format!("mesh.points 的数量必须是 (3×块数+1) 之积 = {expected}"),
        ));
    }
    for point in points {
        let pair = point
            .as_array()
            .filter(|pair| pair.len() >= 2)
            .ok_or_else(|| bad(id, "每个控制点必须是 [x,y]"))?;
        if !pair[0].as_f64().is_some_and(f64::is_finite) || !pair[1].as_f64().is_some_and(f64::is_finite) {
            return Err(bad(id, "控制点坐标必须是有限数值"));
        }
    }
    Ok(mesh.clone())
}

/// 变形网格：`size` 是每边的方形网格数（1..=64），或 `"default"` 表示单块。
fn warp_grid(_document: &Document, id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    // 上游的 `warp` 参数是完整的 `Warp` 对象（`style`/`bounds` 都是必填）；只给网格时走
    // 顶层 `mesh`，让 `warp_from_params` 以 `custom` 样式就地拼出 `Warp`。
    let mesh = params
        .get("warp")
        .and_then(|warp| warp.get("mesh"))
        .or_else(|| params.get("mesh"));
    if mesh.is_none() {
        // 与上游同一个前置条件：没有内联 warp 时，内核会去读活动智能对象上已存的 warp；没有就报
        // 「pass the warp being edited」。`prepare` 拿不到会话的活动图层，因此这里明确要求界面
        // 把正在编辑的 warp 一并传进来，而不是让用户看到一句面向内核作者的参数错误。
        return Err(bad(id, "变形网格需要正在编辑的变形（请传 warp/mesh），或选中带变形的智能对象"));
    }
    if let Some(mesh) = mesh {
        out["mesh"] = check_mesh(mesh, id)?;
        if let Some(bounds) = transform_rect(params, id)? {
            out["rect"] = json!(bounds);
        }
    }
    if let Some(size) = grid_size_param(params, id)? {
        out["size"] = size;
    }
    Ok(out)
}

/// 解析 `warpGrid` 的网格边数：省略表示沿用上游默认，数字必须是 1–64 的整数。
fn grid_size_param(params: &Value, id: &str) -> Result<Option<Value>> {
    match params.get("size") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text == "default" => Ok(Some(json!("default"))),
        Some(Value::Number(value)) => {
            match value.as_f64().filter(|value| value.fract() == 0.0) {
                Some(size) if (1.0..=64.0).contains(&size) => Ok(Some(json!(size as u32))),
                _ => Err(bad(id, "size 必须是 1–64 的整数或 default")),
            }
        }
        Some(_) => Err(bad(id, "size 必须是 1–64 的整数或 default")),
    }
}

fn warp_split(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    if let Some(warp) = params.get("warp") {
        out["warp"] = warp.clone();
    }
    // 与 `warpGrid` 同一前置条件：没有内联 warp 时上游会去读活动智能对象上已存的变形。
    if params.get("warp").is_none() && params.get("mesh").is_none() && params.get("style").is_none() {
        return Err(bad(id, "拆分变形需要正在编辑的变形（请传 warp），或选中带变形的智能对象"));
    }
    if let Some(bounds) = transform_rect(params, id)? {
        out["rect"] = json!(bounds);
    }
    // `at` 是**文档坐标**：上游 `split_warp` 拿它去 `param_at` 反解块内参数。这里只校验形状，
    // 不做任何归一化——归一化会把它变成「块内参数」，用户双击的位置就对不上了。
    if let Some(at) = params.get("at") {
        let pair = at
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| bad(id, "at 必须是 [x,y]"))?;
        if !pair[0].as_f64().is_some_and(f64::is_finite) || !pair[1].as_f64().is_some_and(f64::is_finite) {
            return Err(bad(id, "at 必须是有限坐标"));
        }
        out["at"] = at.clone();
    }
    let _ = document;
    Ok(out)
}

fn perspective_warp(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    // 上游只接受 `planes`（每个 `{src,dst}` 各四个角）。界面上的「拖动一个四角框」是最常见的
    // 单平面用法，因此把 `quad` + 可选 `rect`（源框）编译成一个平面，而不是另造一套参数。
    let planes = match params.get("planes") {
        Some(Value::Array(planes)) if !planes.is_empty() => {
            for plane in planes {
                let (src, dst) = (
                    plane.get("src").ok_or_else(|| bad(id, "每个平面需要 src 四个角"))?,
                    plane.get("dst").ok_or_else(|| bad(id, "每个平面需要 dst 四个角"))?,
                );
                check_quad(src, id, "planes[].src")?;
                check_quad(dst, id, "planes[].dst")?;
            }
            Value::Array(planes.clone())
        }
        Some(_) => return Err(bad(id, "planes 必须是非空数组")),
        None => {
            let dst = params.get("quad").ok_or_else(|| bad(id, "透视变形需要 planes 或 quad"))?;
            check_quad(dst, id, "quad")?;
            // 上游 `quad` 用文档角点，因此源框同样按角点 `[x0,y0,x1,y1]` 读。
            let source = match transform_rect(params, id)? {
                Some([x0, y0, x1, y1]) => json!([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]),
                None => json!([
                    [0, 0],
                    [document.size.width, 0],
                    [document.size.width, document.size.height],
                    [0, document.size.height],
                ]),
            };
            json!([{"src": source, "dst": dst}])
        }
    };
    out["planes"] = planes;
    if let Some(layer) = params.get("layer").and_then(Value::as_u64) {
        out["layer"] = json!(layer);
    }
    if let Some(straighten) = choice(params, "straighten", &["horizontal", "vertical", "auto"], id)? {
        out["straighten"] = json!(straighten);
    }
    if let Some(interpolation) = choice(params, "interpolation", &["bicubic", "bilinear", "nearest"], id)? {
        out["interpolation"] = json!(interpolation);
    }
    Ok(out)
}

/// 四个 `[x,y]` 角（左上、右上、右下、左下）的有限性与面积校验。
fn check_quad(value: &Value, id: &str, key: &str) -> Result<()> {
    let quad = value
        .as_array()
        .filter(|quad| quad.len() == 4)
        .ok_or_else(|| bad(id, format!("{key} 必须是四个 [x,y]")))?;
    let mut corners = [[0.0f64; 2]; 4];
    for (index, corner) in quad.iter().enumerate() {
        let pair = corner
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| bad(id, format!("{key} 的每个角必须是 [x,y]")))?;
        let numbers: Option<Vec<f64>> = pair.iter().map(Value::as_f64).collect();
        let Some(values) = numbers.filter(|values| values.iter().all(|value| value.is_finite())) else {
            return Err(bad(id, format!("{key} 的角坐标必须是有限数值")));
        };
        corners[index] = [values[0], values[1]];
    }
    if !photocraft_algo::transform::convex_quad(&corners) {
        return Err(bad(id, format!("{key} 必须是凸四边形（不能自交或退化）")));
    }
    Ok(())
}

fn puppet_warp(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let pins = params
        .get("pins")
        .and_then(Value::as_array)
        .ok_or_else(|| bad(id, "操控变形需要 pins"))?;
    if pins.is_empty() {
        return Err(bad(id, "操控变形至少需要一个钉点"));
    }
    if pins.len() > 512 {
        return Err(bad(id, "钉点数量超过 512"));
    }
    // 上游的钉点是 `{src,dst}`；界面用 `at`/`to` 表达同一件事（at = src）。
    let mut compiled = Vec::with_capacity(pins.len());
    for pin in pins {
        let src = pin
            .get("src")
            .or_else(|| pin.get("at"))
            .or_else(|| pin.get("from"))
            .ok_or_else(|| bad(id, "钉点需要 src 坐标"))?;
        let src = check_point(src, id, "钉点 src")?;
        let dst = match pin.get("dst").or_else(|| pin.get("to")) {
            Some(dst) => check_point(dst, id, "钉点 dst")?,
            None => src,
        };
        let mut entry = json!({"src": src, "dst": dst});
        if let Some(rotate) = optional_number(pin, "rotate", (-360.0, 360.0), id)? {
            entry["rotate"] = json!(rotate);
        }
        if let Some(depth) = pin.get("depth").and_then(Value::as_i64) {
            entry["depth"] = json!(depth);
        }
        compiled.push(entry);
    }
    let mut out = json!({"pins": compiled});
    if let Some(layer) = params.get("layer").and_then(Value::as_u64) {
        out["layer"] = json!(layer);
    }
    if let Some(mode) = choice(params, "mode", &["rigid", "normal", "distort"], id)? {
        out["mode"] = json!(mode);
    }
    if let Some(density) = choice(params, "density", &["fewer", "normal", "more"], id)? {
        out["density"] = json!(density);
    }
    if let Some(expansion) = optional_number(params, "expansion", (-200.0, 200.0), id)? {
        out["expansion"] = json!(expansion);
    }
    if let Some(interpolation) = choice(params, "interpolation", &["bicubic", "bilinear", "nearest"], id)? {
        out["interpolation"] = json!(interpolation);
    }
    let _ = document;
    Ok(out)
}

/// `[x,y]` 有限坐标。
fn check_point(value: &Value, id: &str, key: &str) -> Result<[f64; 2]> {
    let pair = value
        .as_array()
        .filter(|pair| pair.len() == 2)
        .ok_or_else(|| bad(id, format!("{key} 必须是 [x,y]")))?;
    let numbers: Option<Vec<f64>> = pair.iter().map(Value::as_f64).collect();
    numbers
        .filter(|values| values.iter().all(|value| value.is_finite()))
        .map(|values| [values[0], values[1]])
        .ok_or_else(|| bad(id, format!("{key} 必须是有限数值")))
}

// ---------------------------------------------------------------- U54

fn fill(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let contents = choice(
        params,
        "contents",
        &["foreground", "background", "color", "contentAware", "pattern", "history", "black", "gray", "white"],
        id,
    )?
    .unwrap_or_else(|| "color".into());
    let mut out = json!({"contents": contents});
    match contents.as_str() {
        "color" => {
            let color = params
                .get("color")
                .ok_or_else(|| bad(id, "contents=color 需要 color"))?;
            check_color(color, id, "color")?;
            out["color"] = color.clone();
        }
        "pattern" => {
            let pattern = params
                .get("pattern")
                .ok_or_else(|| bad(id, "contents=pattern 需要 pattern"))?;
            if pattern.as_str().is_none() && pattern.as_u64().is_none() {
                return Err(bad(id, "pattern 必须是图案 id 或名称"));
            }
            out["pattern"] = pattern.clone();
        }
        "history" => {
            if let Some(state) = params.get("state").and_then(Value::as_u64) {
                out["state"] = json!(state);
            }
        }
        "contentAware" => {
            if let Some(adaptation) = boolean(params, "colorAdaptation", id)? {
                out["colorAdaptation"] = json!(adaptation);
            }
        }
        _ => {}
    }
    if let Some(scale) = optional_number(params, "scale", (1.0, 1600.0), id)? {
        out["scale"] = json!(scale);
    }
    if let Some(angle) = optional_number(params, "angle", (-360.0, 360.0), id)? {
        out["angle"] = json!(angle);
    }
    if let Some(mode) = choice(params, "mode", BLEND_MODES, id)? {
        out["mode"] = json!(mode);
    }
    if let Some(opacity) = optional_number(params, "opacity", (0.0, 100.0), id)? {
        out["opacity"] = json!(opacity);
    }
    if let Some(preserve) = boolean(params, "preserveTransparency", id)? {
        out["preserveTransparency"] = json!(preserve);
    }
    if let Some(target) = params.get("target") {
        out["target"] = target.clone();
    }
    let _ = document;
    Ok(out)
}

/// 与上游 `blend_from_str` 一致的十二个可渐隐/填充混合模式。
const BLEND_MODES: &[&str] = &[
    "normal",
    "multiply",
    "screen",
    "overlay",
    "softLight",
    "hardLight",
    "darken",
    "lighten",
    "difference",
    "color",
    "luminosity",
    "dissolve",
];

fn content_aware_fill(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let sampling = choice(params, "sampling", &["auto", "rectangular", "custom"], id)?
        .unwrap_or_else(|| "auto".into());
    let mut out = json!({"sampling": sampling});
    if let Some(margin) = optional_number(params, "margin", (0.0, 5000.0), id)? {
        out["margin"] = json!(margin);
    }
    if let Some(area) = params.get("area") {
        let frame = rect(&json!({"rect": area}), id)?;
        check_canvas(frame[2] as u32, frame[3] as u32, id, "内容识别采样区超过画布预算")?;
        out["area"] = json!([frame[0], frame[1], frame[2], frame[3]]);
    }
    for (key, options) in [
        ("colorAdaptation", &["default", "none", "high", "veryHigh"][..]),
        ("rotationAdaptation", &["none", "low", "medium", "high", "full"][..]),
        ("output", &["current", "new", "duplicate"][..]),
    ] {
        if let Some(value) = choice(params, key, options, id)? {
            out[key] = json!(value);
        }
    }
    for key in ["scale", "mirror", "sampleAllLayers"] {
        if let Some(value) = boolean(params, key, id)? {
            out[key] = json!(value);
        }
    }
    if let Some(seed) = params.get("seed").and_then(Value::as_u64) {
        out["seed"] = json!(seed);
    }
    if let Some(channel) = params.get("channel") {
        out["channel"] = channel.clone();
    }
    // 没有选区时上游会拒绝；这里给出更明确的原因。
    if document.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
        return Err(bad(id, "内容识别填充需要先建立选区"));
    }
    Ok(out)
}

fn content_aware_scale(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    let mut any = false;
    for key in ["width", "height"] {
        if let Some(value) = optional_number(params, key, (1.0, f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE)), id)? {
            out[key] = json!(value.round() as u32);
            any = true;
        }
    }
    for key in ["scaleX", "scaleY"] {
        if let Some(value) = optional_number(params, key, (1.0, 400.0), id)? {
            out[key] = json!(value);
            any = true;
        }
    }
    if !any {
        return Err(bad(id, "内容识别缩放需要 width/height 或 scaleX/scaleY"));
    }
    for key in ["x", "y"] {
        if let Some(value) = optional_number(params, key, (-1e6, 1e6), id)? {
            out[key] = json!(value.round() as i64);
        }
    }
    if let Some(amount) = optional_number(params, "amount", (0.0, 100.0), id)? {
        out["amount"] = json!(amount);
    }
    if let Some(protect) = params.get("protect") {
        out["protect"] = protect.clone();
    }
    if let Some(skin) = boolean(params, "protectSkinTones", id)? {
        out["protectSkinTones"] = json!(skin);
    }
    if document.layers.is_empty() {
        return Err(bad(id, "内容识别缩放需要可编辑图层"));
    }
    Ok(out)
}

fn stroke(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let width = optional_number(params, "width", (1.0, 250.0), id)?.unwrap_or(1.0);
    let mut out = json!({"width": width.ceil() as u32});
    if let Some(color) = params.get("color") {
        check_color(color, id, "color")?;
        out["color"] = color.clone();
    }
    if let Some(location) = choice(params, "location", &["inside", "center", "outside"], id)? {
        out["location"] = json!(location);
    }
    if let Some(mode) = choice(params, "mode", BLEND_MODES, id)? {
        out["mode"] = json!(mode);
    }
    if let Some(opacity) = optional_number(params, "opacity", (0.0, 100.0), id)? {
        out["opacity"] = json!(opacity);
    }
    if let Some(preserve) = boolean(params, "preserveTransparency", id)? {
        out["preserveTransparency"] = json!(preserve);
    }
    if let Some(layer) = params.get("layer").and_then(Value::as_u64) {
        out["layer"] = json!(layer);
    }
    // 描边沿选区或图层不透明边缘；两者都没有时明确拒绝。
    if document.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty())
        && !document.layers.iter().any(|layer| layer.surface().is_some())
    {
        return Err(bad(id, "描边需要选区或像素图层"));
    }
    Ok(out)
}

/// 渐隐：只作用于内核记录的可渐隐上一步（`edit_state.fade`），没有时给出明确原因。
fn fade(session: &Session, id: &str, params: &Value) -> Result<Value> {
    let state = session.active().ok_or(EditorError::NoDocument)?;
    if session.edit_state.fade.is_none() {
        return Err(bad(id, "没有可渐隐的上一步操作"));
    }
    // 上游在提交时才核对 revision 与图层是否仍是同一步；这里只提前指出「没有上一步」。
    let _ = state;
    let opacity = number(params, "opacity", (0.0, 100.0), id)?;
    let mut out = json!({"opacity": opacity});
    if let Some(mode) = choice(params, "mode", BLEND_MODES, id)? {
        out["mode"] = json!(mode);
    }
    Ok(out)
}

// ---------------------------------------------------------------- U55

fn auto_align(document: &Document, id: &str, params: &Value) -> Result<Value> {
    // 上游的判据是「选中的像素层 ≥ 2」，而选区属于会话状态、`prepare` 只拿得到文档快照。
    // 因此这里只挡住「文档里连两个图层都没有」这种必然失败的输入；真正的多选判定交给上游，
    // 避免本地猜一个与上游不一致的条件。
    if document.layers.len() < 2 || document.layers.iter().filter(|layer| matches!(layer.content, LayerContent::Raster(_))).count() < 2 {
        return Err(bad(id, "自动对齐至少需要两个像素图层，且需要选中两个或更多像素图层"));
    }
    let projection = choice(
        params,
        "projection",
        &["auto", "perspective", "cylindrical", "spherical", "collage", "reposition"],
        id,
    )?
    .unwrap_or_else(|| "auto".into());
    let mut out = json!({"projection": projection});
    if let Some(reference) = params.get("reference").and_then(Value::as_u64) {
        if document.layer(photocraft_doc::LayerId(reference)).is_none() {
            return Err(bad(id, "reference 必须是现有图层"));
        }
        out["reference"] = json!(reference);
    }
    if let Some(geometric) = boolean(params, "geometricCorrection", id)? {
        out["geometricCorrection"] = json!(geometric);
    }
    if let Some(interpolation) = choice(params, "interpolation", &["bicubic", "bilinear", "nearest"], id)? {
        out["interpolation"] = json!(interpolation);
    }
    if let Some(registration) = choice(params, "registration", &["auto", "features", "intensity"], id)? {
        out["registration"] = json!(registration);
    }
    Ok(out)
}

fn auto_blend(document: &Document, id: &str, params: &Value) -> Result<Value> {
    // 与 `autoAlign` 同一理由：只挡必然失败的输入，多选判据交给上游。
    if document.layers.len() < 2 || document.layers.iter().filter(|layer| matches!(layer.content, LayerContent::Raster(_))).count() < 2 {
        return Err(bad(id, "自动混合至少需要两个像素图层，且需要选中两个或更多像素图层"));
    }
    let method = choice(params, "method", &["panorama", "stack"], id)?.unwrap_or_else(|| "panorama".into());
    let mut out = json!({"method": method});
    if let Some(seamless) = boolean(params, "seamlessTones", id)? {
        out["seamlessTones"] = json!(seamless);
    }
    if let Some(halo) = optional_number(params, "haloControl", (0.0, 8.0), id)? {
        out["haloControl"] = json!(halo);
    }
    if let Some(depth) = boolean(params, "depthMap", id)? {
        out["depthMap"] = json!(depth);
    }
    Ok(out)
}

/// Photomerge：浏览器没有任意路径读取权限，因此只接受**已打开文档**作为来源。
fn photomerge(session: &Session, id: &str, params: &Value) -> Result<Value> {
    let use_open = boolean(params, "useOpenDocuments", id)?.unwrap_or(false);
    if !use_open {
        return Err(bad(id, "Photomerge 需要 useOpenDocuments（浏览器不能读取任意文件夹）"));
    }
    let sources = session.documents().len();
    if sources < 2 {
        return Err(bad(id, "Photomerge 至少需要两个已打开的文档"));
    }
    if sources > photocraft_project_verify::limits::MAX_OPEN_DOCUMENTS {
        return Err(bad(id, "Photomerge 的来源文档数超过同时打开的文档上限"));
    }
    let layout = choice(
        params,
        "layout",
        &["auto", "perspective", "cylindrical", "spherical", "collage", "reposition"],
        id,
    )?
    .unwrap_or_else(|| "auto".into());
    let mut out = json!({"useOpenDocuments": true, "layout": layout});
    for key in ["blend", "vignetteRemoval", "geometricCorrection", "contentAwareFill"] {
        if let Some(value) = boolean(params, key, id)? {
            out[key] = json!(value);
        }
    }
    if let Some(focal) = optional_number(params, "focalLength", (0.0, 2000.0), id)? {
        out["focalLength"] = json!(focal);
    }
    Ok(out)
}

fn merge_to_hdr(session: &Session, id: &str, params: &Value) -> Result<Value> {
    let use_open = boolean(params, "useOpenDocuments", id)?.unwrap_or(false);
    if !use_open {
        return Err(bad(id, "合并到 HDR 需要 useOpenDocuments（浏览器不能读取任意文件夹）"));
    }
    if session.documents().len() < 2 {
        return Err(bad(id, "合并到 HDR 至少需要两个已打开的文档"));
    }
    let mut out = json!({"useOpenDocuments": true});
    if let Some(mode) = choice(params, "mode", &["32", "16", "8"], id)? {
        out["mode"] = json!(mode);
    }
    if let Some(method) = choice(
        params,
        "method",
        &["localAdaptation", "exposureGamma", "highlightCompression", "equalizeHistogram"],
        id,
    )? {
        out["method"] = json!(method);
    }
    for key in ["align", "removeGhosts"] {
        if let Some(value) = boolean(params, key, id)? {
            out[key] = json!(value);
        }
    }
    if let Some(exposures) = params.get("exposures").and_then(Value::as_array) {
        if exposures.iter().any(|value| !value.as_f64().is_some_and(f64::is_finite)) {
            return Err(bad(id, "exposures 必须是有限数值"));
        }
        out["exposures"] = json!(exposures);
    }
    Ok(out)
}

// ---------------------------------------------------------------- U56

fn new_artboard(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    let has_rect = params.get("rect").is_some() || params.get("width").is_some() || params.get("height").is_some();
    if has_rect {
        let frame = rect(params, id)?;
        check_canvas(frame[2] as u32, frame[3] as u32, id, "画板尺寸超过工程上限")?;
        out["x"] = json!(frame[0]);
        out["y"] = json!(frame[1]);
        out["width"] = json!(frame[2]);
        out["height"] = json!(frame[3]);
    }
    if let Some(preset) = params.get("preset") {
        if preset.as_str().is_none() {
            return Err(bad(id, "preset 必须是字符串"));
        }
        out["preset"] = preset.clone();
    }
    if let Some(name) = params.get("name") {
        let name = name.as_str().ok_or_else(|| bad(id, "name 必须是字符串"))?;
        if name.trim().is_empty() || name.chars().count() > 200 {
            return Err(bad(id, "画板名称必须是 1–200 个字符"));
        }
        out["name"] = json!(name);
    }
    if let Some(background) = choice(params, "background", &["white", "black", "transparent", "custom"], id)? {
        out["background"] = json!(background);
        if background == "custom" {
            let color = params
                .get("color")
                .ok_or_else(|| bad(id, "background=custom 需要 color"))?;
            check_color(color, id, "color")?;
            out["color"] = color.clone();
        }
    }
    if document.artboards().len() >= photocraft_project_verify::limits::MAX_LAYERS {
        return Err(bad(id, "画板数量超过图层上限"));
    }
    Ok(out)
}

fn artboard_from_layers(id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    if let Some(name) = params.get("name") {
        let name = name.as_str().ok_or_else(|| bad(id, "name 必须是字符串"))?;
        if name.trim().is_empty() || name.chars().count() > 200 {
            return Err(bad(id, "画板名称必须是 1–200 个字符"));
        }
        out["name"] = json!(name);
    }
    if let Some(background) = choice(params, "background", &["white", "black", "transparent", "custom"], id)? {
        out["background"] = json!(background);
    }
    Ok(out)
}

fn set_artboard(id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    if let Some(layer) = params.get("layer").and_then(Value::as_u64) {
        out["layer"] = json!(layer);
    }
    let has_geometry = params.get("rect").is_some()
        || params.get("x").is_some()
        || params.get("y").is_some()
        || params.get("width").is_some()
        || params.get("height").is_some();
    if has_geometry {
        let frame = rect(params, id)?;
        check_canvas(frame[2] as u32, frame[3] as u32, id, "画板尺寸超过工程上限")?;
        out["x"] = json!(frame[0]);
        out["y"] = json!(frame[1]);
        out["width"] = json!(frame[2]);
        out["height"] = json!(frame[3]);
    }
    if let Some(preset) = params.get("preset") {
        if preset.as_str().is_none() {
            return Err(bad(id, "preset 必须是字符串"));
        }
        out["preset"] = preset.clone();
    }
    if let Some(background) = choice(params, "background", &["white", "black", "transparent", "custom"], id)? {
        out["background"] = json!(background);
    }
    if let Some(color) = params.get("color") {
        check_color(color, id, "color")?;
        out["color"] = color.clone();
    }
    if let Some(name) = params.get("name") {
        let name = name.as_str().ok_or_else(|| bad(id, "name 必须是字符串"))?;
        if name.trim().is_empty() || name.chars().count() > 200 {
            return Err(bad(id, "画板名称必须是 1–200 个字符"));
        }
        out["name"] = json!(name);
    }
    if let Some(move_contents) = boolean(params, "moveContents", id)? {
        out["moveContents"] = json!(move_contents);
    }
    Ok(out)
}

fn new_frame(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let frame = rect(params, id)?;
    check_canvas(frame[2] as u32, frame[3] as u32, id, "框架尺寸超过工程上限")?;
    let mut out = json!({
        "x": frame[0],
        "y": frame[1],
        "width": frame[2],
        "height": frame[3],
    });
    if let Some(shape) = choice(params, "shape", &["rectangle", "ellipse"], id)? {
        out["shape"] = json!(shape);
    }
    if let Some(layer) = params.get("layer").and_then(Value::as_u64) {
        if document.layer(photocraft_doc::LayerId(layer)).is_none() {
            return Err(bad(id, "layer 必须是现有图层"));
        }
        out["layer"] = json!(layer);
    }
    if let Some(name) = params.get("name") {
        let name = name.as_str().ok_or_else(|| bad(id, "name 必须是字符串"))?;
        if name.trim().is_empty() || name.chars().count() > 200 {
            return Err(bad(id, "框架名称必须是 1–200 个字符"));
        }
        out["name"] = json!(name);
    }
    Ok(out)
}

fn frame_from_layers(session: &Session, id: &str, params: &Value) -> Result<Value> {
    let state = session.active().ok_or(EditorError::NoDocument)?;
    if state.selected_layers().is_empty() {
        return Err(bad(id, "从图层新建框架需要先选中图层"));
    }
    let mut out = json!({});
    if let Some(name) = params.get("name") {
        let name = name.as_str().ok_or_else(|| bad(id, "name 必须是字符串"))?;
        if name.trim().is_empty() || name.chars().count() > 200 {
            return Err(bad(id, "框架名称必须是 1–200 个字符"));
        }
        out["name"] = json!(name);
    }
    Ok(out)
}

fn new_slice(document: &Document, id: &str, params: &Value) -> Result<Value> {
    let frame = rect(params, id)?;
    check_canvas(frame[2] as u32, frame[3] as u32, id, "切片尺寸超过画布预算")?;
    let mut out = json!({
        "x": frame[0],
        "y": frame[1],
        "width": frame[2],
        "height": frame[3],
    });
    if document.slices.list.len() >= photocraft_project_verify::limits::MAX_ENTRIES {
        return Err(bad(id, "切片数量超过结构条目上限"));
    }
    apply_slice_options(&mut out, document, id, params, None)?;
    Ok(out)
}

fn slices_from_guides(document: &Document, id: &str, params: &Value) -> Result<Value> {
    if document.guides.vertical.is_empty() && document.guides.horizontal.is_empty() {
        return Err(bad(id, "没有参考线可用于建立切片"));
    }
    let parts = (document.guides.vertical.len() + 1).saturating_mul(document.guides.horizontal.len() + 1);
    if parts > photocraft_project_verify::limits::MAX_ENTRIES {
        return Err(bad(id, "参考线网格产生的切片超过结构条目上限"));
    }
    if let Some(name) = params.get("name") {
        if name.as_str().is_none_or(|name| name.trim().is_empty() || name.chars().count() > 200) {
            return Err(bad(id, "name 必须是 1–200 个字符"));
        }
    }
    Ok(json!({}))
}

fn layer_slice(id: &str, params: &Value) -> Result<Value> {
    let mut out = json!({});
    if let Some(layer) = params.get("layer").and_then(Value::as_u64) {
        out["layer"] = json!(layer);
    }
    if let Some(name) = params.get("name") {
        let name = name.as_str().ok_or_else(|| bad(id, "name 必须是字符串"))?;
        if name.trim().is_empty() || name.chars().count() > 200 {
            return Err(bad(id, "切片名称必须是 1–200 个字符"));
        }
        // 重名必须在提交前被发现，否则导出命名会互相覆盖。
        out["name"] = json!(name);
    }
    for key in ["url", "alt"] {
        if let Some(value) = params.get(key) {
            let text = value.as_str().ok_or_else(|| bad(id, format!("{key} 必须是字符串")))?;
            if text.chars().count() > 1024 {
                return Err(bad(id, format!("{key} 超过 1024 个字符")));
            }
        }
    }
    Ok(out)
}

/// 切片选项：名称、类型、链接、单元格文本与对齐。重名在提交前拒绝（导出会互相覆盖）。
fn apply_slice_options(out: &mut Value, document: &Document, id: &str, params: &Value, skip: Option<u32>) -> Result<()> {
    if let Some(name) = params.get("name") {
        let name = name.as_str().ok_or_else(|| bad(id, "name 必须是字符串"))?;
        if name.trim().is_empty() || name.chars().count() > 200 {
            return Err(bad(id, "切片名称必须是 1–200 个字符"));
        }
        if document
            .slices
            .list
            .iter()
            .any(|slice| Some(slice.id) != skip && slice.name == name)
        {
            return Err(bad(id, format!("切片名称 {name} 已存在")));
        }
        out["name"] = json!(name);
    }
    if let Some(kind) = choice(params, "kind", &["image", "noImage", "table"], id)? {
        out["kind"] = json!(kind);
    }
    for key in ["url", "target", "message", "alt", "cellText"] {
        if let Some(value) = params.get(key) {
            let text = value.as_str().ok_or_else(|| bad(id, format!("{key} 必须是字符串")))?;
            if text.chars().count() > 1024 {
                return Err(bad(id, format!("{key} 超过 1024 个字符")));
            }
            out[key] = json!(text);
        }
    }
    if let Some(html) = boolean(params, "cellTextIsHtml", id)? {
        out["cellTextIsHtml"] = json!(html);
    }
    for key in ["horizontalAlign", "verticalAlign"] {
        if let Some(value) = optional_number(params, key, (0.0, 4.0), id)? {
            out[key] = json!(value.round() as u32);
        }
    }
    if let Some(background) = params.get("background") {
        let name = background.as_str().ok_or_else(|| bad(id, "background 必须是 none 或 #rrggbb"))?;
        let valid = name == "none"
            || name.strip_prefix('#').is_some_and(|hex| hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()));
        if !valid {
            return Err(bad(id, "background 必须是 none 或 #rrggbb"));
        }
        out["background"] = json!(name);
    }
    if let Some(outsets) = params.get("outsets").and_then(Value::as_array) {
        if outsets.len() != 4 || outsets.iter().any(|value| !value.as_f64().is_some_and(|v| v.is_finite() && (-1000.0..=1000.0).contains(&v))) {
            return Err(bad(id, "outsets 必须是四个 -1000–1000 的数值"));
        }
        out["outsets"] = json!(outsets);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Color, ColorMode, Document as Doc, Layer, SampleType, Size};

    fn document(width: u32, height: u32) -> Doc {
        Doc::with_background(
            "doc",
            Size::new(width, height),
            ColorMode::Rgb,
            SampleType::U8,
            Color::rgb(0.5, 0.5, 0.5),
        )
    }

    fn session(width: u32, height: u32) -> Session {
        let mut session = Session::new();
        session.add_document(document(width, height), None);
        session
    }

    #[test]
    fn every_workflow_is_unique_and_points_at_a_registered_command() {
        let mut seen = std::collections::HashSet::new();
        for entry in WORKFLOWS {
            assert!(seen.insert(entry.id), "工作流 id 重复：{}", entry.id);
            if let Some(command) = entry.command {
                assert!(
                    photocraft_engine::commands::find(command).is_some(),
                    "工作流 {} 指向未注册的命令 {command}",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn manifest_reports_availability_with_reasons_and_never_lies() {
        let manifest = manifest();
        let entries = manifest.as_array().unwrap();
        assert_eq!(entries.len(), WORKFLOWS.len());
        for entry in entries {
            let allowed = entry["allowed"].as_bool().unwrap();
            let reason = entry["reason"].as_str();
            match entry["command"].as_str() {
                Some(command) => {
                    if allowed {
                        assert!(crate::capability::command_allowed(command), "{} 声称开放但命令门未开放", entry["id"]);
                        assert!(reason.is_none());
                    } else {
                        assert!(reason.is_some_and(|reason| !reason.is_empty()), "{} 未开放却没有原因", entry["id"]);
                    }
                }
                // 宿主交付入口没有内核命令 id：永远不可执行，并且必须有原因。
                None => {
                    assert!(entry["command"].is_null(), "{} 的 command 既不是字符串也不是 null", entry["id"]);
                    assert!(!allowed, "{} 没有内核命令却声称可用", entry["id"]);
                    assert!(reason.is_some_and(|reason| !reason.is_empty()), "{} 没有宿主端口却未说明", entry["id"]);
                }
            }
        }
    }

    #[test]
    fn crop_accepts_extending_frames_and_compiles_straighten_and_target() {
        let doc = document(40, 30);
        let out = crop(&doc, "crop", &json!({"x":-5,"y":-4,"width":50,"height":40})).unwrap();
        assert_eq!((out["x"].as_i64(), out["y"].as_i64()), (Some(-5), Some(-4)));
        let out = crop(&doc, "crop", &json!({"rect":[2,3,20,10],"angle":15,"targetWidth":40,"targetHeight":20,"resolution":300,"resample":"lanczos","deleteCroppedPixels":false})).unwrap();
        assert_eq!(out["angle"], 15.0);
        assert_eq!(out["targetWidth"], 40);
        assert_eq!(out["resolution"], 300.0);
        assert_eq!(out["deleteCroppedPixels"], false);
        // 拉直要求显式画布框。
        assert!(crop(&doc, "crop", &json!({"rect":[0,0,20,20],"angle":10})).is_ok());
        assert!(crop(&doc, "crop", &json!({"width":20,"height":20,"angle":10})).is_err());
        // 角度 360 不进入旋转路径。
        let out = crop(&doc, "crop", &json!({"rect":[0,0,20,20],"angle":360})).unwrap();
        assert!(out.get("angle").is_none());
        // 目标尺寸必须成对，且不能配 resample=none。
        assert!(crop(&doc, "crop", &json!({"rect":[0,0,20,20],"targetWidth":10})).is_err());
        assert!(crop(&doc, "crop", &json!({"rect":[0,0,20,20],"targetWidth":10,"targetHeight":10,"resample":"none"})).is_err());
        // 超预算与非法布尔。
        assert!(crop(&doc, "crop", &json!({"rect":[0,0,8193,10]})).is_err());
        assert!(crop(&doc, "crop", &json!({"rect":[0,0,20,20],"contentAware":"yes"})).is_err());
    }

    #[test]
    fn perspective_crop_rejects_degenerate_and_non_convex_quads() {
        let doc = document(160, 120);
        let ok = perspective_crop(&doc, "perspectiveCrop", &json!({"corners":[[30,12],[140,25],[128,110],[14,95]]})).unwrap();
        assert_eq!(ok["width"], 113);
        assert_eq!(ok["height"], 85);
        for corners in [
            json!([[0,0],[10,0],[10,10]]),
            json!([[0,0],[50,0],[100,0],[0,50]]),
            json!([[0,0],[50,50],[50,0],[0,50]]),
            json!([[0,0],[0,50],[50,50],[50,0]]),
            json!([[0,0],[0.5,0],[0.5,0.5],[0,0.5]]),
            json!([[0,0],[1e300,0],[50,50],[0,50]]),
            json!([[0,0],["a",0],[50,50],[0,50]]),
        ] {
            assert!(perspective_crop(&doc, "perspectiveCrop", &json!({"corners":corners})).is_err(), "{corners}");
        }
        // 显式输出尺寸与比例推导。
        let sized = perspective_crop(&doc, "perspectiveCrop", &json!({"corners":[[0,0],[100,0],[100,50],[0,50]],"width":200,"height":100,"resolution":300})).unwrap();
        assert_eq!((sized["width"].as_u64(), sized["height"].as_u64()), (Some(200), Some(100)));
        let proportional = perspective_crop(&doc, "perspectiveCrop", &json!({"corners":[[0,0],[100,0],[100,50],[0,50]],"width":200})).unwrap();
        assert_eq!(proportional["height"].as_u64(), Some(100));
        assert!(perspective_crop(&doc, "perspectiveCrop", &json!({"corners":[[0,0],[100,0],[100,50],[0,50]],"width":1e9,"height":10})).is_err());
    }

    #[test]
    fn image_size_and_canvas_size_compile_units_and_anchor() {
        let doc = document(40, 30);
        // 只改 DPI：不带 width/height，走 resample=none 的元数据路径。
        let out = image_size(&doc, "imageSize", &json!({"resolution":300,"resample":"none"})).unwrap();
        assert_eq!(out.get("width"), None);
        assert_eq!(out["resolution"], 300.0);
        assert_eq!(out["resample"], "none");
        // keepPrintSize 由 DPI 推导像素（默认 72 ppi → 144 ppi 翻倍）。
        let out = image_size(&doc, "imageSize", &json!({"resolution":144,"keepPrintSize":true})).unwrap();
        assert_eq!((out["width"].as_u64(), out["height"].as_u64()), (Some(80), Some(60)));
        assert!(image_size(&doc, "imageSize", &json!({"keepPrintSize":true})).is_err());
        assert!(image_size(&doc, "imageSize", &json!({"resolution":0})).is_err());
        assert!(image_size(&doc, "imageSize", &json!({"resample":"starfield"})).is_err());
        assert!(image_size(&doc, "imageSize", &json!({"percent":0})).is_err());
        // 画布：相对增减是**增量**，直接交给内核（上游自己做 ow + w），不能在这里先加一遍。
        let out = canvas_size(&doc, "canvasSize", &json!({"width":-10,"height":-5,"relative":true,"anchor":"bottomRight","extensionColor":"transparent"})).unwrap();
        assert_eq!((out["width"].as_i64(), out["height"].as_i64()), (Some(-10), Some(-5)));
        assert_eq!(out["relative"], true);
        assert_eq!(out["extensionColor"], "transparent");
        assert!(canvas_size(&doc, "canvasSize", &json!({"width":50,"height":50,"extensionColor":"#36c"})).is_err());
        assert!(canvas_size(&doc, "canvasSize", &json!({"width":50,"height":50,"extensionColor":"purple"})).is_err());
        assert!(canvas_size(&doc, "canvasSize", &json!({"width":50,"height":50,"anchor":"middle"})).is_err());
        assert!(canvas_size(&doc, "canvasSize", &json!({"width":-50,"height":50,"relative":true})).is_err());
    }

    #[test]
    fn trim_and_rotation_compile_sides_and_budget() {
        let out = trim("trim", &json!({"basedOn":"topLeft","top":true,"bottom":false,"left":true,"right":false})).unwrap();
        assert_eq!(out["basedOn"], "topLeft");
        assert_eq!(out["bottom"], false);
        assert!(trim("trim", &json!({"basedOn":"nowhere"})).is_err());
        assert!(trim("trim", &json!({"top":1})).is_err());
        let doc = document(40, 30);
        let out = rotate_arbitrary(&doc, "rotateArbitrary", &json!({"angle":33})).unwrap();
        assert_eq!(out["direction"], "cw");
        assert!(rotate_arbitrary(&doc, "rotateArbitrary", &json!({"angle":400})).is_err());
        assert!(rotate_arbitrary(&doc, "rotateArbitrary", &json!({"angle":10,"direction":"sideways"})).is_err());
        // 45° 的 40×30 画布仍在上限内；超大画布必须被预算拒绝。
        assert!(rotate_arbitrary(&document(8192, 8192), "rotateArbitrary", &json!({"angle":45})).is_err());
    }

    #[test]
    fn warp_validates_mesh_shape_and_styles() {
        let doc = document(80, 60);
        // `us`/`vs` 是块边界；单块网格 4×4 个控制点。
        let mesh = json!({"us":[0.0,1.0],"vs":[0.0,1.0],"points":[[0,0],[10,0],[20,0],[30,0],[0,10],[10,10],[20,10],[30,10],[0,20],[10,20],[20,20],[30,20],[0,30],[10,30],[20,30],[30,30]]});
        let out = warp(&doc, "warp", &json!({"style":"arc","bend":30})).unwrap();
        assert_eq!(out["style"], "arc");
        let out = warp(&doc, "warp", &json!({"mesh":mesh})).unwrap();
        assert!(out["mesh"].is_object());
        assert!(warp(&doc, "warp", &json!({})).is_err());
        assert!(warp(&doc, "warp", &json!({"style":"custom"})).is_err());
        assert!(warp(&doc, "warp", &json!({"style":"spiral"})).is_err());
        assert!(warp(&doc, "warp", &json!({"bend":500})).is_err());
        // 点数是 (3c+1)×(3r+1)，单块就是 16 个；块边界必须 0…1。
        assert!(warp(&doc, "warp", &json!({"mesh":{"us":[0,1],"vs":[0,1],"points":[[0,0],[1,0],[1,1],[0,1]]}})).is_err());
        assert!(warp(&doc, "warp", &json!({"mesh":{"us":[0,0.5],"vs":[0,1],"points":[[0,0]]}})).is_err(), "块边界必须以 1 结尾");
        let bad_points = json!({"us":[0.0,1.0],"vs":[0.0,1.0],"points":[[0,0]]});
        assert!(warp(&doc, "warp", &json!({"mesh":bad_points})).is_err());
    }

    #[test]
    fn warp_grid_and_split_accept_documented_sizes() {
        let doc = document(80, 60);
        let mesh = json!({"us":[0.0,0.5,1.0],"vs":[0.0,0.5,1.0],"points":vec![json!([0,0]); 49]});
        let out = warp_grid(&doc, "warpGrid", &json!({"size":4,"mesh":mesh})).unwrap();
        assert_eq!(out["size"], 4);
        assert_eq!(out["mesh"]["us"].as_array().unwrap().len(), 3);
        let out = warp_grid(&doc, "warpGrid", &json!({"size":"default","mesh":mesh})).unwrap();
        assert_eq!(out["size"], "default");
        assert!(warp_grid(&doc, "warpGrid", &json!({"size":0,"mesh":mesh})).is_err());
        assert!(warp_grid(&doc, "warpGrid", &json!({"size":65,"mesh":mesh})).is_err());
        assert!(warp_grid(&doc, "warpGrid", &json!({"size":1.5,"mesh":mesh})).is_err());
        assert!(warp_grid(&doc, "warpGrid", &json!({"size":"custom","mesh":mesh})).is_err());
        // 没有正在编辑的 warp / 带变形的智能对象时，给出可读的前置条件，而不是上游的参数错误。
        let error = warp_grid(&doc, "warpGrid", &json!({"size":4})).unwrap_err().to_string();
        assert!(error.contains("正在编辑的变形"), "{error}");
        // 拆分需要正在编辑的变形。
        let warp_value = json!({"style":{"kind":"custom"},"bounds":[0,0,80,60],
            "mesh":{"us":[0.0,0.5,1.0],"vs":[0.0,0.5,1.0],"points":vec![json!([0,0]); 49]}});
        let out = warp_split(&doc, "splitWarpCrosswise", &json!({"at":[10,10],"warp":warp_value})).unwrap();
        // `at` 原样透传：它是文档坐标，任何归一化都会让画布上双击的位置对不上。
        assert_eq!(out["at"], json!([10,10]));
        // 负数与小数也不夹取：画布允许负坐标，夹取就会切错位置。
        let out = warp_split(&doc, "splitWarpVertically", &json!({"at":[-7.25,30.5],"warp":warp_value})).unwrap();
        assert_eq!(out["at"], json!([-7.25,30.5]));
        assert!(warp_split(&doc, "splitWarpCrosswise", &json!({"at":[10],"warp":warp_value})).is_err());
        let error = warp_split(&doc, "splitWarpCrosswise", &json!({"at":[10,10]})).unwrap_err().to_string();
        assert!(error.contains("正在编辑的变形"), "{error}");
    }

    #[test]
    fn puppet_and_perspective_warp_require_pins_and_planes() {
        let doc = document(80, 60);
        // 界面用 `at`/`to`，内核用 `src`/`dst`；编译结果必须是内核接受的形状。
        let out = puppet_warp(&doc, "puppetWarp", &json!({"pins":[{"at":[10,10]},{"at":[20,20],"to":[24,26]}]})).unwrap();
        assert_eq!(out["pins"].as_array().unwrap().len(), 2);
        assert_eq!(out["pins"][0]["src"], json!([10.0,10.0]));
        // 没给 `to` 时钉住不动（src == dst），而不是缺字段让内核报反序列化错误。
        assert_eq!(out["pins"][0]["dst"], json!([10.0,10.0]));
        assert_eq!(out["pins"][1]["dst"], json!([24.0,26.0]));
        let out = puppet_warp(&doc, "puppetWarp", &json!({"pins":[{"src":[1,2],"dst":[3,4],"rotate":5,"depth":2}],"density":"more","expansion":4})).unwrap();
        assert_eq!(out["pins"][0]["rotate"], 5.0);
        assert_eq!(out["density"], "more");
        assert_eq!(out["expansion"], 4.0);
        assert!(puppet_warp(&doc, "puppetWarp", &json!({"pins":[]})).is_err());
        assert!(puppet_warp(&doc, "puppetWarp", &json!({"pins":[{"at":[10]}]})).is_err());
        assert!(puppet_warp(&doc, "puppetWarp", &json!({"pins":[{"at":[10,10]}],"mode":"melt"})).is_err());
        assert!(puppet_warp(&doc, "puppetWarp", &json!({"pins":[{"at":[10,10]}],"density":"some"})).is_err());
        assert!(puppet_warp(&doc, "puppetWarp", &json!({"pins":[{"at":[10,10]}],"expansion":300})).is_err());
        // 透视变形：单个四角框编译成一个平面，源框默认整幅画布。
        let out = perspective_warp(&doc, "perspectiveWarp", &json!({"quad":[[0,0],[10,0],[10,10],[0,10]]})).unwrap();
        assert_eq!(out["planes"].as_array().unwrap().len(), 1);
        assert_eq!(out["planes"][0]["src"], json!([[0,0],[80,0],[80,60],[0,60]]));
        // 上游 `rect` 是角点 `[x0,y0,x1,y1]`（不是宽高），源框因此原样取四个角。
        let out = perspective_warp(&doc, "perspectiveWarp", &json!({"quad":[[0,0],[10,0],[10,10],[0,10]],"rect":[5,5,25,25],"straighten":"auto"})).unwrap();
        assert_eq!(out["planes"][0]["src"], json!([[5.0,5.0],[25.0,5.0],[25.0,25.0],[5.0,25.0]]));
        assert_eq!(out["straighten"], "auto");
        // 多平面原样透传，但每个平面必须有两个凸四边形。
        let plane = json!({"src":[[0,0],[10,0],[10,10],[0,10]],"dst":[[1,1],[10,1],[10,10],[1,10]]});
        let out = perspective_warp(&doc, "perspectiveWarp", &json!({"planes":[plane]})).unwrap();
        assert_eq!(out["planes"].as_array().unwrap().len(), 1);
        assert!(perspective_warp(&doc, "perspectiveWarp", &json!({})).is_err());
        assert!(perspective_warp(&doc, "perspectiveWarp", &json!({"quad":[[0,0],[10,0],[10]]})).is_err());
        assert!(perspective_warp(&doc, "perspectiveWarp", &json!({"quad":[[0,0],[10,10],[10,0],[0,10]]})).is_err(), "自交四边形");
        assert!(perspective_warp(&doc, "perspectiveWarp", &json!({"planes":[]})).is_err());
        let degenerate = json!({"src":[[0,0],[10,0],[10,0],[0,0]],"dst":[[0,0],[10,0],[10,10],[0,10]]});
        assert!(perspective_warp(&doc, "perspectiveWarp", &json!({"planes":[degenerate]})).is_err());
    }

    #[test]
    fn fill_stroke_and_fade_compile_selection_and_appearance() {
        let mut doc = document(40, 30);
        let out = fill(&doc, "fill", &json!({"contents":"color","color":"#3366cc","mode":"multiply","opacity":50,"preserveTransparency":true})).unwrap();
        assert_eq!(out["contents"], "color");
        assert_eq!(out["color"], "#3366cc");
        assert_eq!(out["mode"], "multiply");
        assert!(fill(&doc, "fill", &json!({"contents":"color"})).is_err());
        assert!(fill(&doc, "fill", &json!({"contents":"color","color":"#36c"})).is_err());
        assert!(fill(&doc, "fill", &json!({"contents":"pattern"})).is_err());
        assert!(fill(&doc, "fill", &json!({"contents":"color","color":"#3366cc","mode":"zebra"})).is_err());
        assert!(fill(&doc, "fill", &json!({"contents":"color","color":"#3366cc","opacity":120})).is_err());
        // 描边：位置、宽度与不透明度。
        let out = stroke(&doc, "stroke", &json!({"width":3,"location":"outside","color":"#ff0000","opacity":80})).unwrap();
        assert_eq!(out["width"], 3);
        assert_eq!(out["location"], "outside");
        assert!(stroke(&doc, "stroke", &json!({"location":"around"})).is_err());
        assert!(stroke(&doc, "stroke", &json!({"width":0})).is_err());
        // Fade 必须在范围里并支持混合模式；没有可渐隐的上一步时给出明确原因。
        let mut session = session(40, 30);
        assert!(matches!(fade(&session, "fade", &json!({"opacity":40})), Err(EditorError::CommandFailed { .. })));
        let state = session.active().unwrap().clone();
        session.edit_state.fade = Some(photocraft_engine::edit_menu_cmds::FadeSource {
            doc: state.doc.id,
            revision: state.revision,
            layer: state.active_layer.unwrap_or(photocraft_doc::LayerId(0)),
            mask: false,
            label: "Fill".into(),
        });
        let out = fade(&session, "fade", &json!({"opacity":40,"mode":"screen"})).unwrap();
        assert_eq!(out["opacity"], 40.0);
        assert!(fade(&session, "fade", &json!({"opacity":140})).is_err());
        assert!(fade(&session, "fade", &json!({"opacity":40,"mode":"melt"})).is_err());
        // 内容识别填充需要选区。
        assert!(content_aware_fill(&doc, "contentAwareFill", &json!({})).is_err());
        doc.selection = Some(photocraft_doc::LayerMask::hide_all().surface);
        let selection = doc.selection.as_mut().unwrap();
        selection.write_pixel(2, 2, &[1.0]);
        let out = content_aware_fill(&doc, "contentAwareFill", &json!({"sampling":"auto","output":"current"})).unwrap();
        assert_eq!(out["sampling"], "auto");
        assert!(content_aware_fill(&doc, "contentAwareFill", &json!({"sampling":"ray"})).is_err());
    }

    #[test]
    fn content_aware_scale_needs_a_size_and_align_blend_need_two_layers() {
        let doc = document(40, 30);
        assert!(content_aware_scale(&doc, "contentAwareScale", &json!({})).is_err());
        let out = content_aware_scale(&doc, "contentAwareScale", &json!({"scaleX":120,"amount":80,"protectSkinTones":true})).unwrap();
        assert_eq!(out["scaleX"], 120.0);
        assert!(content_aware_scale(&doc, "contentAwareScale", &json!({"scaleX":401})).is_err());
        // 单个背景层不足以自动对齐/混合。
        assert!(auto_align(&doc, "autoAlign", &json!({})).is_err());
        assert!(auto_blend(&doc, "autoBlend", &json!({})).is_err());
        let mut two = document(40, 30);
        two.layers.push(Layer::raster("second", two.pixel_format()));
        let out = auto_align(&two, "autoAlign", &json!({"projection":"cylindrical","registration":"features"})).unwrap();
        assert_eq!(out["projection"], "cylindrical");
        assert_eq!(out["registration"], "features");
        assert!(auto_align(&two, "autoAlign", &json!({"reference":999})).is_err());
        assert!(auto_align(&two, "autoAlign", &json!({"projection":"fisheye"})).is_err());
        let out = auto_blend(&two, "autoBlend", &json!({"method":"stack","haloControl":3})).unwrap();
        assert_eq!(out["method"], "stack");
        assert!(auto_blend(&two, "autoBlend", &json!({"method":"mosaic"})).is_err());
        assert!(auto_blend(&two, "autoBlend", &json!({"haloControl":9})).is_err());
    }

    #[test]
    fn photomerge_and_hdr_require_open_documents_instead_of_paths() {
        let mut session = session(40, 30);
        assert!(photomerge(&session, "photomerge", &json!({"paths":["/tmp/a.png"]})).is_err());
        assert!(photomerge(&session, "photomerge", &json!({"useOpenDocuments":true})).is_err(), "只有一个文档");
        assert!(merge_to_hdr(&session, "mergeToHdr", &json!({"paths":["/tmp/a.png"]})).is_err());
        session.add_document(document(40, 30), None);
        let out = photomerge(&session, "photomerge", &json!({"useOpenDocuments":true,"layout":"cylindrical","blend":false})).unwrap();
        assert_eq!(out["layout"], "cylindrical");
        assert_eq!(out["blend"], false);
        assert!(photomerge(&session, "photomerge", &json!({"useOpenDocuments":true,"layout":"spiral"})).is_err());
        let out = merge_to_hdr(&session, "mergeToHdr", &json!({"useOpenDocuments":true,"mode":"16","exposures":[0,-1,1]})).unwrap();
        assert_eq!(out["mode"], "16");
        assert!(merge_to_hdr(&session, "mergeToHdr", &json!({"useOpenDocuments":true,"mode":"12"})).is_err());
        assert!(merge_to_hdr(&session, "mergeToHdr", &json!({"useOpenDocuments":true,"exposures":["x"]})).is_err());
    }

    #[test]
    fn artboard_frame_and_slice_compile_structure_and_reject_conflicts() {
        let doc = document(400, 300);
        let out = new_artboard(&doc, "newArtboard", &json!({"rect":[0,0,375,812],"preset":"iPhone 14","name":"画板 1","background":"custom","color":"#ffffff"})).unwrap();
        assert_eq!(out["width"], 375);
        assert_eq!(out["background"], "custom");
        assert!(new_artboard(&doc, "newArtboard", &json!({"rect":[0,0,375,812],"background":"custom"})).is_err());
        assert!(new_artboard(&doc, "newArtboard", &json!({"rect":[0,0,0,10]})).is_err());
        assert!(new_artboard(&doc, "newArtboard", &json!({"rect":[0,0,10,10],"name":"  "})).is_err());
        let out = set_artboard("setArtboard", &json!({"layer":3,"rect":[10,10,200,100],"moveContents":false})).unwrap();
        assert_eq!(out["moveContents"], false);
        assert!(set_artboard("setArtboard", &json!({"rect":[10,10,200,100],"background":"teal"})).is_err());
        let out = new_frame(&doc, "newFrame", &json!({"x":10,"y":10,"width":200,"height":100,"shape":"ellipse"})).unwrap();
        assert_eq!(out["shape"], "ellipse");
        assert!(new_frame(&doc, "newFrame", &json!({"x":10,"y":10,"width":200,"height":100,"layer":999})).is_err());
        assert!(new_frame(&doc, "newFrame", &json!({"x":10,"y":10,"width":200,"height":100,"shape":"star"})).is_err());
        // 切片重名必须在提交前拒绝。
        let mut sliced = document(400, 300);
        sliced.slices.list.push(photocraft_doc::Slice {
            id: 1,
            group_id: 0,
            origin: photocraft_doc::SliceOrigin::User,
            layer: None,
            name: "logo".into(),
            rect: photocraft_doc::Rect::from_xywh(0, 0, 10, 10),
            kind: photocraft_doc::SliceKind::Image,
            url: String::new(),
            target: String::new(),
            message: String::new(),
            alt: String::new(),
            cell_text_is_html: false,
            cell_text: String::new(),
            horizontal_align: 0,
            vertical_align: 0,
            background: None,
            outsets: [0, 0, 0, 0],
        });
        assert!(new_slice(&sliced, "newSlice", &json!({"rect":[0,0,10,10],"name":"logo"})).is_err());
        let out = new_slice(&sliced, "newSlice", &json!({"rect":[0,0,10,10],"name":"banner","kind":"noImage","url":"https://example.com"})).unwrap();
        assert_eq!(out["kind"], "noImage");
        assert_eq!(out["url"], "https://example.com");
        // 参考线为空的文档不能建网格切片。
        assert!(slices_from_guides(&doc, "slicesFromGuides", &json!({})).is_err());
        let mut guided = document(400, 300);
        guided.guides.vertical = vec![100.0, 200.0];
        guided.guides.horizontal = vec![100.0];
        assert!(slices_from_guides(&guided, "slicesFromGuides", &json!({})).is_ok());
        assert!(new_slice(&doc, "newSlice", &json!({"rect":[0,0,10,10],"kind":"tile"})).is_err());
    }

    /// U56 导出计划：范围来自内核解析结果，名称去重且保持顺序，非法字符被清理。
    #[test]
    fn export_plan_names_ranges_from_the_kernel_resolution() {
        let mut doc = document(200, 100);
        doc.name = "海报/主图".into();
        doc.slices.list.push(photocraft_doc::Slice {
            id: 1,
            group_id: 0,
            origin: photocraft_doc::SliceOrigin::User,
            layer: None,
            name: "logo".into(),
            rect: photocraft_doc::Rect::from_xywh(10, 20, 30, 40),
            kind: photocraft_doc::SliceKind::Image,
            url: String::new(),
            target: String::new(),
            message: String::new(),
            alt: String::new(),
            cell_text_is_html: false,
            cell_text: String::new(),
            horizontal_align: 0,
            vertical_align: 0,
            background: None,
            outsets: [0, 0, 0, 0],
        });
        doc.slices.list.push(photocraft_doc::Slice {
            id: 2,
            group_id: 0,
            origin: photocraft_doc::SliceOrigin::User,
            layer: None,
            name: "logo".into(),
            rect: photocraft_doc::Rect::from_xywh(60, 20, 20, 20),
            kind: photocraft_doc::SliceKind::Image,
            url: String::new(),
            target: String::new(),
            message: String::new(),
            alt: String::new(),
            cell_text_is_html: false,
            cell_text: String::new(),
            horizontal_align: 0,
            vertical_align: 0,
            background: None,
            outsets: [0, 0, 0, 0],
        });
        let plan = export_plan(&doc, "slices", &json!({})).unwrap();
        let files = plan["files"].as_array().unwrap();
        // 内核会补出自动切片，因此只断言我们自己放进去的那两条。
        let named: Vec<_> = files.iter().filter(|file| file["name"] == "logo").collect();
        assert_eq!(named.len(), 2, "两个同名切片都必须保留");
        assert_eq!(named[0]["rect"], json!([10, 20, 30, 40]));
        assert_eq!(named[1]["rect"], json!([60, 20, 20, 20]));
        // 重名去重：第二个同名文件不能覆盖第一个。
        assert_ne!(named[0]["fileName"], named[1]["fileName"]);
        assert!(named[0]["fileName"].as_str().unwrap().ends_with(".png"));
        // 文档名里的路径分隔符不会进入文件名。
        for file in files {
            let name = file["fileName"].as_str().unwrap();
            assert!(!name.contains('/') && !name.contains('\\'), "{name}");
        }

        // 画板：名称带文档前缀，范围就是画板矩形。
        let mut board = document(200, 100);
        board.name = "海报/主图".into();
        board.layers.push(photocraft_doc::Layer::group(
            "首屏",
            vec![photocraft_doc::Layer::raster("内容", board.pixel_format())],
        ));
        let last = board.layers.len() - 1;
        if let photocraft_doc::LayerContent::Group(group) = &mut board.layers[last].content {
            group.artboard = Some(photocraft_doc::Artboard::new(photocraft_doc::Rect::from_xywh(5, 6, 50, 60)));
        }
        let plan = export_plan(&board, "artboards", &json!({})).unwrap();
        let files = plan["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["rect"], json!([5, 6, 50, 60]));
        assert_eq!(files[0]["name"], "首屏");
        assert!(files[0]["fileName"].as_str().unwrap().starts_with("海报主图_"), "{:?}", files[0]);
        // 没有画板时必须给具体原因，而不是空计划。
        assert!(export_plan(&document(10, 10), "artboards", &json!({})).is_err());
    }

    /// 显示全部落到 `image.crop` 后，结果必须与上游 `image.revealAll` **逐字节一致**。
    ///
    /// 这条守着「复用而非另写一套」：上游 `image.revealAll` 自己就是
    /// `reveal_all_bounds` + 一次不删像素的 `image.crop`。任何一侧算法变化都会让这里失败，
    /// 也就必须重新评估是否还该把入口落到 `image.crop`。
    #[test]
    fn reveal_all_matches_upstream_pixel_for_pixel() {
        let painted = |mut session: Session| -> Session {
            session.execute("layer.new.layer", json!({"name":"paint"})).unwrap();
            session
                .execute(
                    "paint.stroke",
                    json!({"points":[[4,5],[20,9],[33,25]],"size":3,"hardness":1,
                           "opacity":1,"flow":1,"color":"#ff0000","target":"pixels"}),
                )
                .unwrap();
            session
        };
        for (dx, dy) in [(-30, -20), (12, 9), (0, 0)] {
            let mut reference = painted(session(40, 30));
            reference.execute("edit.transform", json!({"dx":dx,"dy":dy})).unwrap();
            reference.execute("image.revealAll", json!({})).unwrap();

            let mut candidate = painted(session(40, 30));
            candidate.execute("edit.transform", json!({"dx":dx,"dy":dy})).unwrap();
            match prepare(&candidate, "revealAll", json!({})).unwrap() {
                Prepared::Command(command, params) => {
                    assert_eq!(command, "image.crop");
                    candidate.execute(command, params).unwrap();
                }
                // 内容仍在画布内：与上游一样什么都不做（0/0 这一组就是这种情况）。
                Prepared::Unchanged(result) => {
                    assert_eq!(result["changed"], false);
                    let bounds = photocraft_engine::extra_cmds::reveal_all_bounds(&candidate.active().unwrap().doc);
                    assert_eq!(bounds, candidate.active().unwrap().doc.bounds(), "只有并集等于画布时才能报无变化");
                }
            }

            let size = |s: &Session| s.active().unwrap().doc.size;
            assert_eq!(size(&reference), size(&candidate), "平移 {dx}/{dy} 后的画布尺寸");
            let pixels = |s: &Session| {
                let doc = s.active().unwrap().doc.clone();
                let area = doc.bounds();
                let mut out = vec![[0.0f32; 4]; (area.width() as usize) * (area.height() as usize)];
                for layer in &doc.layers {
                    if let Some(surface) = layer.surface() {
                        surface.read_rgba_into(area, &mut out);
                    }
                }
                out
            };
            for (a, b) in pixels(&reference).iter().zip(pixels(&candidate).iter()) {
                for k in 0..4 {
                    assert!((a[k] - b[k]).abs() < 1e-6, "平移 {dx}/{dy} 后像素不同：{a:?} vs {b:?}");
                }
            }
        }
        // 没有画布外内容时与上游一样返回 `changed:false`，**不写历史**（不能退化成一次空裁剪）。
        let plain = session(40, 30);
        let before = plain.active().unwrap().doc.size;
        let prepared = prepare(&plain, "revealAll", json!({})).unwrap();
        let Prepared::Unchanged(result) = prepared else { panic!("没有越界内容时不该提交裁剪") };
        assert_eq!(result["changed"], false);
        // 端到端：走 `Editor` 时历史与修订都不变。
        let mut editor = crate::editor::Editor::new();
        editor.execute("file.new", json!({"width":24,"height":18})).unwrap();
        let baseline = editor.state();
        editor.run_workflow("revealAll", json!({})).unwrap();
        assert_eq!(editor.state()["document"]["history"], baseline["document"]["history"]);
        assert_eq!(editor.state()["document"]["revision"], baseline["document"]["revision"]);
        assert_eq!(plain.active().unwrap().doc.size, before);
    }

    /// 再次变换：本域不再复制上游的可重复性判定，只把空参数交给 `edit.transform.again*`。
    ///
    /// 这条测试锁住「不本地重建」这个决定：没有历史变换时 `prepare` 依然编译成功，真正
    /// 「没有可重复的变换」由上游在执行时给出（错误码是命令失败，不是参数错误）。
    #[test]
    fn transform_again_delegates_repeatability_to_upstream() {
        let plain = session(40, 30);
        for id in ["transformAgain", "transformAgainCopy"] {
            let prepared = prepare(&plain, id, json!({})).unwrap();
            let Prepared::Command(command, params) = prepared else { panic!("{id} 应编译成命令") };
            assert_eq!(
                command,
                if id == "transformAgain" { "edit.transform.again" } else { "edit.transform.againCopy" }
            );
            assert_eq!(params, json!({}), "{id} 的参数应为空，重复逻辑由上游执行");
        }
        // 没有活动图层也照常编译：拒绝发生在内核执行时，而不是在参数编译阶段。
        let mut empty = session(40, 30);
        empty.active_mut().unwrap().active_layer = None;
        assert!(prepare(&empty, "transformAgain", json!({})).is_ok());
    }

    #[test]
    fn prepare_refuses_unknown_ids_and_keeps_the_command_gate() {
        let session = session(40, 30);
        assert!(prepare(&session, "nope", json!({})).is_err());
        // 已开放的命令编译成功，并返回对应上游 id。
        let prepared = prepare(&session, "crop", json!({"x":0,"y":0,"width":20,"height":10})).unwrap();
        let Prepared::Command(command, params) = prepared else { panic!("crop 应编译成命令") };
        assert_eq!(command, "image.crop");
        assert_eq!(params["width"], 20);
        let prepared = prepare(&session, "trim", json!({})).unwrap();
        let Prepared::Command(command, _) = prepared else { panic!("trim 应编译成命令") };
        assert_eq!(command, "image.trim");
        // 显示全部：有越界内容时落到已在白名单的 `image.crop`，否则报「无变化」。
        let mut spread = self::session(40, 30);
        spread.execute("edit.transform", json!({"dx":-50,"dy":-40})).unwrap();
        let prepared = prepare(&spread, "revealAll", json!({})).unwrap();
        let Prepared::Command(command, params) = prepared else { panic!("有越界内容时应裁剪") };
        assert_eq!(command, "image.crop");
        assert_eq!(params["deleteCroppedPixels"], false);
        // 命令门：现在 U50–U56 的 36 个内核入口都已开放，因此参数合法时不再报能力拒绝，
        // 而是真正编译出上游命令（前置条件不足时由上游/前置校验给出具体错误）。
        let empty = Session::new();
        assert!(prepare(&empty, "crop", json!({"x":0,"y":0,"width":1,"height":1})).is_err(), "无文档");
        for (id, params) in [
            ("perspectiveCrop", json!({"corners":[[0,0],[10,0],[10,10],[0,10]]})),
            ("rotateArbitrary", json!({"angle":10})),
            ("warp", json!({"style":"arc"})),
            ("photomerge", json!({"useOpenDocuments":true})),
        ] {
            let prepared = prepare(&session, id, params);
            let error = prepared.err();
            assert!(
                !matches!(error, Some(EditorError::CapabilityDisabled(_))),
                "{id} 不该再被能力门拒绝：{error:?}"
            );
        }
        // 非法参数仍然优先报参数错误。
        let error = prepare(&session, "perspectiveCrop", json!({"corners":[[0,0]]})).unwrap_err();
        assert!(matches!(error, EditorError::CommandFailed { .. }));
    }
}
