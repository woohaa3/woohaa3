//! P7：通道与通道计算的命令门、只读快照与有界预览
//! （change: 2026-10-22-add-photocraft-channel-workflows，U25/U26）。
//!
//! 事务规则（design D3）：
//! - 预览在一次性 [`photocraft_engine::Session`] 副本上计算：不改正式文档、修订、指纹或历史；
//! - 确认时用**当前**参数重跑同一条命令（只有一个历史步骤），因此不可能把旧预览提交成新内容；
//! - 非法参数在任何写入之前拒绝（混合、不透明度、输出目标、来源文档、未知字段）；
//! - 打开文档的数上限在任何创建新文档的命令（拆分/合并/复制到新文档/计算到新文档）前核对。
//!
//! 通道内容与元数据的规范表示始终是上游 `Document::channels`；本模块不复制第二套模型，
//! `channel_view`（目标与显隐）是会话查看态，不进入内容身份。
use serde_json::{Value, json};

use super::command_error;
use crate::editor::*;

/// 本域允许的命令（唯一写入清单；`Editor::execute` 另有全局限额门）。
///
/// 不含 `select.saveSelection` / `select.loadSelection`（选区域已开放）与
/// `select.editInQuickMaskMode`（快速蒙版由选区蒙版 change 负责）。
pub const CHANNEL_COMMANDS: &[&str] = &[
    "channel.new",
    "channel.newSpot",
    "channel.duplicate",
    "channel.delete",
    "channel.rename",
    "channel.move",
    "channel.target",
    "channel.setVisible",
    "channel.options",
    "channel.mergeSpot",
    "channel.split",
    "channel.merge",
    "channel.list",
    "image.applyImage",
    "image.calculations",
    "select.loadLuminosity",
];

/// 可预览的命令：其余命令是立即生效的结构/查看操作。
pub const CHANNEL_PREVIEW_COMMANDS: &[&str] = &["image.applyImage", "image.calculations"];

/// 通道名与来源名上限（与图层名同量级，避免无界字符串进入工程）。
const NAME_MAX: usize = 200;
/// 通道缩略图单边上限（面板行）。
const MAX_THUMBNAIL_SIDE: u32 = 256;

impl Editor {
    /// 通道命令统一入口：参数校验 → 无变化判定 → 预算核对 → 一次写入。
    ///
    /// 「无变化不新增历史」（design「事务和生命周期」）：改名到同一个名字、选项全部与当前值
    /// 相同、显隐/排序落到原值时，上游仍会 `edit()` 一步。这些请求在**写入之前**按当前状态
    /// 判定为无变化并直接返回，正式文档、修订与历史都不动。
    pub fn channel_command(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if !CHANNEL_COMMANDS.contains(&id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        let state = self.active_doc()?.clone();
        validate(id, &state.doc, &params)?;
        if let Some(unchanged) = self.unchanged_channel_command(id, &state, &params)? {
            return Ok(unchanged);
        }
        self.check_channel_document_budget(id, &state.doc, &params)?;
        self.session
            .execute(id, params)
            .map_err(|failure| command_error(id, failure))
    }

    /// 通道面板快照：通道行、目标、显隐与可用于应用图像/计算的来源文档。
    ///
    /// 目标与显隐来自上游查看态；`documentId`/`revision` 供界面丢弃晚到结果。
    pub fn channel_snapshot(&self) -> Result<Value> {
        let state = self.active_doc()?;
        let doc = &state.doc;
        let mut snapshot = photocraft_engine::channel_cmds::channels_json(state);
        let colors = photocraft_engine::channel_cmds::color_count(doc);
        let names = photocraft_engine::channel_cmds::color_names(doc.pixel_format().mode);
        snapshot["documentId"] = json!(doc.id.0);
        snapshot["revision"] = json!(state.revision);
        snapshot["savedRevision"] = json!(state.saved_revision);
        snapshot["activeIndex"] = json!(self.session.active_index());
        snapshot["canUndo"] = json!(state.history.can_undo());
        snapshot["canRedo"] = json!(state.history.can_redo());
        snapshot["hasSelection"] = json!(doc.selection.is_some());
        snapshot["quickMask"] = json!(doc.quick_mask.is_some());
        snapshot["spotCount"] = json!(doc.channels.iter().filter(|c| c.spot.is_some()).count());
        // 每个颜色行给出可直接回传的引用，避免界面重复实现通道引用语法。
        if let Some(rows) = snapshot.get_mut("colors").and_then(Value::as_array_mut) {
            for (k, row) in rows.iter_mut().enumerate() {
                row["index"] = json!(k);
                row["reference"] = if colors > 1 { json!({ "color": k }) } else { json!("composite") };
                row["name"] = json!(names.get(k).copied().unwrap_or("Gray"));
            }
        } else {
            let rows: Vec<Value> = (0..colors)
                .map(|k| json!({
                    "index": k,
                    "name": names.get(k).copied().unwrap_or("Gray"),
                    "visible": true,
                    "reference": if colors > 1 { json!({ "color": k }) } else { json!("composite") },
                }))
                .collect();
            snapshot["colors"] = json!(rows);
        }
        if let Some(rows) = snapshot.get_mut("alpha").and_then(Value::as_array_mut) {
            for (i, row) in rows.iter_mut().enumerate() {
                row["reference"] = json!({ "alpha": i });
                row["kind"] = json!(if row["spot"].is_null() { "alpha" } else { "spot" });
            }
        }
        let active_index = self.session.active_index();
        let documents: Vec<Value> = self
            .session
            .documents()
            .iter()
            .enumerate()
            .map(|(index, other)| {
                // 每份文档自报可选来源通道，界面因此能在非活动文档上选分量/Alpha，
                // 不必先切文档（切换会丢目标与草稿）。只给引用与名字，不带像素。
                let colors = photocraft_engine::channel_cmds::color_count(&other.doc);
                let names = photocraft_engine::channel_cmds::color_names(other.doc.pixel_format().mode);
                let alpha: Vec<Value> = other
                    .doc
                    .channels
                    .iter()
                    .enumerate()
                    .map(|(i, channel)| json!({
                        "index": i,
                        "name": channel.name,
                        "kind": if channel.spot.is_some() { "spot" } else { "alpha" },
                    }))
                    .collect();
                json!({
                    "index": index,
                    "name": other.doc.name,
                    "width": other.doc.size.width,
                    "height": other.doc.size.height,
                    "grayscale": other.doc.mode == photocraft_color::ColorMode::Grayscale,
                    "sameSize": other.doc.size == doc.size,
                    "active": active_index == Some(index),
                    "colorCount": colors,
                    "colorNames": names,
                    "alpha": alpha,
                })
            })
            .collect();
        snapshot["documents"] = json!(documents);
        snapshot["maxOpenDocuments"] = json!(photocraft_project_verify::limits::MAX_OPEN_DOCUMENTS);
        Ok(snapshot)
    }

    /// 单个通道（或复合、图层蒙版、选区）的有界缩略图；只读。
    pub fn channel_thumbnail(&self, reference: Value, max_side: u32) -> Result<Preview> {
        let state = self.active_doc()?;
        match self.channel_plane(state, &reference)? {
            Plane::Composite => Ok(thumbnail_preview(&state.doc, max_side.clamp(1, MAX_THUMBNAIL_SIDE))),
            Plane::Gray { surface, channel } => {
                Ok(gray_preview(surface, channel, state.doc.size, max_side.clamp(1, MAX_THUMBNAIL_SIDE)))
            }
        }
    }

    /// 通道视图预览：单通道目标显示该分量灰度，复合目标显示合成结果。
    ///
    /// 主画布的单通道着色由共享预览管线负责（本域不能改），因此面板给出一份有界视图，
    /// 目标与查看仍然分离：这里只跟随查看，不改变编辑目标。
    pub fn channel_view_preview(&self, max_side: u32) -> Result<Preview> {
        use photocraft_engine::channel_cmds::{ChannelTarget, color_count};
        let state = self.active_doc()?;
        let max_side = max_side.clamp(1, MAX_PREVIEW_SIDE);
        let target = state.channel_view.target;
        let reference = match target {
            ChannelTarget::Color(k) if k < color_count(&state.doc) => json!({ "color": k }),
            ChannelTarget::Alpha(i) if i < state.doc.channels.len() => json!({ "alpha": i }),
            ChannelTarget::LayerMask => json!("mask"),
            ChannelTarget::Composite if state.doc.quick_mask.is_some() && !state.channel_view.quick_mask_hidden => {
                json!("quickMask")
            }
            _ => json!("composite"),
        };
        match self.channel_plane(state, &reference)? {
            Plane::Composite => Ok(thumbnail_preview(&state.doc, max_side)),
            Plane::Gray { surface, channel } => Ok(gray_preview(surface, channel, state.doc.size, max_side)),
        }
    }

    /// 通道计算（应用图像/计算）的隔离预览：在会话副本上跑一次，返回预览与候选状态。
    ///
    /// 正式文档、修订、指纹与历史都不变；确认由 [`Editor::channel_command`] 用当前参数
    /// 重新执行一次，因此旧预览不可能被当作新内容提交。
    pub fn channel_calc_preview(&self, id: &str, params: Value, max_side: u32) -> Result<(Preview, Value)> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if !CHANNEL_PREVIEW_COMMANDS.contains(&id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        let active = self.active_doc()?;
        validate(id, &active.doc, &params)?;
        let scratch = self.scratch_session();
        let before_revision = scratch.active().map(|state| state.revision);
        let mut scratch = scratch;
        scratch
            .execute(id, params.clone())
            .map_err(|failure| command_error(id, failure))?;
        let state = scratch.active().ok_or(EditorError::NoDocument)?;
        let preview = calc_preview_document(id, &params, state, max_side.clamp(1, MAX_PREVIEW_SIDE));
        let changed = before_revision.is_some_and(|before| state.revision != before);
        let summary = json!({
            "command": id,
            "documentId": state.doc.id.0,
            "revision": state.revision,
            "revisionChanged": changed,
            "channels": photocraft_engine::channel_cmds::channels_json(state),
            "documents": scratch.documents().len(),
        });
        Ok((preview, summary))
    }

    /// 完整会话副本：来源文档索引与目标一致，跨文档计算因此可预览。
    fn scratch_session(&self) -> photocraft_engine::Session {
        let mut scratch = photocraft_engine::Session::new();
        for state in self.session.documents() {
            scratch.add_document((*state.doc).clone(), state.path.clone());
            if let Some(active) = scratch.active_mut() {
                *active = state.clone();
            }
        }
        if let Some(index) = self.session.active_index() {
            scratch.set_active(index);
        }
        scratch
    }

    /// 通道引用 → 可采样的灰度平面（复合返回 `Composite`，直接走合成缩略图）。
    fn channel_plane<'a>(
        &self,
        state: &'a photocraft_engine::DocState,
        reference: &Value,
    ) -> Result<Plane<'a>> {
        use photocraft_engine::channel_cmds::{ChanRef, color_count, parse_ref};
        let doc = &state.doc;
        let parsed = parse_ref(reference, doc)
            .ok_or_else(|| command_error("channel.thumbnail", "未知的通道引用"))?;
        match parsed {
            ChanRef::Composite => {
                if color_count(doc) <= 1 {
                    // 灰度文档的复合通道就是唯一分量。
                    let layer = state
                        .active_layer
                        .and_then(|id| doc.layer(id))
                        .and_then(|layer| layer.surface())
                        .ok_or_else(|| command_error("channel.thumbnail", "活动图层没有像素"))?;
                    Ok(Plane::Gray { surface: layer, channel: 0 })
                } else {
                    Ok(Plane::Composite)
                }
            }
            ChanRef::Color(k) => {
                let layer = state
                    .active_layer
                    .and_then(|id| doc.layer(id))
                    .and_then(|layer| layer.surface())
                    .ok_or_else(|| command_error("channel.thumbnail", "活动图层没有像素，无法查看分量"))?;
                if k >= layer.channels() {
                    return Err(command_error("channel.thumbnail", "该图层没有这个颜色分量"));
                }
                Ok(Plane::Gray { surface: layer, channel: k })
            }
            ChanRef::Alpha(i) => {
                let channel = doc
                    .channels
                    .get(i)
                    .ok_or_else(|| command_error("channel.thumbnail", "通道不存在"))?;
                Ok(Plane::Gray { surface: &channel.surface, channel: 0 })
            }
            ChanRef::LayerMask => {
                let mask = state
                    .active_layer
                    .and_then(|id| doc.layer(id))
                    .and_then(|layer| layer.mask.as_ref())
                    .ok_or_else(|| command_error("channel.thumbnail", "活动图层没有图层蒙版"))?;
                Ok(Plane::Gray { surface: &mask.surface, channel: 0 })
            }
            ChanRef::Selection => {
                let selection = doc
                    .selection
                    .as_ref()
                    .ok_or_else(|| command_error("channel.thumbnail", "没有活动选区"))?;
                Ok(Plane::Gray { surface: selection, channel: 0 })
            }
            ChanRef::QuickMask => {
                let quick = doc
                    .quick_mask
                    .as_ref()
                    .ok_or_else(|| command_error("channel.thumbnail", "当前不在快速蒙版模式"))?;
                Ok(Plane::Gray { surface: &quick.surface, channel: 0 })
            }
            ChanRef::Transparency => {
                let layer = state
                    .active_layer
                    .and_then(|id| doc.layer(id))
                    .and_then(|layer| layer.surface())
                    .ok_or_else(|| command_error("channel.thumbnail", "活动图层没有像素"))?;
                let alpha = layer.channels().checked_sub(1).filter(|_| layer.format().alpha);
                let channel = alpha.ok_or_else(|| command_error("channel.thumbnail", "活动图层没有透明度分量"))?;
                Ok(Plane::Gray { surface: layer, channel })
            }
            ChanRef::VectorMask => Err(command_error(
                "channel.thumbnail",
                "矢量蒙版缩略图需要共享栅格化端口（由集成负责人接入）",
            )),
        }
    }

    /// 创建新文档的命令先核对「同时打开文档数」预算（运行政策，不写进工程）。
    fn check_channel_document_budget(
        &self,
        id: &str,
        doc: &photocraft_doc::Document,
        params: &Value,
    ) -> Result<()> {
        let (add, remove) = match id {
            "channel.split" => {
                let created = photocraft_engine::channel_cmds::color_count(doc) + doc.channels.len();
                let close = params
                    .get("closeOriginal")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                (created, usize::from(close))
            }
            "channel.duplicate" if params.get("document").and_then(Value::as_str) == Some("new") => (1, 0),
            "image.calculations" if params.get("result").and_then(Value::as_str) == Some("newDocument") => (1, 0),
            _ => (0, 0),
        };
        if add == 0 {
            return Ok(());
        }
        let current = self.session.documents().len();
        let projected = current.saturating_sub(remove).saturating_add(add);
        let limit = photocraft_project_verify::limits::MAX_OPEN_DOCUMENTS;
        if projected > limit {
            return Err(command_error(
                id,
                format!("同时打开的文档不能超过 {limit} 个（当前 {current}，本次将增加到 {projected}）"),
            ));
        }
        Ok(())
    }

    /// 「无变化」判定：返回 `Some(结果)` 时调用方跳过写入，正式修订与历史都不动。
    ///
    /// 只覆盖能**按当前状态精确判定**的命令；像素级合成（应用图像/计算）不做相等比较，
    /// 它们的不透明度/混合会被上游按真实算法写入。
    fn unchanged_channel_command(
        &self,
        id: &str,
        state: &photocraft_engine::DocState,
        params: &Value,
    ) -> Result<Option<Value>> {
        let doc = &state.doc;
        let unchanged = match id {
            "channel.rename" => {
                let Some(channel) = referenced_alpha(doc, params)? else {
                    return Ok(None);
                };
                // 上游 `channel.rename` 先 trim 再写入；判定用同一份规范化文本。
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                channel.name == name
            }
            "channel.options" => {
                let Some(channel) = referenced_alpha(doc, params)? else {
                    return Ok(None);
                };
                options_unchanged(id, channel, params)?
            }
            // 显隐与排序落到原值时上游本来就不写；这里只让语义显式，行为交由上游。
            _ => false,
        };
        if !unchanged {
            return Ok(None);
        }
        // 返回与上游同形的结果（`channel.rename` 是 null；`channel.options` 是面板快照）。
        Ok(Some(match id {
            "channel.rename" => Value::Null,
            _ => photocraft_engine::channel_cmds::channels_json(state),
        }))
    }
}

/// 命中的 Alpha/专色行（`channel` 引用解析为数组项时）。
fn referenced_alpha<'a>(
    doc: &'a photocraft_doc::Document,
    params: &Value,
) -> Result<Option<&'a photocraft_doc::AlphaChannel>> {
    let Some(reference) = params.get("channel") else {
        return Ok(None);
    };
    match photocraft_engine::channel_cmds::parse_ref(reference, doc) {
        Some(photocraft_engine::channel_cmds::ChanRef::Alpha(index)) => {
            Ok(doc.channels.get(index))
        }
        _ => Ok(None),
    }
}

/// `channel.options` 的逐字段判定（与上游 `apply` 的赋值顺序一一对应）。
///
/// 上游把 `indicates:"spot"` 当作「转成专色」，因此那一支永远算变化（结构不同）。
fn options_unchanged(
    id: &str,
    channel: &photocraft_doc::AlphaChannel,
    params: &Value,
) -> Result<bool> {
    let text = |key: &str| params.get(key).and_then(Value::as_str).map(str::trim);
    if params
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| channel.name != name.trim())
    {
        return Ok(false);
    }
    let percent = |key: &str| -> Result<Option<f32>> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_f64()
                .map(|value| Some((value as f32 / 100.0).clamp(0.0, 1.0)))
                .ok_or_else(|| command_error(id, format!("{key} 必须在 0–100 之间"))),
        }
    };
    let opacity = percent("opacity")?;
    let solidity = percent("solidity")?;
    let color = params
        .get("color")
        .and_then(Value::as_str)
        .map(hex_rgb);
    match text("indicates") {
        // 转成专色（或给出未知值）时结构会变，交给上游判定与报错。
        Some("spot") => return Ok(false),
        // 专色行给出「表示」= 转回 Alpha（上游把 `spot` 清空），同样是结构变化。
        Some(_) if channel.spot.is_some() => return Ok(false),
        Some(name @ ("masked" | "maskedAreas" | "selected" | "selectedAreas")) => {
            let expected = if name.starts_with("selected") {
                photocraft_doc::ColorIndicates::SelectedAreas
            } else {
                photocraft_doc::ColorIndicates::MaskedAreas
            };
            if channel.indicates != expected {
                return Ok(false);
            }
        }
        Some(_) => return Ok(false),
        None => {}
    }
    match channel.spot {
        Some((ink, solidity_now)) => {
            if color.is_some_and(|color| color != ink.to_rgb()) {
                return Ok(false);
            }
            // 专色行的「不透明度」按上游写法落在密度上。
            if solidity.or(opacity).is_some_and(|value| value != solidity_now) {
                return Ok(false);
            }
        }
        None => {
            if color.is_some_and(|color| color != channel.color.to_rgb()) {
                return Ok(false);
            }
            if opacity.is_some_and(|value| value != channel.opacity) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// `#rrggbb` → 归一化 RGB，与上游 `commands::parse_hex` 一致。
fn hex_rgb(text: &str) -> [f32; 3] {
    let byte = |index: usize| {
        u8::from_str_radix(&text[index..index + 2], 16).map_or(0.0, |value| f32::from(value) / 255.0)
    };
    [byte(1), byte(3), byte(5)]
}


/// 通道引用解析结果：复合合成，或某个可采样的灰度分量。
enum Plane<'a> {
    Composite,
    Gray {
        surface: &'a photocraft_doc::Surface,
        channel: usize,
    },
}

/// 合成缩略图（行优先 RGBA8，直通 alpha）。
fn thumbnail_preview(doc: &photocraft_doc::Document, max_side: u32) -> Preview {
    let image = photocraft_compose::thumbnail(doc, max_side);
    Preview { width: image.width, height: image.height, pixels: image.pixels }
}

/// 灰度分量预览：按输出宽度逐行跨步采样，成本与输出像素数同阶（不复制整幅画布）。
fn gray_preview(
    surface: &photocraft_doc::Surface,
    channel: usize,
    size: photocraft_doc::Size,
    max_side: u32,
) -> Preview {
    let (width, height) = scaled_size(size, max_side);
    let step_x = (size.width / width).max(1);
    let step_y = (size.height / height).max(1);
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    let mut row = vec![0.0f32; width as usize];
    for y in 0..height {
        surface.sample_row_strided((y * step_y).min(size.height.saturating_sub(1)) as i32, 0, step_x as i32, channel, &mut row);
        for value in &row {
            let gray = (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            pixels.extend_from_slice(&[gray, gray, gray, 255]);
        }
    }
    Preview { width, height, pixels }
}

/// 保比缩放后的输出尺寸（至少 1×1）。
fn scaled_size(size: photocraft_doc::Size, max_side: u32) -> (u32, u32) {
    let longest = size.width.max(size.height).max(1);
    let scale = (max_side as f32 / longest as f32).min(1.0);
    (
        ((size.width as f32 * scale).round() as u32).max(1),
        ((size.height as f32 * scale).round() as u32).max(1),
    )
}

/// 预览要显示的候选内容：输出目标决定看哪一份平面。
fn calc_preview_document(
    id: &str,
    params: &Value,
    state: &photocraft_engine::DocState,
    max_side: u32,
) -> Preview {
    if id == "image.calculations" {
        match params.get("result").and_then(Value::as_str).unwrap_or("newChannel") {
            "selection" => {
                if let Some(selection) = state.doc.selection.as_ref() {
                    return gray_preview(selection, 0, state.doc.size, max_side);
                }
            }
            "newChannel" => {
                if let Some(channel) = state.doc.channels.last() {
                    return gray_preview(&channel.surface, 0, state.doc.size, max_side);
                }
            }
            _ => {}
        }
        return thumbnail_preview(&state.doc, max_side);
    }
    // 应用图像：目标是被写入的通道或图层，预览按该目标显示。
    match params.get("target") {
        Some(Value::Object(object)) if object.contains_key("channel") => {
            if let Some(index) = object.get("channel").and_then(Value::as_u64)
                && let Some(channel) = state.doc.channels.get(index as usize)
            {
                return gray_preview(&channel.surface, 0, state.doc.size, max_side);
            }
        }
        Some(Value::String(name)) if name == "mask" => {
            if let Some(mask) = state
                .active_layer
                .and_then(|layer| state.doc.layer(layer))
                .and_then(|layer| layer.mask.as_ref())
            {
                return gray_preview(&mask.surface, 0, state.doc.size, max_side);
            }
        }
        _ => {}
    }
    // 目标为复合或颜色分量时看合成（颜色分量的隔离视图由通道面板单独给出）。
    thumbnail_preview(&state.doc, max_side)
}

// ---------------------------------------------------------------------------------------------
// 参数校验

/// 命令的允许字段与类型；未知字段直接拒绝，避免拼写错误静默写入。
fn validate(id: &str, doc: &photocraft_doc::Document, params: &Value) -> Result<()> {
    let object = match (id, params) {
        ("channel.list" | "select.loadLuminosity", Value::Object(map)) if map.is_empty() => return Ok(()),
        ("channel.list", Value::Null) | ("select.loadLuminosity", Value::Null) => return Ok(()),
        ("channel.delete" | "channel.mergeSpot" | "channel.split", Value::Null) => return Ok(()),
        (_, Value::Object(map)) => map,
        _ => return Err(command_error(id, "参数必须是对象")),
    };
    let allowed: &[&str] = match id {
        "channel.new" => &["name", "fill", "color", "opacity", "indicates"],
        "channel.newSpot" => &["name", "color", "solidity", "fromSelection"],
        "channel.duplicate" => &["channel", "name", "document", "invert"],
        "channel.delete" => &["channel"],
        "channel.rename" => &["channel", "name"],
        "channel.move" => &["channel", "to"],
        "channel.target" => &["channel"],
        "channel.setVisible" => &["channel", "visible"],
        "channel.options" => &["channel", "name", "indicates", "color", "opacity", "solidity"],
        "channel.mergeSpot" => &["channel"],
        "channel.split" => &["closeOriginal"],
        "channel.merge" => &["mode", "documents", "name"],
        "select.loadLuminosity" => &[],
        "channel.list" => &[],
        "image.applyImage" => &[
            "source",
            "sourceDocument",
            "sourceLayer",
            "sourceChannel",
            "sourceInvert",
            "mask",
            "maskDocument",
            "maskLayer",
            "maskChannel",
            "maskInvert",
            "blending",
            "opacity",
            "scale",
            "offset",
            "preserveTransparency",
            "target",
        ],
        "image.calculations" => &[
            "source1",
            "source1Document",
            "source1Layer",
            "source1Channel",
            "source1Invert",
            "source2",
            "source2Document",
            "source2Layer",
            "source2Channel",
            "source2Invert",
            "mask",
            "maskDocument",
            "maskLayer",
            "maskChannel",
            "maskInvert",
            "blending",
            "opacity",
            "scale",
            "offset",
            "result",
            "name",
        ],
        _ => return Err(EditorError::CapabilityDisabled(id.into())),
    };
    if let Some(unknown) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(command_error(id, format!("不支持的参数：{unknown}")));
    }
    match id {
        "channel.new" => {
            name_param(id, object.get("name"))?;
            enum_param(id, "fill", object.get("fill"), &["black", "white", "selection"])?;
            enum_param(id, "indicates", object.get("indicates"), &["masked", "selected", "maskedAreas", "selectedAreas"])?;
            color_param(id, object.get("color"))?;
            percent_param(id, "opacity", object.get("opacity"))?;
        }
        "channel.newSpot" => {
            name_param(id, object.get("name"))?;
            color_param(id, object.get("color"))?;
            percent_param(id, "solidity", object.get("solidity"))?;
            bool_param(id, "fromSelection", object.get("fromSelection"))?;
        }
        "channel.duplicate" => {
            channel_ref_param(id, doc, object.get("channel"), false)?;
            name_param(id, object.get("name"))?;
            bool_param(id, "invert", object.get("invert"))?;
            match object.get("document") {
                None | Some(Value::Null) => {}
                Some(Value::String(text)) if text == "new" => {}
                Some(value) => {
                    let index = value
                        .as_u64()
                        .ok_or_else(|| command_error(id, "document 必须是索引或 \"new\""))?;
                    if index as usize >= photocraft_project_verify::limits::MAX_OPEN_DOCUMENTS {
                        return Err(command_error(id, "document 索引超出同时打开文档上限"));
                    }
                }
            }
        }
        "channel.delete" | "channel.mergeSpot" => {
            channel_ref_param(id, doc, object.get("channel"), false)?;
        }
        "channel.rename" => {
            channel_ref_param(id, doc, object.get("channel"), true)?;
            if name_param(id, object.get("name"))?.is_none() {
                return Err(command_error(id, "缺少通道名"));
            }
        }
        "channel.move" => {
            channel_ref_param(id, doc, object.get("channel"), true)?;
            let to = object
                .get("to")
                .and_then(Value::as_u64)
                .ok_or_else(|| command_error(id, "缺少目标位置 to"))?;
            if to as usize >= doc.channels.len() {
                return Err(command_error(id, "目标位置超出通道数"));
            }
        }
        "channel.target" => {
            let reference = object
                .get("channel")
                .ok_or_else(|| command_error(id, "缺少 channel"))?;
            let parsed = photocraft_engine::channel_cmds::parse_ref(reference, doc)
                .ok_or_else(|| command_error(id, "未知的通道引用"))?;
            if parsed == photocraft_engine::channel_cmds::ChanRef::QuickMask {
                return Err(command_error(id, "快速蒙版目标由选区蒙版 change 负责，本域不开放"));
            }
            if parsed == photocraft_engine::channel_cmds::ChanRef::VectorMask {
                return Err(command_error(id, "矢量蒙版目标暂未接入共享端口"));
            }
        }
        "channel.setVisible" => {
            channel_ref_param(id, doc, object.get("channel"), false)?;
            bool_param(id, "visible", object.get("visible"))?;
        }
        "channel.options" => {
            channel_ref_param(id, doc, object.get("channel"), false)?;
            name_param(id, object.get("name"))?;
            enum_param(id, "indicates", object.get("indicates"), &["masked", "selected", "spot", "maskedAreas", "selectedAreas"])?;
            color_param(id, object.get("color"))?;
            percent_param(id, "opacity", object.get("opacity"))?;
            percent_param(id, "solidity", object.get("solidity"))?;
        }
        "channel.split" => {
            bool_param(id, "closeOriginal", object.get("closeOriginal"))?;
        }
        "channel.merge" => {
            // 只开放 RGB：CMYK/Lab 属于 `NON_GOAL` 的多色彩管理与印刷分色，本域不提供。
            match object.get("mode").and_then(Value::as_str) {
                None | Some("rgb") => {}
                Some(mode @ ("cmyk" | "lab")) => {
                    return Err(command_error(
                        id,
                        format!("mode 不支持 {mode}：CMYK/Lab 属于多色彩管理与印刷分色，本域只合成 RGB"),
                    ));
                }
                Some(other) => return Err(command_error(id, format!("mode 不支持 {other}"))),
            }
            name_param(id, object.get("name"))?;
            if let Some(list) = object.get("documents") {
                let list = list
                    .as_array()
                    .ok_or_else(|| command_error(id, "documents 必须是索引数组"))?;
                if list.len() > photocraft_project_verify::limits::MAX_OPEN_DOCUMENTS {
                    return Err(command_error(id, "来源文档数量超过上限"));
                }
                let mut seen = std::collections::HashSet::new();
                for entry in list {
                    let index = entry
                        .as_u64()
                        .ok_or_else(|| command_error(id, "documents 必须是索引数组"))?;
                    if !seen.insert(index) {
                        return Err(command_error(id, format!("文档 {index} 重复列出")));
                    }
                }
            }
        }
        "image.applyImage" => {
            source_param(id, object.get("source"))?;
            source_param(id, object.get("mask"))?;
            flat_source_params(id, object)?;
            blending_param(id, params)?;
            percent_param(id, "opacity", object.get("opacity"))?;
            scale_offset_params(id, object)?;
            bool_param(id, "preserveTransparency", object.get("preserveTransparency"))?;
            apply_target_param(id, doc, object.get("target"))?;
        }
        "image.calculations" => {
            source_param(id, object.get("source1"))?;
            source_param(id, object.get("source2"))?;
            source_param(id, object.get("mask"))?;
            flat_source_params(id, object)?;
            blending_param(id, params)?;
            percent_param(id, "opacity", object.get("opacity"))?;
            scale_offset_params(id, object)?;
            enum_param(id, "result", object.get("result"), &["newChannel", "newDocument", "selection"])?;
            name_param(id, object.get("name"))?;
        }
        _ => {}
    }
    Ok(())
}

/// 平坦写法的来源字段（`sourceDocument`/`maskChannel`…）类型与范围。
fn flat_source_params(id: &str, object: &serde_json::Map<String, Value>) -> Result<()> {
    for (key, value) in object {
        let is_document = key.ends_with("Document");
        let is_layer = key.ends_with("Layer");
        let is_channel = key.ends_with("Channel");
        let is_invert = key.ends_with("Invert");
        if !(is_document || is_layer || is_channel || is_invert) {
            continue;
        }
        match (is_document, is_layer, is_channel, is_invert, value) {
            (true, _, _, _, Value::Number(number)) if number.as_u64().is_some() => {}
            (_, true, _, _, Value::Number(number)) if number.as_u64().is_some() => {}
            (_, true, _, _, Value::String(text)) if text.len() <= NAME_MAX => {}
            (_, _, true, _, Value::String(text)) if text.len() <= NAME_MAX => {}
            (_, _, true, _, Value::Number(number)) if number.as_u64().is_some() => {}
            (_, _, _, true, Value::Bool(_)) => {}
            (_, _, _, _, Value::Null) => {}
            _ => return Err(command_error(id, format!("参数 {key} 的类型非法"))),
        }
    }
    Ok(())
}

/// 来源描述 `{document?,layer?,channel?,invert?}`（或 `false`/`null` 表示无蒙版）。
fn source_param(id: &str, value: Option<&Value>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    match value {
        Value::Null | Value::Bool(false) => Ok(()),
        Value::Object(map) => {
            for key in map.keys() {
                if !["document", "layer", "channel", "invert"].contains(&key.as_str()) {
                    return Err(command_error(id, format!("来源里不支持字段 {key}")));
                }
            }
            if let Some(document) = map.get("document")
                && document.as_u64().is_none()
            {
                return Err(command_error(id, "来源 document 必须是非负整数"));
            }
            if let Some(layer) = map.get("layer") {
                let ok = layer.as_u64().is_some()
                    || layer.as_str().is_some_and(|text| !text.is_empty() && text.len() <= NAME_MAX);
                if !ok {
                    return Err(command_error(id, "来源 layer 必须是图层 id 或名称"));
                }
            }
            if let Some(channel) = map.get("channel") {
                let ok = channel.as_u64().is_some()
                    || channel.as_str().is_some_and(|text| !text.is_empty() && text.len() <= NAME_MAX)
                    || channel.as_object().is_some_and(|object| object.len() == 1);
                if !ok {
                    return Err(command_error(id, "来源 channel 必须是通道名、索引或 {color|alpha}"));
                }
            }
            if let Some(invert) = map.get("invert")
                && !invert.is_boolean()
            {
                return Err(command_error(id, "来源 invert 必须是布尔值"));
            }
            Ok(())
        }
        _ => Err(command_error(id, "来源必须是对象、false 或 null")),
    }
}

/// 混合模式与 scale/offset 由上游同一份解析校验（Add/Subtract 也在这里）。
fn blending_param(id: &str, params: &Value) -> Result<()> {
    photocraft_engine::channel_cmds::Blending::parse(params).map_err(|message| command_error(id, message))?;
    Ok(())
}

fn scale_offset_params(id: &str, object: &serde_json::Map<String, Value>) -> Result<()> {
    if let Some(scale) = object.get("scale") {
        let value = scale
            .as_f64()
            .filter(|value| value.is_finite() && (1.0..=2.0).contains(value))
            .ok_or_else(|| command_error(id, "scale 必须在 1–2 之间"))?;
        let _ = value;
    }
    if let Some(offset) = object.get("offset") {
        offset
            .as_f64()
            .filter(|value| value.is_finite() && (-255.0..=255.0).contains(value))
            .ok_or_else(|| command_error(id, "offset 必须在 -255–255 之间"))?;
    }
    Ok(())
}

/// 应用图像的目标：图层像素或某个 Alpha/专色通道。
///
/// **图层蒙版目标明确拒绝**：上游 `image.applyImage` 只把结果写进图层像素（`paint_surface`
/// 用固定的非蒙版目标），传 `"mask"` 会静默改像素。与其错写目标，这里在写入前拒绝并说明
/// 原因；接上蒙版目标需要共享端口，属集成负责人的后续工作。
fn apply_target_param(id: &str, doc: &photocraft_doc::Document, value: Option<&Value>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    match value {
        Value::Null => Ok(()),
        Value::String(text) if text == "mask" => Err(command_error(
            id,
            "应用图像暂不支持图层蒙版目标：内核只写图层像素，蒙版目标需共享端口接入",
        )),
        Value::String(text) => Err(command_error(
            id,
            format!("应用图像不支持目标 {text}（快速蒙版由选区蒙版 change 负责）"),
        )),
        Value::Object(map) => {
            if map.keys().any(|key| key != "channel") {
                return Err(command_error(id, "目标只支持 {channel}"));
            }
            let index = map
                .get("channel")
                .and_then(Value::as_u64)
                .ok_or_else(|| command_error(id, "目标 channel 必须是索引"))?;
            if index as usize >= doc.channels.len() {
                return Err(command_error(id, "目标通道不存在"));
            }
            Ok(())
        }
        _ => Err(command_error(id, "目标必须是 {channel}")),
    }
}

fn channel_ref_param(
    id: &str,
    doc: &photocraft_doc::Document,
    value: Option<&Value>,
    required: bool,
) -> Result<()> {
    let Some(value) = value else {
        return if required {
            Err(command_error(id, "缺少 channel"))
        } else {
            Ok(())
        };
    };
    let parsed = photocraft_engine::channel_cmds::parse_ref(value, doc)
        .ok_or_else(|| command_error(id, "未知的通道引用"))?;
    if matches!(parsed, photocraft_engine::channel_cmds::ChanRef::QuickMask) {
        return Err(command_error(id, "快速蒙版由选区蒙版 change 负责，本域不开放"));
    }
    if matches!(parsed, photocraft_engine::channel_cmds::ChanRef::VectorMask) {
        return Err(command_error(id, "矢量蒙版暂未接入共享端口"));
    }
    Ok(())
}

fn name_param(id: &str, value: Option<&Value>) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let text = value
        .as_str()
        .ok_or_else(|| command_error(id, "名称必须是字符串"))?
        .trim();
    if text.chars().count() > NAME_MAX {
        return Err(command_error(id, format!("名称不能超过 {NAME_MAX} 个字符")));
    }
    Ok(Some(text.to_string()))
}

fn enum_param(id: &str, key: &str, value: Option<&Value>, allowed: &[&str]) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    if value.is_null() {
        return Ok(());
    }
    match value.as_str() {
        Some(text) if allowed.contains(&text) => Ok(()),
        Some(text) => Err(command_error(id, format!("{key} 不支持 {text}"))),
        None => Err(command_error(id, format!("{key} 必须是字符串"))),
    }
}

fn color_param(id: &str, value: Option<&Value>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    if value.is_null() {
        return Ok(());
    }
    let text = value
        .as_str()
        .ok_or_else(|| command_error(id, "颜色必须是 #rrggbb"))?;
    let bytes = text.as_bytes();
    let valid = text.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(u8::is_ascii_hexdigit);
    if !valid {
        return Err(command_error(id, "颜色必须是 #rrggbb"));
    }
    Ok(())
}

fn percent_param(id: &str, key: &str, value: Option<&Value>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    if value.is_null() {
        return Ok(());
    }
    value
        .as_f64()
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
        .ok_or_else(|| command_error(id, format!("{key} 必须在 0–100 之间")))?;
    Ok(())
}

fn bool_param(id: &str, key: &str, value: Option<&Value>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    if value.is_null() {
        return Ok(());
    }
    if !value.is_boolean() {
        return Err(command_error(id, format!("{key} 必须是布尔值")));
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
