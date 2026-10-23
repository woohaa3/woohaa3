//! U58–U62、U64：图层链接/标签/建层/盖印、粘贴入与外、高级混合、样式与效果、去边、图层复合。
//!
//! 所有写入都复用固定上游命令，本模块统一提供三件事：
//! - 写入前的域内校验（参数形状、目标层类型、锁定、预算、选区/剪贴板/复合前置）；
//! - `preview_*` 在隔离会话上算候选文档并只返回合成像素，正式修订/指纹/历史不变；
//! - `apply_*` 重新校验**最新**输入后一步提交，无变化不增历史。
//!
//! 预览结果不进入内核状态，因此不存在「确认上一份成功预览」的路径：宿主按代际丢弃晚到预览。
use std::sync::Arc;

use photocraft_doc::{Document, Knockout, LayerContent, LayerId};
use photocraft_engine::{DocState, Session};
use serde_json::{Value, json};

use crate::error::{EditorError, Result};

/// 预览最长边（与其它域草稿同级，避免整幅画布回传）。
const PREVIEW_SIDE: u32 = 1024;

fn error(id: &str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

/// 图层链接/标签/建层/盖印（U58）。
pub(crate) const LINK_IDS: [&str; 6] = [
    "layer.linkLayers",
    "layer.selectLinkedLayers",
    "layer.setLabelColor",
    "layer.arrange.reverse",
    "layer.new.layerViaCut",
    "layer.stampVisible",
];
/// 盖印向下与背景互转也在本组（菜单项分别在不同上级菜单）。
///
/// 背景互转的上游 id 是 `layer.new.*` 命名空间（`Layer ▸ New ▸ …`），
/// 写成 `layer.layerFromBackground` / `layer.backgroundFromLayer` 会命中不了注册表：
/// 那种 id 既不会被命令门放行，`check` 也永远不会被调用。
pub(crate) const MERGE_IDS: [&str; 3] = [
    "layer.stampDown",
    "layer.new.layerFromBackground",
    "layer.new.backgroundFromLayer",
];
/// 粘贴入/粘贴外（U59）。
pub(crate) const PASTE_IDS: [&str; 2] = ["edit.pasteSpecial.pasteInto", "edit.pasteSpecial.pasteOutside"];
/// 高级混合、Blend If、挖空（U60）。
pub(crate) const BLEND_IDS: [&str; 1] = ["layer.layerStyle.blendingOptions"];
/// 样式复制/预设管理与效果转换（U61）。
///
/// 预设管理（`list`/`new`/`edit`/`reset`）与 `apply` 同属 U61 的「样式预设管理」：
/// 只有 `apply` 时面板无法列出、保存或整理预设，上游已有的管理能力不可达。
pub(crate) const STYLE_IDS: [&str; 14] = [
    "layer.layerStyle.copyLayerStyle",
    "layer.layerStyle.pasteLayerStyle",
    "layer.layerStyle.clear",
    "layer.layerStyle.scaleEffects",
    "layer.layerStyle.createLayer",
    "layer.layerStyle.transferEffects",
    "layer.rasterize.layerStyle",
    "style.presets.apply",
    "style.presets.list",
    "style.presets.new",
    "style.presets.edit",
    "style.presets.reset",
    // 「重置为默认」要能读回用户默认；两者与预设一样存在会话偏好里。
    "layer.layerStyle.defaultFor",
    "layer.layerStyle.makeDefault",
];

/// 只改会话偏好、不写文档的命令（与 `SESSION_ONLY_IDS` 的「不进隔离会话」同理）。
pub(crate) const PRESET_IDS: [&str; 6] = [
    "style.presets.list",
    "style.presets.new",
    "style.presets.edit",
    "style.presets.reset",
    "layer.layerStyle.defaultFor",
    "layer.layerStyle.makeDefault",
];
/// 去边与颜色净化（U62）。
pub(crate) const MATTING_IDS: [&str; 4] = [
    "layer.matting.defringe",
    "layer.matting.removeBlackMatte",
    "layer.matting.removeWhiteMatte",
    "layer.matting.colorDecontaminate",
];
/// 图层复合（U64）。
pub(crate) const COMP_IDS: [&str; 12] = [
    "layerComp.new",
    "layerComp.update",
    "layerComp.apply",
    "layerComp.previous",
    "layerComp.next",
    "layerComp.delete",
    "layerComp.duplicate",
    "layerComp.rename",
    "layerComp.setComment",
    "layerComp.setOptions",
    "layerComp.restoreLastDocumentState",
    "layerComp.updateWarnings",
];

/// 一组命令的统一域校验入口；不属于本域任何组时返回 `Ok(false)`。
pub(crate) fn check(session: &Session, id: &str, params: &Value) -> Result<bool> {
    if LINK_IDS.contains(&id) || MERGE_IDS.contains(&id) {
        return check_structure(session, id, params).map(|()| true);
    }
    if PASTE_IDS.contains(&id) {
        return check_paste(session, id, params).map(|()| true);
    }
    if BLEND_IDS.contains(&id) {
        return check_blending(session, id, params).map(|()| true);
    }
    if STYLE_IDS.contains(&id) {
        // 预设管理改会话偏好而非文档，单独走一套校验。
        return if PRESET_IDS.contains(&id) {
            check_preset(session, id, params).map(|()| true)
        } else {
            check_style(session, id, params).map(|()| true)
        };
    }
    if MATTING_IDS.contains(&id) {
        return check_matting(session, id, params).map(|()| true);
    }
    if COMP_IDS.contains(&id) {
        return check_comp(session, id, params).map(|()| true);
    }
    Ok(false)
}

fn fields<'a>(id: &str, params: &'a Value, allowed: &[&str]) -> Result<&'a serde_json::Map<String, Value>> {
    let object = params.as_object().ok_or_else(|| error(id, "参数必须为对象"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(error(id, format!("参数不接受 {key}")));
    }
    Ok(object)
}

fn layer_id(id: &str, params: &Value, key: &str) -> Result<Option<LayerId>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(|value| Some(LayerId(value))).ok_or_else(|| error(id, format!("{key} 必须为非负整数"))),
    }
}

/// U58：链接、标签、剪切建层、盖印、背景互转与反转。
fn check_structure(session: &Session, id: &str, params: &Value) -> Result<()> {
    if !params.is_null() {
        let allowed: &[&str] = match id {
            "layer.setLabelColor" => &["color", "layer"],
            "layer.new.layerViaCut" | "layer.stampDown" | "layer.new.layerFromBackground" => &["layer"],
            "layer.new.backgroundFromLayer" => &["layer"],
            _ => &[],
        };
        fields(id, params, allowed)?;
    }
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let target = layer_id(id, params, "layer")?.or(state.active_layer);
    match id {
        "layer.setLabelColor" => {
            let color = params.get("color").and_then(Value::as_str).unwrap_or("");
            if photocraft_doc::LabelColor::from_id(color).is_none() {
                return Err(error(id, "图层颜色标签只接受 none、red、orange、yellow、green、seafoam、blue、indigo、magenta、fuchsia、violet、gray"));
            }
            if state.selected_layers().is_empty() && target.is_none() {
                return Err(error(id, "请先选择图层"));
            }
        }
        "layer.linkLayers" => {
            let selected = state.selected_layers();
            if selected.is_empty() {
                return Err(error(id, "请先选择图层"));
            }
            // 单选且未链接时上游拒绝；这里给出同样明确的原因，面板据此禁用。
            if selected.len() == 1 && state.doc.layer(selected[0]).is_none_or(|layer| layer.link_group.is_none()) {
                return Err(error(id, "请选择两个或更多图层再链接"));
            }
        }
        "layer.selectLinkedLayers" => {
            let linked = state.selected_layers().iter().filter_map(|id| state.doc.layer(*id))
                .any(|layer| layer.link_group.is_some() || layer.mask.as_ref().is_some_and(|mask| mask.linked));
            if !linked {
                return Err(error(id, "所选图层没有链接"));
            }
        }
        "layer.arrange.reverse" => {
            let selected = state.selected_layers();
            if selected.len() < 2 {
                return Err(error(id, "请至少选择两个图层再反转顺序"));
            }
        }
        _ => {}
    }
    match id {
        "layer.new.layerViaCut" => {
            let target = target.ok_or_else(|| error(id, "没有活动图层"))?;
            let layer = state.doc.layer(target).ok_or_else(|| error(id, "图层不存在"))?;
            if state.doc.effective_locks(target).all || state.doc.effective_locks(target).pixels {
                return Err(error(id, "目标图层已锁定，请先解锁"));
            }
            if !matches!(layer.content, LayerContent::Raster(_)) {
                return Err(error(id, "剪切建层需要像素层；文字、形状与智能对象请先栅格化"));
            }
            if crate::layer_preview::layer_count(&state.doc.layers) >= photocraft_project_verify::MAX_LAYERS {
                return Err(error(id, "图层已达工程上限（64 层）"));
            }
        }
        "layer.stampVisible" => {
            if crate::layer_preview::layer_count(&state.doc.layers) >= photocraft_project_verify::MAX_LAYERS {
                return Err(error(id, "图层已达工程上限（64 层）"));
            }
        }
        "layer.stampDown" => {
            let target = target.ok_or_else(|| error(id, "没有活动图层"))?;
            if state.doc.effective_locks(target).all {
                return Err(error(id, "目标图层已锁定，请先解锁"));
            }
        }
        "layer.new.layerFromBackground" | "layer.new.backgroundFromLayer" => {
            let target = target.or_else(|| state.doc.layers.first().map(|layer| layer.id)).ok_or_else(|| error(id, "文档没有图层"))?;
            if state.doc.layer(target).is_none() {
                return Err(error(id, "图层不存在"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// U59：粘贴入/外必须有选区与有效剪贴板；目标层数与父组锁定与普通粘贴一致。
fn check_paste(session: &Session, id: &str, params: &Value) -> Result<()> {
    if !params.is_null() {
        fields(id, params, &["center", "target"])?;
    }
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let selection = state.doc.selection.as_ref().ok_or_else(|| error(id, "粘贴入/外需要先建立选区"))?;
    if selection.content_bounds().is_empty() {
        return Err(error(id, "选区为空，无法粘贴入或粘贴外"));
    }
    let clip = session.clipboard.as_ref().ok_or_else(|| error(id, "剪贴板为空，请先复制图片内容"))?;
    if clip.bounds.is_empty() {
        return Err(error(id, "剪贴板内容为空"));
    }
    if crate::layer_preview::mask_target(state) {
        let layer = state.active_layer.and_then(|layer| state.doc.layer(layer)).ok_or_else(|| error(id, "没有活动图层"))?;
        if layer.mask.is_none() || state.doc.effective_locks(layer.id).all {
            return Err(error(id, "蒙版不存在或图层已锁定"));
        }
        return Ok(());
    }
    let count = clip.layers.as_ref().map_or(1, |doc| crate::layer_preview::layer_count(&doc.layers));
    if count == 0 || crate::layer_preview::layer_count(&state.doc.layers).saturating_add(count) > photocraft_project_verify::MAX_LAYERS {
        return Err(error(id, "粘贴后超过图层上限（64 层）"));
    }
    if let Some(center) = params.get("center") {
        let valid = center.as_array().is_some_and(|center| center.len() == 2
            && center.iter().all(|value| value.as_f64().is_some_and(|value| value.is_finite() && value.abs() <= 1_000_000.0)));
        if !valid {
            return Err(error(id, "粘贴中心必须是有效文档坐标"));
        }
    }
    Ok(())
}

/// U60：Blend If 阈值顺序、通道可见性、挖空取值与高级混合开关。
fn check_blending(session: &Session, id: &str, params: &Value) -> Result<()> {
    let allowed: &[&str] = &[
        "layer", "blend", "opacity", "fillOpacity", "knockout", "blendIf", "channels", "blendInteriorEffectsAsGroup",
        "blendClippedLayersAsGroup", "transparencyShapesLayer", "layerMaskHidesEffects", "vectorMaskHidesEffects",
    ];
    fields(id, params, allowed)?;
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let target = layer_id(id, params, "layer")?.or(state.active_layer).ok_or_else(|| error(id, "没有活动图层"))?;
    let layer = state.doc.layer(target).ok_or_else(|| error(id, "图层不存在"))?;
    if let Some(knockout) = params.get("knockout").filter(|value| !value.is_null()) {
        let name = knockout.as_str().ok_or_else(|| error(id, "挖空只接受 none、shallow 或 deep"))?;
        if Knockout::from_name(name).is_none() {
            return Err(error(id, format!("挖空只接受 none、shallow 或 deep（收到 {name}）")));
        }
    }
    if let Some(blend) = params.get("blend") {
        let mode = blend.as_str().and_then(photocraft_engine::commands::blend_from_str)
            .ok_or_else(|| error(id, "混合模式无效"))?;
        if !photocraft_doc::BlendMode::LAYER_MODES.contains(&mode)
            && !(layer.is_group() && mode == photocraft_doc::BlendMode::PassThrough) {
            return Err(error(id, "该图层不支持此混合模式"));
        }
    }
    for key in ["blendInteriorEffectsAsGroup", "blendClippedLayersAsGroup", "transparencyShapesLayer", "layerMaskHidesEffects", "vectorMaskHidesEffects"] {
        if params.get(key).is_some_and(|value| !value.is_null() && !value.is_boolean()) {
            return Err(error(id, format!("{key} 必须是布尔值")));
        }
    }
    if let Some(channels) = params.get("channels").filter(|value| !value.is_null()) {
        let list = channels.as_array().ok_or_else(|| error(id, "channels 必须是逐颜色通道的布尔列表"))?;
        let expected = state.doc.mode.color_channels().max(1);
        if list.len() != expected {
            return Err(error(id, format!("本文档有 {expected} 个颜色通道，收到 {} 项", list.len())));
        }
        if list.iter().any(|value| !value.is_boolean()) {
            return Err(error(id, "channels 只接受布尔值"));
        }
    }
    if let Some(entries) = params.get("blendIf").filter(|value| !value.is_null()) {
        let list: Vec<&Value> = match entries {
            Value::Array(list) => list.iter().collect(),
            Value::Object(_) => vec![entries],
            _ => return Err(error(id, "blendIf 只接受对象、对象列表或 null")),
        };
        for entry in list {
            let object = entry.as_object().ok_or_else(|| error(id, "blendIf 项必须是对象"))?;
            if let Some(key) = object.keys().find(|key| !["channel", "thisLayer", "underlying"].contains(&key.as_str())) {
                return Err(error(id, format!("blendIf 项不接受 {key}")));
            }
            let channel = object.get("channel").ok_or_else(|| error(id, "blendIf 项缺少 channel"))?;
            if blend_channel(channel, state.doc.mode).is_none() {
                return Err(error(id, format!("本文档不存在通道 {channel}")));
            }
            for key in ["thisLayer", "underlying"] {
                if let Some(range) = object.get(key) {
                    parse_range(id, key, range)?;
                }
            }
        }
    }
    Ok(())
}

fn blend_channel(value: &Value, mode: photocraft_color::ColorMode) -> Option<usize> {
    let count = mode.color_channels();
    if let Some(index) = value.as_u64() {
        return usize::try_from(index).ok().filter(|index| *index <= count);
    }
    let name = value.as_str()?.to_ascii_lowercase();
    let names: &[&str] = match mode {
        photocraft_color::ColorMode::Rgb | photocraft_color::ColorMode::Indexed => &["red", "green", "blue"],
        photocraft_color::ColorMode::Cmyk => &["cyan", "magenta", "yellow", "black"],
        photocraft_color::ColorMode::Lab => &["lightness", "a", "b"],
        _ => &[],
    };
    if name == "gray" || name == "grey" {
        return Some(usize::from(count == 1));
    }
    names.iter().position(|candidate| *candidate == name).map(|index| index + 1)
}

/// `[black, white]` 未分离端点或 `[blackLow, blackHigh, whiteLow, whiteHigh]` 分离端点，必须递增。
fn parse_range(id: &str, key: &str, value: &Value) -> Result<()> {
    let list = value.as_array().ok_or_else(|| error(id, format!("blendIf.{key} 必须是数组")))?;
    let values: Option<Vec<u8>> = list.iter()
        .map(|value| value.as_f64().filter(|value| (0.0..=255.0).contains(value)).map(|value| value.round() as u8))
        .collect();
    let values = values.ok_or_else(|| error(id, format!("blendIf.{key} 每项必须是 0–255 的数值")))?;
    if !matches!(values.len(), 2 | 4) {
        return Err(error(id, format!("blendIf.{key} 需要 2 或 4 个端点")));
    }
    if values.windows(2).any(|pair| pair[0] > pair[1]) {
        return Err(error(id, format!("blendIf.{key} 端点必须递增（分离端点不能交叉）")));
    }
    Ok(())
}

/// U61：样式复制/粘贴、清空、缩放效果、效果转层与栅格化、预设应用。
fn check_style(session: &Session, id: &str, params: &Value) -> Result<()> {
    let allowed: &[&str] = match id {
        "layer.layerStyle.pasteLayerStyle" => &["layer"],
        "layer.layerStyle.clear" => &["layer", "effect"],
        "layer.layerStyle.scaleEffects" => &["layer", "scale"],
        "layer.layerStyle.createLayer" => &["layer"],
        "layer.layerStyle.transferEffects" => &["from", "to", "effect", "copy"],
        "layer.rasterize.layerStyle" => &["layer"],
        _ => &["layer", "preset", "group", "layers", "add"],
    };
    fields(id, params, allowed)?;
    let state = session.active().ok_or(EditorError::NoDocument)?;
    match id {
        "layer.layerStyle.copyLayerStyle" => {
            let target = layer_id(id, params, "layer")?.or(state.active_layer).ok_or_else(|| error(id, "请先选择图层"))?;
            if state.doc.layer(target).is_none() {
                return Err(error(id, "图层不存在"));
            }
        }
        "layer.layerStyle.pasteLayerStyle" => {
            if session.style_clipboard.is_none() {
                return Err(error(id, "还没有复制图层样式"));
            }
            let target = layer_id(id, params, "layer")?.or(state.active_layer).ok_or_else(|| error(id, "请先选择目标图层"))?;
            let layer = state.doc.layer(target).ok_or_else(|| error(id, "图层不存在"))?;
            if state.doc.effective_locks(target).all {
                return Err(error(id, "目标图层已锁定，请先解锁"));
            }
            if matches!(layer.content, LayerContent::Group(_)) {
                return Err(error(id, "组不能粘贴图层样式，请选择图层"));
            }
        }
        "layer.layerStyle.clear" => {
            let target = layer_id(id, params, "layer")?.or(state.active_layer).ok_or_else(|| error(id, "请先选择图层"))?;
            if state.doc.effective_locks(target).all {
                return Err(error(id, "图层已锁定，请先解锁"));
            }
            if params.get("effect").is_some_and(|value| value.as_u64().is_none()) {
                return Err(error(id, "effect 必须是效果序号"));
            }
        }
        "layer.layerStyle.scaleEffects" => {
            // 上游 `scale` 缺省为 100（等于不改）；显式给了就必须是 1–1000 的百分比（`null` 也算给了）。
            if let Some(scale) = params.get("scale") {
                if !scale.as_f64().is_some_and(|scale| scale.is_finite() && (1.0..=1000.0).contains(&scale)) {
                    return Err(error(id, "scale 必须是 1–1000 的百分比"));
                }
            }
            let target = layer_id(id, params, "layer")?.or(state.active_layer).ok_or_else(|| error(id, "请先选择图层"))?;
            if state.doc.layer(target).is_none() {
                return Err(error(id, "图层不存在"));
            }
        }
        "layer.layerStyle.createLayer" | "layer.rasterize.layerStyle" => {
            let target = layer_id(id, params, "layer")?.or(state.active_layer).ok_or_else(|| error(id, "请先选择图层"))?;
            let layer = state.doc.layer(target).ok_or_else(|| error(id, "图层不存在"))?;
            if layer.effects.items.is_empty() {
                return Err(error(id, "图层没有可转换的图层样式"));
            }
            if crate::layer_preview::layer_count(&state.doc.layers) >= photocraft_project_verify::MAX_LAYERS {
                return Err(error(id, "图层已达工程上限（64 层）"));
            }
        }
        "layer.layerStyle.transferEffects" => {
            for key in ["from", "to"] {
                if params.get(key).and_then(Value::as_u64).is_none() {
                    return Err(error(id, format!("{key} 必须是图层 id")));
                }
            }
            if params["from"].as_u64() == params["to"].as_u64() {
                return Err(error(id, "源层与目标层相同"));
            }
            if params.get("copy").is_some_and(|value| !value.is_boolean()) {
                return Err(error(id, "copy 必须是布尔值"));
            }
            let from = LayerId(params["from"].as_u64().unwrap_or_default());
            let to = LayerId(params["to"].as_u64().unwrap_or_default());
            let source = state.doc.layer(from).ok_or_else(|| error(id, "源图层不存在"))?;
            state.doc.layer(to).ok_or_else(|| error(id, "目标图层不存在"))?;
            // 效果索引与「源层有没有可移的效果」提前查清：上游在隔离会话里才报，面板拿不到人话原因。
            match params.get("effect") {
                None | Some(Value::Null) => {
                    if source.effects.items.is_empty() {
                        return Err(error(id, "源图层没有可转移的图层样式"));
                    }
                }
                Some(value) => {
                    let index = value.as_u64().and_then(|index| usize::try_from(index).ok())
                        .ok_or_else(|| error(id, "effect 必须是效果序号"))?;
                    if index >= source.effects.items.len() {
                        return Err(error(id, format!("源图层没有第 {index} 个效果")));
                    }
                }
            }
            if state.doc.effective_locks(to).all {
                return Err(error(id, "目标图层已锁定，请先解锁"));
            }
            // 移动（非复制）会清空源层效果：那是对源层的写入，源层整体锁定必须一起挡住。
            if !params.get("copy").and_then(Value::as_bool).unwrap_or(false) && state.doc.effective_locks(from).all {
                return Err(error(id, "源图层已锁定，无法移走效果"));
            }
        }
        _ => {
            let name = params.get("preset").and_then(Value::as_str).filter(|name| !name.trim().is_empty())
                .ok_or_else(|| error(id, "样式预设需要 preset 名称"))?;
            let known = session.presets.styles.iter().flat_map(|group| group.items.iter()).any(|preset| preset.name == name);
            if !known {
                return Err(error(id, format!("没有名为“{name}”的样式预设")));
            }
            if params.get("add").is_some_and(|value| !value.is_boolean()) {
                return Err(error(id, "add 必须是布尔值"));
            }
        }
    }
    Ok(())
}

/// U61：样式预设管理（列出/保存/整理/恢复默认）。
///
/// 预设属于**会话偏好**而非文档内容：这些命令改 `session.presets.styles`，不推进文档修订、
/// 不写历史，也不进入内容身份。因此它们必须在真实会话上执行，不能跑在隔离会话副本上——
/// 与 [`SESSION_ONLY_IDS`] 同理，隔离副本的改动不会回传。
fn check_preset(session: &Session, id: &str, params: &Value) -> Result<()> {
    match id {
        "style.presets.list" => {
            // 只读：不接受任何参数，避免把拼写错误当成「列出全部」。
            fields(id, params, &[])?;
        }
        "style.presets.new" => {
            fields(
                id,
                params,
                &["name", "group", "layer", "includeEffects", "includeBlending", "effects", "blend", "fillOpacity"],
            )?;
            let state = session.active().ok_or(EditorError::NoDocument)?;
            let target = layer_id(id, params, "layer")?.or(state.active_layer).ok_or_else(|| error(id, "请先选择图层"))?;
            if state.doc.layer(target).is_none() {
                return Err(error(id, "图层不存在"));
            }
            // 两组都不包含时上游会拒绝；这里提前给出具体原因。
            let effects = params.get("includeEffects").and_then(Value::as_bool).unwrap_or(true);
            let blending = params.get("includeBlending").and_then(Value::as_bool).unwrap_or(true);
            if !effects && !blending {
                return Err(error(id, "至少要包含图层效果或混合选项之一"));
            }
            if let Some(name) = params.get("name").filter(|value| !value.is_null()) {
                let name = name.as_str().filter(|name| name.encode_utf16().count() <= 200)
                    .ok_or_else(|| error(id, "name 必须是 200 字符以内的字符串"))?;
                if name.trim().is_empty() {
                    return Err(error(id, "预设名称不能为空"));
                }
            }
            if params.get("effects").is_some_and(|value| !value.is_null() && !value.is_array()) {
                return Err(error(id, "effects 必须是 [[kind, params], …]"));
            }
        }
        "style.presets.edit" => {
            fields(id, params, &["action", "preset", "group", "name", "to", "index"])?;
            const ACTIONS: [&str; 6] = ["rename", "delete", "move", "newGroup", "renameGroup", "deleteGroup"];
            let action = params.get("action").and_then(Value::as_str)
                .filter(|action| ACTIONS.contains(action))
                .ok_or_else(|| error(id, format!("action 必须是 {} 之一", ACTIONS.join("、"))))?;
            let group = params.get("group").and_then(Value::as_str);
            match action {
                // 改名/移动/删除都要先确认目标真实存在：上游是「全有或全无」，提前拒绝更早也更具体。
                "rename" | "move" => {
                    let name = params.get("preset").and_then(Value::as_str)
                        .ok_or_else(|| error(id, "preset 必须是要整理的预设名称"))?;
                    if find_style(session, name, group).is_none() {
                        return Err(error(id, format!("没有名为“{name}”的样式预设")));
                    }
                }
                "delete" => {
                    for name in preset_names(id, params)? {
                        if find_style(session, &name, group).is_none() {
                            return Err(error(id, format!("没有名为“{name}”的样式预设")));
                        }
                    }
                }
                "renameGroup" | "deleteGroup" => {
                    let group = group.ok_or_else(|| error(id, "group 必须是组名"))?;
                    if !session.presets.styles.iter().any(|existing| existing.name == group) {
                        return Err(error(id, format!("没有名为“{group}”的样式预设组")));
                    }
                }
                _ => {}
            }
            if params.get("index").is_some_and(|value| value.as_u64().is_none()) {
                return Err(error(id, "index 必须是非负整数"));
            }
        }
        "style.presets.reset" => {
            fields(id, params, &["append"])?;
            if params.get("append").is_some_and(|value| !value.is_boolean()) {
                return Err(error(id, "append 必须是布尔值"));
            }
        }
        // 「重置为默认」读/写某一效果种类的**用户默认**，同样只动会话偏好。
        "layer.layerStyle.defaultFor" => {
            fields(id, params, &["kind"])?;
            let kind = params.get("kind").and_then(Value::as_str)
                .ok_or_else(|| error(id, "kind 必须是效果种类"))?;
            if photocraft_engine::layer_style::effect_from_params(kind, &Value::Null).is_none() {
                return Err(error(id, format!("未知效果种类“{kind}”")));
            }
        }
        "layer.layerStyle.makeDefault" => {
            fields(id, params, &["kind", "params"])?;
            let kind = params.get("kind").and_then(Value::as_str)
                .ok_or_else(|| error(id, "kind 必须是效果种类"))?;
            if photocraft_engine::layer_style::effect_from_params(kind, &Value::Null).is_none() {
                return Err(error(id, format!("未知效果种类“{kind}”")));
            }
            if !params.get("params").is_some_and(Value::is_object) {
                return Err(error(id, "params 必须是参数对象"));
            }
        }
        _ => return Err(error(id, "不是样式预设管理命令")),
    }
    Ok(())
}

/// `preset` 支持单个名称或名称列表（批量删除）；空列表按非法处理，避免静默「删了 0 个」。
fn preset_names(id: &str, params: &Value) -> Result<Vec<String>> {
    match params.get("preset") {
        Some(Value::Array(list)) => {
            let names: Vec<String> = list.iter().filter_map(Value::as_str).map(str::to_string).collect();
            if names.len() != list.len() || names.is_empty() {
                return Err(error(id, "preset 列表必须是非空的名称数组"));
            }
            Ok(names)
        }
        Some(Value::String(name)) if !name.trim().is_empty() => Ok(vec![name.clone()]),
        _ => Err(error(id, "preset 必须是非空名称或名称列表")),
    }
}

fn find_style<'a>(session: &'a Session, name: &str, group: Option<&str>) -> Option<&'a photocraft_engine::presets::styles::StylePreset> {
    session.presets.styles.iter()
        .filter(|existing| group.is_none_or(|wanted| existing.name == wanted))
        .flat_map(|existing| existing.items.iter())
        .find(|preset| preset.name == name)
}

/// U62：去边与净化只作用于像素层，参数范围与上游一致。
fn check_matting(session: &Session, id: &str, params: &Value) -> Result<()> {
    let allowed: &[&str] = if id == "layer.matting.defringe" {
        &["width", "layer"]
    } else if id == "layer.matting.colorDecontaminate" {
        &["amount", "radius", "layer"]
    } else {
        &["layer"]
    };
    if !params.is_null() {
        fields(id, params, allowed)?;
    }
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let target = layer_id(id, params, "layer")?.or(state.active_layer).ok_or_else(|| error(id, "没有活动图层"))?;
    let layer = state.doc.layer(target).ok_or_else(|| error(id, "图层不存在"))?;
    if !matches!(layer.content, LayerContent::Raster(_)) {
        return Err(error(id, "去边与颜色净化只能用于像素层"));
    }
    if state.doc.effective_locks(target).all || state.doc.effective_locks(target).pixels {
        return Err(error(id, "目标图层已锁定，请先解锁"));
    }
    if let Some(width) = params.get("width") {
        if !width.as_f64().is_some_and(|width| width.is_finite() && (1.0..=200.0).contains(&width)) {
            return Err(error(id, "去边宽度必须是 1–200 像素"));
        }
    }
    if let Some(amount) = params.get("amount") {
        if !amount.as_f64().is_some_and(|amount| amount.is_finite() && (0.0..=100.0).contains(&amount)) {
            return Err(error(id, "净化强度必须是 0–100"));
        }
    }
    if let Some(radius) = params.get("radius") {
        if !radius.as_f64().is_some_and(|radius| radius.is_finite() && (1.0..=100.0).contains(&radius)) {
            return Err(error(id, "净化半径必须是 1–100"));
        }
    }
    Ok(())
}

/// U64：图层复合的字段、选项与预算。
fn check_comp(session: &Session, id: &str, params: &Value) -> Result<()> {
    let allowed: &[&str] = match id {
        "layerComp.new" => &["name", "comment", "visibility", "position", "appearance"],
        "layerComp.update" => &["comp", "what"],
        "layerComp.apply" | "layerComp.delete" | "layerComp.duplicate" | "layerComp.updateWarnings" => &["comp", "clear"],
        "layerComp.rename" => &["comp", "name"],
        "layerComp.setComment" => &["comp", "comment"],
        "layerComp.setOptions" => &["comp", "visibility", "position", "appearance", "name", "comment"],
        _ => &[],
    };
    if !params.is_null() {
        fields(id, params, allowed)?;
    }
    let state = session.active().ok_or(EditorError::NoDocument)?;
    // 复合是文档内容：草稿/未结算内容不能写入快照。
    if state.doc.layer_comps.len() >= MAX_LAYER_COMPS && matches!(id, "layerComp.new" | "layerComp.duplicate") {
        return Err(error(id, format!("图层复合超过上限（{MAX_LAYER_COMPS}）")));
    }
    if id == "layerComp.new" {
        if let Some(name) = params.get("name") {
            let name = name.as_str().ok_or_else(|| error(id, "name 必须是字符串"))?;
            if name.trim().is_empty() || name.encode_utf16().count() > 200 {
                return Err(error(id, "复合名称必须为 1–200 个字符"));
            }
        }
        for key in ["visibility", "position", "appearance"] {
            if params.get(key).is_some_and(|value| !value.is_boolean()) {
                return Err(error(id, format!("{key} 必须是布尔值")));
            }
        }
    }
    if id == "layerComp.setOptions" {
        for key in ["visibility", "position", "appearance"] {
            if params.get(key).is_some_and(|value| !value.is_boolean()) {
                return Err(error(id, format!("{key} 必须是布尔值")));
            }
        }
        if let Some(name) = params.get("name") {
            let name = name.as_str().filter(|name| !name.trim().is_empty() && name.encode_utf16().count() <= 200)
                .ok_or_else(|| error(id, "复合名称必须为 1–200 个字符"))?;
            let _ = name;
        }
    }
    match id {
        "layerComp.new" | "layerComp.updateWarnings" => {}
        "layerComp.update" | "layerComp.delete" | "layerComp.rename" | "layerComp.setComment" | "layerComp.setOptions"
        | "layerComp.apply" | "layerComp.duplicate" => {
            require_comp(state, id, params)?;
        }
        "layerComp.previous" | "layerComp.next" => {
            if state.doc.layer_comps.is_empty() {
                return Err(error(id, "文档没有图层复合"));
            }
        }
        "layerComp.restoreLastDocumentState" => {
            if state.doc.last_document_state.is_none() {
                return Err(error(id, "还没有应用过图层复合，无法恢复"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// 复合数量上限：与图层数量同级，避免复合把工程结构撑爆。
pub(crate) const MAX_LAYER_COMPS: usize = 64;

fn require_comp(state: &DocState, id: &str, params: &Value) -> Result<()> {
    if state.doc.layer_comps.is_empty() {
        return Err(error(id, "文档没有图层复合"));
    }
    match params.get("comp") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Number(_)) => {
            let value = params["comp"].as_u64().unwrap_or(u64::MAX);
            if !state.doc.layer_comps.iter().any(|comp| u64::from(comp.id) == value) {
                return Err(error(id, format!("没有 id 为 {value} 的图层复合")));
            }
            Ok(())
        }
        Some(Value::String(name)) if name == "*" => Ok(()),
        Some(Value::String(name)) => {
            if state.doc.layer_comps.iter().any(|comp| comp.name == *name) {
                Ok(())
            } else {
                Err(error(id, format!("没有名为“{name}”的图层复合")))
            }
        }
        Some(_) => Err(error(id, "comp 必须是复合 id 或名称")),
    }
}

/// 在一个隔离会话上执行命令，返回候选文档；正式状态不受影响。
///
/// 同时返回命令自身的返回值：部分命令（如 `layerComp.updateWarnings` 的缺失层报告）
/// 的结果只在这个返回值里，丢弃它面板就只能显示「成功」而拿不到报告。
fn candidate(session: &Session, command: &str, params: &Value) -> Result<(Arc<Document>, Value)> {
    let base = session.active().ok_or(EditorError::NoDocument)?.clone();
    let mut scratch = Session::new();
    scratch.add_document((*base.doc).clone(), None);
    *scratch.active_mut().unwrap() = base;
    scratch.tools = session.tools.clone();
    scratch.patterns = session.patterns.clone();
    scratch.presets = session.presets.clone();
    scratch.style_clipboard = session.style_clipboard.clone();
    scratch.clipboard = session.clipboard.clone();
    let value = scratch.execute(command, params.clone()).map_err(|reason| error(command, reason))?;
    let document = scratch.active().ok_or(EditorError::NoDocument)?.doc.clone();
    if !photocraft_project_verify::style_support::supported_document(&document) {
        return Err(error(command, "结果无法通过样式及图案核验"));
    }
    Ok((document, value))
}

/// 候选合成预览；`Preview` 不是 `Serialize`，因此显式转换，避免透传额外字段。
fn render_preview(doc: &Document, max_side: u32) -> Value {
    let image = photocraft_compose::thumbnail(doc, max_side.clamp(1, PREVIEW_SIDE));
    json!({ "width": image.width, "height": image.height, "pixels": image.pixels })
}

/// 只改会话状态（不写文档）的命令：剪贴板类操作不能跑在隔离会话上，否则真实会话拿不到结果。
const SESSION_ONLY_IDS: [&str; 1] = ["layer.layerStyle.copyLayerStyle"];

/// 单个复合的规范快照：只保留该复合声明要恢复的字段，其余为 `null`。
///
/// 这与 `layerComp.apply` 的语义一一对应——`null` 表示「切到这个复合不会改这个字段」，
/// 因此快照既能交付给宿主另存，也能直接用来解释「为什么切复合后某层没动」。
fn comp_snapshot(comp: &photocraft_doc::LayerComp) -> Value {
    comp.states.iter().map(|state| {
        json!({
            "layer": state.layer.0,
            "visible": if comp.apply_visibility { state.visible.map(Value::Bool).unwrap_or(Value::Null) } else { Value::Null },
            "position": match (comp.apply_position, state.position) {
                (true, Some((x, y))) => json!([x, y]),
                _ => Value::Null,
            },
            "appearance": match (comp.apply_appearance, &state.appearance) {
                (true, Some(appearance)) => json!({
                    "blend": photocraft_project_verify::blend_modes::canonical_blend_name(appearance.blend).unwrap_or("unsupported"),
                    "opacity": appearance.opacity,
                    "fillOpacity": appearance.fill_opacity,
                    "effects": {
                        "enabled": appearance.effects.enabled,
                        // 效果项按内核声明顺序；同 kind 多次出现时顺序也属于内容。
                        "items": appearance.effects.items,
                    },
                }),
                _ => Value::Null,
            },
        })
    }).collect::<Vec<_>>().into()
}

fn rect_json(rect: photocraft_geom::Rect) -> Value {
    json!([rect.x0, rect.y0, rect.width(), rect.height()])
}

impl crate::editor::Editor {
    /// 本组命令的统一入口：`preview` 为真时只返回候选结果与像素，不写文档。
    pub fn layer_workflow(&mut self, id: &str, params: Value, preview: bool) -> Result<Value> {
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        self.layer_workflow_inner(id, params, preview)
    }

    /// 统一入口的实际实现：能力门禁由 [`Editor::layer_workflow`] 负责，本函数可被域内测试直接调用。
    pub(crate) fn layer_workflow_inner(&mut self, id: &str, params: Value, preview: bool) -> Result<Value> {
        if preview {
            self.require_no_tool_draft()?;
        } else {
            self.require_no_stroke()?;
            self.require_no_tool_draft()?;
        }
        if !check(&self.session, id, &params)? {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        // 只改会话状态（如样式剪贴板）的命令必须在真实会话上执行：隔离会话的副本不会回传。
        if SESSION_ONLY_IDS.contains(&id) {
            self.session.execute(id, params).map_err(|reason| error(id, reason))?;
            return Ok(json!({
                "changed": false,
                "hasStyleClipboard": self.session.style_clipboard.is_some(),
                "state": self.state()["document"].clone(),
            }));
        }
        // 样式预设管理（U61）改的是会话偏好：预设库是偏好而非文档，因此不进历史、不动修订。
        if PRESET_IDS.contains(&id) {
            let value = self.session.execute(id, params).map_err(|reason| error(id, reason))?;
            return Ok(json!({
                "changed": false,
                "presets": value,
                // 面板据此重绘预设列表；与 `document.revision` 无关。
                "presetsRevision": self.session.presets.rev,
                "state": self.state()["document"].clone(),
            }));
        }
        let (document, value) = candidate(&self.session, id, &params)?;
        if preview {
            return Ok(json!({
                "preview": render_preview(&document, PREVIEW_SIDE),
                "revision": self.revision()?,
            }));
        }
        let changed = {
            let before = &self.active_doc()?.doc;
            !Arc::ptr_eq(before, &document) && **before != *document
        };
        if changed {
            crate::preview_history::commit(&mut self.session, document, None, &label(id)).map_err(|reason| error(id, reason))?;
        }
        let state = self.active_doc()?;
        let mut response = json!({
            "changed": changed,
            "layers": crate::layer_preview::layer_count(&state.doc.layers),
            "state": self.state()["document"].clone(),
        });
        // 只读命令（如缺失层报告）的结果不在文档里：原样转出，避免面板只能显示「成功」。
        if matches!(value, Value::Object(_) | Value::Array(_)) && !value.is_null() {
            response["result"] = value;
        }
        Ok(response)
    }

    /// 图层复合列表（只读）：面板据此渲染复合行与缺失层报告。
    ///
    /// 除行摘要外，每个复合还带 `snapshot`——按三个选项裁剪过的**规范快照**（可见性/位置/外观
    /// 逐层记录），使 U64 的「能交付快照」不必依赖写文件（`file.export.layerCompsToFiles`
    /// 需要目录，浏览器宿主没有）。未声明恢复的字段在快照里为 `null`，因此快照就是「切复合
    /// 到底会改什么」的权威答案，可直接对比或另存。
    pub fn layer_comps(&self) -> Result<Value> {
        let state = self.active_doc()?;
        let comps: Vec<Value> = state.doc.layer_comps.iter().map(|comp| {
            let missing = comp.missing_layers(&state.doc);
            json!({
                "id": comp.id,
                "name": comp.name,
                "comment": comp.comment,
                "visibility": comp.apply_visibility,
                "position": comp.apply_position,
                "appearance": comp.apply_appearance,
                "layers": comp.states.len(),
                "missingLayers": missing.iter().map(|id| id.0).collect::<Vec<_>>(),
                "snapshot": comp_snapshot(comp),
            })
        }).collect();
        Ok(json!({
            "comps": comps,
            "lastApplied": state.doc.last_applied_comp,
            "hasLastDocumentState": state.doc.last_document_state.is_some(),
        }))
    }

    /// 图层链接/标签/建层/盖印（U58）的统一入口。
    pub fn layer_structure(&mut self, id: &str, params: Value) -> Result<Value> {
        self.layer_workflow(id, params, false)
    }

    /// 粘贴入/粘贴外（U59）：先预览蒙版结果，再一步提交。
    pub fn paste_into(&mut self, id: &str, params: Value, preview: bool) -> Result<Value> {
        self.layer_workflow(id, params, preview)
    }

    /// 高级混合预览（U60）：分离端点拖动时显示真实合成过渡。
    pub fn preview_blending(&mut self, params: Value) -> Result<Value> {
        self.layer_workflow("layer.layerStyle.blendingOptions", params, true)
    }

    /// 确认高级混合（U60）。
    pub fn apply_blending(&mut self, params: Value) -> Result<Value> {
        self.layer_workflow("layer.layerStyle.blendingOptions", params, false)
    }

    /// 样式命令预览（U61）。
    pub fn preview_layer_style(&mut self, id: &str, params: Value) -> Result<Value> {
        self.layer_workflow(id, params, true)
    }

    /// 样式命令确认（U61）。
    pub fn apply_layer_style(&mut self, id: &str, params: Value) -> Result<Value> {
        self.layer_workflow(id, params, false)
    }

    /// 去边/净化的预览（U62）：真实像素结果，正式内容不变。
    pub fn preview_matting(&mut self, id: &str, params: Value) -> Result<Value> {
        self.layer_workflow(id, params, true)
    }

    /// 去边/净化的确认（U62）：一次撤销恢复原像素。
    pub fn apply_matting(&mut self, id: &str, params: Value) -> Result<Value> {
        self.layer_workflow(id, params, false)
    }

    /// 图层复合命令（U64）：命令 id 必须先由集成侧发布到能力白名单。
    pub fn layer_comp_command(&mut self, id: &str, params: Value) -> Result<Value> {
        let result = self.layer_workflow(id, params, false)?;
        let comps = self.layer_comps()?;
        Ok(json!({ "result": result, "comps": comps }))
    }

    /// 复合命令的实际执行路径（域内测试可直接调用，跳过能力门禁）。
    #[cfg(test)]
    pub(crate) fn layer_comp_command_inner(&mut self, id: &str, params: Value) -> Result<Value> {
        let result = self.layer_workflow_inner(id, params, false)?;
        let comps = self.layer_comps()?;
        Ok(json!({ "result": result, "comps": comps }))
    }

    /// 粘贴入/外的选区与结果摘要（只读，供面板说明蒙版语义）。
    pub fn paste_region(&self) -> Result<Value> {
        let state = self.active_doc()?;
        Ok(json!({
            "selection": state.doc.selection.as_ref().map(|selection| rect_json(selection.content_bounds())),
            "clipboard": self.session.clipboard.as_ref().map(|clip| rect_json(clip.bounds)),
            "target": if crate::layer_preview::mask_target(state) { "mask" } else { "pixels" },
        }))
    }
}

fn label(id: &str) -> String {
    match id {
        "layer.linkLayers" => "链接图层",
        "layer.setLabelColor" => "图层颜色",
        "layer.new.layerViaCut" => "剪切建层",
        "layer.stampVisible" | "layer.stampDown" => "盖印图层",
        "edit.pasteSpecial.pasteInto" => "粘贴入",
        "edit.pasteSpecial.pasteOutside" => "粘贴外",
        "layer.layerStyle.blendingOptions" => "混合选项",
        "layer.matting.defringe" => "去边",
        "layer.matting.colorDecontaminate" => "颜色净化",
        _ if id.starts_with("layerComp.") => "图层复合",
        _ if id.starts_with("layer.layerStyle.") || id.starts_with("style.presets.") => "图层样式",
        _ => "图层操作",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::Editor;

    fn sample_png(width: u32, height: u32) -> Vec<u8> {
        use photocraft_doc::{Color, ColorMode, Document, SampleType, Size};
        let doc = Document::with_background("sample", Size { width, height }, ColorMode::Rgb, SampleType::U8, Color::rgb(0.2, 0.4, 0.6));
        photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default()).unwrap().bytes
    }

    fn editor() -> Editor {
        let mut editor = Editor::new();
        editor.open_image("photo.png", None, &sample_png(32, 24)).unwrap();
        editor
    }

    /// 两层文档：底层背景 + 上两层像素，便于链接/盖印/转层。
    fn layered() -> Editor {
        let mut editor = editor();
        editor.execute("layer.new.layer", json!({"name":"上"})).unwrap();
        editor.execute("layer.new.layer", json!({"name":"中"})).unwrap();
        editor
    }

    fn select(editor: &mut Editor, ids: &[u64]) {
        for id in ids {
            editor.execute("layer.select", json!({"layer":id,"mode":"add"})).unwrap();
        }
    }

    /// 分派只认本域的命令组：其它域的 id 必须返回 `Ok(false)`，不能静默当成合法参数。
    #[test]
    fn check_dispatches_only_this_domains_groups_and_rejects_nested_keys() {
        let editor = layered();
        // 本域命令：被认出（`check` 返回 true 表示「属于本域」；前提不足只会返回 Err，不会返回 false）。
        for id in ["layer.linkLayers", "edit.pasteSpecial.pasteInto", "layer.layerStyle.blendingOptions", "layer.matting.defringe", "layerComp.new"] {
            let outcome = check(&editor.session, id, &Value::Null);
            assert!(outcome.is_ok() || outcome.as_ref().err().is_some_and(|error| !error.to_string().contains("不是本域")), "{id} 应被本域接管：{outcome:?}");
            assert_ne!(outcome.unwrap_or(true), false, "{id} 不应被本域判定为「不属于我」");
        }
        // 其它域命令：不属于本域（返回 false），交给各自的域校验。
        // 注意 `style.presets.apply` 属本域 U61，不能放在这里。
        for id in ["layer.new.layer", "edit.fillForeground", "layer.mergeDown", "layer.setProps"] {
            assert!(!check(&editor.session, id, &Value::Null).unwrap(), "{id} 不应被本域接管");
        }
        // 预设管理属本域，但参数不合法时返回 Err 而不是 false。
        assert!(check(&editor.session, "style.presets.apply", &Value::Null).is_err());
        // 嵌套键不能被顶层白名单漏过。
        let nested = check(&editor.session, "layer.linkLayers", &json!({"nested": {"x": 1}}));
        assert!(nested.is_err(), "未声明的顶层键必须被拒");
        let blend = check(&editor.session, "layer.layerStyle.blendingOptions", &json!({"blendIf": {"channel": "gray", "bogus": 1}}));
        assert!(blend.is_err(), "blendIf 项里的未知键必须被拒");
        let blend2 = check(&editor.session, "layer.layerStyle.blendingOptions", &json!({"bogus": true}));
        assert!(blend2.is_err());
    }

    /// U60：Blend If 端点、通道与挖空各自有界，且不合法值不被接受。
    #[test]
    fn blend_if_ranges_channels_and_knockout_are_validated() {
        let editor = layered();
        let id = "layer.layerStyle.blendingOptions";
        let ok = |params: Value| check(&editor.session, id, &params);
        // 合法：单对象、对象列表与四个端点的分离区间。
        assert!(ok(json!({"blendIf": {"channel": "gray", "thisLayer": [0, 255], "underlying": [0, 255]}})).is_ok());
        assert!(ok(json!({"blendIf": [{"channel": "red", "thisLayer": [30, 60, 200, 235]}]})).is_ok());
        assert!(ok(json!({"knockout": "shallow"})).is_ok());
        // 非法：端点乱序/越界/数量不对，未知通道，非法挖空与布尔字段。
        for bad in [
            json!({"blendIf": {"channel": "gray", "thisLayer": [255, 0]}}),
            json!({"blendIf": {"channel": "gray", "thisLayer": [0]}}),
            json!({"blendIf": {"channel": "gray", "thisLayer": [-1, 300]}}),
            json!({"blendIf": {"channel": "nope"}}),
            json!({"blendIf": "gray"}),
            json!({"knockout": "deepest"}),
            json!({"knockout": 3}),
            json!({"blendInteriorEffectsAsGroup": "yes"}),
            json!({"channels": [true, false]}),
        ] {
            assert!(ok(bad.clone()).is_err(), "{bad} 应被拒绝");
        }
    }

    /// U60：预览只读、提交恰为一步历史，且提交值来自当前参数而不是上一份预览。
    #[test]
    fn blend_preview_is_read_only_and_apply_is_one_history_step() {
        let mut editor = layered();
        let layer = editor.active_layer_id().unwrap().0;
        let before = editor.content_hash().unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();
        let preview = editor.layer_workflow_inner("layer.layerStyle.blendingOptions", json!({"layer":layer,"opacity":40}), true).unwrap();
        // 预览响应只有候选像素与修订号：没有 `changed`/`state`，即「没有提交」。
        assert!(preview.get("changed").is_none(), "预览不返回提交结果");
        assert!(preview.get("state").is_none(), "预览不返回新状态");
        assert!(preview["preview"]["pixels"].is_array(), "预览返回候选像素");
        assert_eq!(editor.content_hash().unwrap(), before, "预览不改内容身份");
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps, "预览不写历史");

        let applied = editor.layer_workflow_inner("layer.layerStyle.blendingOptions", json!({"layer":layer,"opacity":40}), false).unwrap();
        assert_eq!(applied["changed"], true);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps + 1, "提交恰为一步历史");
        assert!((editor.active_doc().unwrap().doc.layer(LayerId(layer)).unwrap().opacity - 0.4).abs() < 1e-6);
        // 无变化再提交不增历史。
        let same = editor.layer_workflow_inner("layer.layerStyle.blendingOptions", json!({"layer":layer,"opacity":40}), false).unwrap();
        assert_eq!(same["changed"], false);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps + 1);
    }

    /// U58：链接/标签/盖印在前提不满足时拒绝，且一律不写文档。
    #[test]
    fn links_labels_and_stamps_reject_unmet_preconditions_without_writing() {
        let mut editor = layered();
        let top = editor.active_layer_id().unwrap().0;
        let before = editor.content_hash().unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();
        // 非法颜色标签。
        assert!(check(&editor.session, "layer.setLabelColor", &json!({"color":"rainbow"})).is_err());
        assert_eq!(editor.content_hash().unwrap(), before);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);

        let bottom = editor.active_doc().unwrap().doc.layers.first().unwrap().id.0;
        select(&mut editor, &[bottom]);
        let linked = editor.layer_workflow_inner("layer.linkLayers", Value::Null, false).unwrap();
        assert_eq!(linked["changed"], true);
        assert!(editor.active_doc().unwrap().doc.layer(LayerId(top)).unwrap().link_group.is_some());
        let label = editor.layer_workflow_inner("layer.setLabelColor", json!({"color":"red","layer":top}), false).unwrap();
        assert_eq!(label["changed"], true);
        assert_eq!(editor.active_doc().unwrap().doc.layer(LayerId(top)).unwrap().label.id(), "red");
    }


    /// U58：链接必须真的协同变换，并且**尊重位置锁定**。
    ///
    /// 只断言「`link_group` 有值」不足以证明链接生效。这里直接走移动链路本身
    /// （`move_targets` + `moved`，Move 工具预览与提交用的就是这两个），验证：
    /// 链接层进入移动集合、锁定层被拒绝、拒绝时文档不变。
    #[test]
    fn linked_layers_move_together_and_position_locks_are_respected() {
        let mut editor = layered();
        // 背景层默认被位置锁定，取两个普通层；空层没有内容边界，先各填一块以便观察位移。
        let ids: Vec<LayerId> = editor.active_doc().unwrap().doc.walk().into_iter()
            .map(|(_, _, l)| l.id)
            .filter(|id| !editor.active_doc().unwrap().doc.effective_locks(*id).position)
            .collect();
        assert!(ids.len() >= 2, "需要两个未锁定图层");
        let (top, middle) = (ids[0], ids[1]);
        for id in [top, middle] {
            editor.execute("layer.select", json!({"layer":id.0})).unwrap();
            editor.execute("edit.fillForeground", json!({"color":"#3366ff"})).unwrap();
        }

        // 链接前：移动集合只有自己。
        let alone = photocraft_engine::layer_multi_cmds::move_targets(&editor.active_doc().unwrap().doc, &[middle]);
        assert_eq!(alone, vec![middle], "未链接时只应移动自己");

        // 链接后：移动集合包含链接层。
        select(&mut editor, &[top.0, middle.0]);
        editor.layer_workflow_inner("layer.linkLayers", Value::Null, false).unwrap();
        assert!(editor.active_doc().unwrap().doc.layer(top).unwrap().link_group.is_some());
        let doc = editor.active_doc().unwrap().doc.clone();
        let together = photocraft_engine::layer_multi_cmds::move_targets(&doc, &[middle]);
        assert!(together.contains(&top), "链接层必须进入移动集合：{together:?}");
        assert!(together.contains(&middle));

        // 真移动：两层的内容边界一起平移。
        let x_of = |doc: &Document, id: LayerId| doc.layer(id).and_then(|l| l.surface().map(|s| s.content_bounds().x0));
        let (x_top, x_mid) = (x_of(&doc, top).unwrap(), x_of(&doc, middle).unwrap());
        let after = photocraft_engine::layer_multi_cmds::moved(&doc, &together, 7, 5).unwrap();
        assert_eq!(x_of(&after, middle).unwrap() - x_mid, 7, "被移动层必须位移");
        assert_eq!(x_of(&after, top).unwrap() - x_top, 7, "链接层必须跟随");

        // 位置锁定：移动被拒，且原文档不变（上游 `moved_target` 在改动前就返回错误）。
        let mut locked_doc = (*doc).clone();
        locked_doc.layer_mut(middle).unwrap().locks.position = true;
        let error = photocraft_engine::layer_multi_cmds::moved(&locked_doc, &[middle], 3, 3).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("位置") || message.to_lowercase().contains("position"), "{message}");
        assert_eq!(x_of(&locked_doc, middle), x_of(&doc, middle), "被拒绝的移动不能改内容");
    }

    #[test]
    fn paste_into_requires_selection_and_clipboard_and_keeps_the_clipboard() {
        let mut editor = layered();
        let id = "edit.pasteSpecial.pasteInto";
        let empty = check(&editor.session, id, &Value::Null).unwrap_err();
        assert!(empty.to_string().contains("选区"), "{empty}");
        editor.execute("edit.fillForeground", json!({"color":"#3366cc"})).unwrap();
        editor.execute("select.all", Value::Null).unwrap();
        editor.execute("edit.copy", Value::Null).unwrap();
        // 选区仍在：粘贴入可用，且蒙版语义来自选区。
        let region = editor.paste_region().unwrap();
        assert_eq!(region["target"], "pixels");
        assert!(region["selection"].as_array().is_some_and(|rect| rect.len() == 4));
        let steps = editor.active_doc().unwrap().history.past_len();
        let applied = editor.layer_workflow_inner(id, Value::Null, false).unwrap();
        assert_eq!(applied["changed"], true);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps + 1);
        let mask = editor.active_doc().unwrap().doc.layers.iter().find_map(|layer| layer.mask.as_ref()).expect("粘贴入生成蒙版");
        assert!(!mask.linked, "粘贴入蒙版不跟随图层变换");
        // 原剪贴板不变：仍能再次粘贴外。
        editor.execute("select.rect", json!({"x":2,"y":2,"width":8,"height":8})).unwrap();
        let outside = editor.layer_workflow_inner("edit.pasteSpecial.pasteOutside", Value::Null, false).unwrap();
        assert_eq!(outside["changed"], true);
        assert!(editor.session.clipboard.is_some());
    }

    #[test]
    fn style_presets_scale_effects_and_layer_conversion_are_validated() {
        let mut editor = layered();
        let layer = editor.active_layer_id().unwrap().0;
        // 未复制样式不能粘贴。
        assert!(check(&editor.session, "layer.layerStyle.pasteLayerStyle", &json!({"layer":layer})).is_err());
        // 未知预设与越界缩放拒绝。
        assert!(check(&editor.session, "style.presets.apply", &json!({"preset":"不存在的预设"})).is_err());
        assert!(check(&editor.session, "style.presets.apply", &json!({"preset":""})).is_err());
        for scale in [json!(0), json!(1001), json!("100"), json!(null)] {
            assert!(check(&editor.session, "layer.layerStyle.scaleEffects", &json!({"layer":layer,"scale":scale})).is_err(), "{scale}");
        }
        // 没有效果不能转层或栅格化。
        assert!(check(&editor.session, "layer.layerStyle.createLayer", &json!({"layer":layer})).is_err());
        assert!(check(&editor.session, "layer.rasterize.layerStyle", &json!({"layer":layer})).is_err());
        // 转层前后：效果资源留在文档内，一步撤销恢复。
        editor.session.execute("layer.layerStyle.dropShadow", json!({"layer":layer,"distance":8})).unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();
        let created = editor.layer_workflow_inner("layer.layerStyle.createLayer", json!({"layer":layer}), false).unwrap();
        assert_eq!(created["changed"], true);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps + 1);
        editor.undo().unwrap();
        assert!(!editor.active_doc().unwrap().doc.layer(LayerId(layer)).unwrap().effects.items.is_empty());
        // 复制后样式可跨层粘贴。
        editor.layer_workflow_inner("layer.layerStyle.copyLayerStyle", json!({"layer":layer}), false).unwrap();
        let bottom = editor.active_doc().unwrap().doc.layers.first().unwrap().id.0;
        let pasted = editor.layer_workflow_inner("layer.layerStyle.pasteLayerStyle", json!({"layer":bottom}), false).unwrap();
        assert_eq!(pasted["changed"], true);
        assert!(!editor.active_doc().unwrap().doc.layer(LayerId(bottom)).unwrap().effects.items.is_empty());

        // U61 效果转层：源/目标/序号/复制标志的前置条件提前拒绝，且拒绝时不写历史。
        let empty = editor.active_doc().unwrap().doc.layers.iter()
            .find(|item| item.effects.items.is_empty() && item.id.0 != bottom)
            .map(|item| item.id.0)
            .expect("还有没有效果的图层");
        let steps = editor.active_doc().unwrap().history.past_len();
        assert!(check(&editor.session, "layer.layerStyle.transferEffects", &json!({"from":empty,"to":bottom})).is_err());
        assert!(check(&editor.session, "layer.layerStyle.transferEffects", &json!({"from":bottom,"to":bottom})).is_err());
        assert!(check(&editor.session, "layer.layerStyle.transferEffects", &json!({"from":bottom,"to":9_999})).is_err());
        assert!(check(&editor.session, "layer.layerStyle.transferEffects", &json!({"from":9_999,"to":empty})).is_err());
        assert!(check(&editor.session, "layer.layerStyle.transferEffects", &json!({"from":bottom,"to":empty,"effect":7})).is_err());
        assert!(check(&editor.session, "layer.layerStyle.transferEffects", &json!({"from":bottom,"to":empty,"effect":"0"})).is_err());
        assert!(check(&editor.session, "layer.layerStyle.transferEffects", &json!({"from":bottom,"to":empty,"copy":"yes"})).is_err());
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps, "拒绝不得写历史");
        // 合法复制：目标层拿到效果，源层保留。
        let copied = editor.layer_workflow_inner("layer.layerStyle.transferEffects", json!({"from":bottom,"to":empty,"copy":true}), false).unwrap();
        assert_eq!(copied["changed"], true);
        assert!(!editor.active_doc().unwrap().doc.layer(LayerId(empty)).unwrap().effects.items.is_empty());
        assert!(!editor.active_doc().unwrap().doc.layer(LayerId(bottom)).unwrap().effects.items.is_empty());
        // 移动单个效果：源层少一项，目标层多一项，一步撤销复原。
        let before_src = editor.active_doc().unwrap().doc.layer(LayerId(bottom)).unwrap().effects.items.len();
        let moved = editor.layer_workflow_inner("layer.layerStyle.transferEffects", json!({"from":bottom,"to":empty,"effect":0}), false).unwrap();
        assert_eq!(moved["changed"], true);
        assert_eq!(editor.active_doc().unwrap().doc.layer(LayerId(bottom)).unwrap().effects.items.len(), before_src - 1);
        editor.undo().unwrap();
        assert_eq!(editor.active_doc().unwrap().doc.layer(LayerId(bottom)).unwrap().effects.items.len(), before_src);
    }

    /// U61：样式预设**管理**（列出/保存/整理/恢复默认）必须真的可达。
    ///
    /// 预设是会话偏好，不是文档内容：这些命令不推进修订、不写历史、不改变内容指纹。
    /// 若把它当文档命令跑在隔离会话上，改动就永远回传不到真实会话。
    #[test]
    fn style_preset_management_is_reachable_and_never_touches_the_document() {
        let mut editor = layered();
        let layer = editor.active_layer_id().unwrap().0;
        // 先给图层加效果（这是一次真实的文档写入），再取基线：预设管理本身不得改变这些。
        editor.session.execute("layer.layerStyle.dropShadow", json!({"layer":layer,"distance":8})).unwrap();
        let before = editor.content_hash().unwrap();
        let revision = editor.revision().unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();

        // 列出：真组名与预设名都来自真实会话库。
        let listed = editor.layer_workflow_inner("style.presets.list", json!({}), false).unwrap();
        assert_eq!(listed["changed"], false);
        let groups = listed["presets"]["groups"].as_array().expect("预设组列表");
        assert!(!groups.is_empty(), "内置样式组必须可列出");
        assert!(groups[0]["presets"].as_array().is_some_and(|items| !items.is_empty()));
        // list 只读参数：未知键必须拒绝，避免把拼写错误当成「列出全部」。
        assert!(check(&editor.session, "style.presets.list", &json!({"nope":1})).is_err());

        // 新建：从当前层效果保存一个预设，随后能列出并应用。
        let created = editor.layer_workflow_inner("style.presets.new", json!({"name":"回归样式","layer":layer}), false).unwrap();
        assert_eq!(created["changed"], false, "预设不写文档");
        let names: Vec<String> = editor.session.presets.styles.iter()
            .flat_map(|group| group.items.iter())
            .map(|preset| preset.name.clone())
            .collect();
        assert!(names.iter().any(|name| name == "回归样式"), "新预设进入会话库：{names:?}");
        // 同一份输入在真实会话上可被 apply 引用（此前只有 apply 时无法先建再列）。
        assert!(check(&editor.session, "style.presets.apply", &json!({"preset":"回归样式"})).is_ok());

        // 改名：旧名失效、新名可用。
        let renamed = editor.layer_workflow_inner(
            "style.presets.edit",
            json!({"action":"rename","preset":"回归样式","name":"改名样式"}),
            false,
        ).unwrap();
        assert_eq!(renamed["changed"], false);
        assert!(check(&editor.session, "style.presets.edit", &json!({"action":"rename","preset":"回归样式","name":"x"})).is_err());
        assert!(check(&editor.session, "style.presets.apply", &json!({"preset":"改名样式"})).is_ok());

        // 删除：删掉后不可再应用；未知名称按「全有或全无」拒绝。
        editor.layer_workflow_inner("style.presets.edit", json!({"action":"delete","preset":"改名样式"}), false).unwrap();
        assert!(check(&editor.session, "style.presets.apply", &json!({"preset":"改名样式"})).is_err());
        assert!(check(&editor.session, "style.presets.edit", &json!({"action":"delete","preset":["Default Style (None)","缺失"]})).is_err());
        // 未知 action 与未知组明确拒绝。
        assert!(check(&editor.session, "style.presets.edit", &json!({"action":"nope"})).is_err());
        assert!(check(&editor.session, "style.presets.edit", &json!({"action":"deleteGroup","group":"没有这个组"})).is_err());

        // 恢复默认：删掉内置预设后 reset 能把它放回来。
        editor.session.presets.styles.clear();
        assert!(check(&editor.session, "style.presets.apply", &json!({"preset":"Default Style (None)"})).is_err());
        let reset = editor.layer_workflow_inner("style.presets.reset", json!({}), false).unwrap();
        assert_eq!(reset["changed"], false);
        assert!(check(&editor.session, "style.presets.apply", &json!({"preset":"Default Style (None)"})).is_ok());

        // 效果默认值也属「管理」：读回用户默认、写入后再读回，且都不碰文档。
        let factory = editor.layer_workflow_inner("layer.layerStyle.defaultFor", json!({"kind":"dropShadow"}), false).unwrap();
        assert_eq!(factory["changed"], false);
        assert_eq!(factory["presets"]["user"], false, "未设置过时应回落到出厂默认");
        assert!(check(&editor.session, "layer.layerStyle.defaultFor", &json!({"kind":"nope"})).is_err());
        assert!(check(&editor.session, "layer.layerStyle.makeDefault", &json!({"kind":"dropShadow"})).is_err());
        assert!(check(&editor.session, "layer.layerStyle.makeDefault", &json!({"kind":"dropShadow","params":[]})).is_err());
        editor.layer_workflow_inner(
            "layer.layerStyle.makeDefault",
            json!({"kind":"dropShadow","params":{"distance":3}}),
            false,
        ).unwrap();
        let saved = editor.layer_workflow_inner("layer.layerStyle.defaultFor", json!({"kind":"dropShadow"}), false).unwrap();
        assert_eq!(saved["presets"]["user"], true, "写入后必须读回用户默认");
        assert_eq!(saved["presets"]["params"]["distance"], 3);

        // 全部管理操作都不碰文档：指纹、修订、历史都不变。
        assert_eq!(editor.content_hash().unwrap(), before, "预设管理不改内容指纹");
        assert_eq!(editor.revision().unwrap(), revision, "预设管理不改文档修订");
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps, "预设管理不写历史");
    }

    #[test]
    fn matting_requires_pixels_and_bounded_parameters() {
        let mut editor = layered();
        let layer = editor.active_layer_id().unwrap().0;
        assert!(check(&editor.session, "layer.matting.defringe", &json!({"width":0})).is_err());
        assert!(check(&editor.session, "layer.matting.defringe", &json!({"width":201})).is_err());
        assert!(check(&editor.session, "layer.matting.colorDecontaminate", &json!({"amount":101})).is_err());
        assert!(check(&editor.session, "layer.matting.colorDecontaminate", &json!({"radius":0})).is_err());
        // 调整层/组不是像素层。
        editor.execute("layer.newAdjustmentLayer.brightnessContrast", Value::Null).unwrap();
        let adjustment = editor.active_layer_id().unwrap().0;
        let reason = check(&editor.session, "layer.matting.defringe", &json!({"layer":adjustment})).unwrap_err();
        assert!(reason.to_string().contains("像素层"), "{reason}");
        // 锁定层拒绝（锁定的作用对象是当前选择）。
        editor.execute("layer.select", json!({"layer":layer})).unwrap();
        editor.execute("layer.lockLayers", json!({"all":true})).unwrap();
        assert!(check(&editor.session, "layer.matting.removeBlackMatte", &json!({"layer":layer})).is_err());
        editor.execute("layer.lockLayers", json!({"all":false})).unwrap();
        // 制造软边：矩形选区羽化后填色，边缘像素才有可去的杂边。
        editor.execute("select.rect", json!({"x":4,"y":4,"width":12,"height":10})).unwrap();
        editor.execute("select.modify.feather", json!({"radius":3})).unwrap();
        editor.execute("edit.fillForeground", json!({"color":"#3366cc"})).unwrap();
        editor.execute("select.deselect", Value::Null).unwrap();
        let hash = editor.content_hash().unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();
        let preview = editor.layer_workflow_inner("layer.matting.defringe", json!({"layer":layer,"width":2}), true).unwrap();
        assert!(preview["preview"]["pixels"].as_array().is_some_and(|pixels| !pixels.is_empty()));
        assert_eq!(editor.content_hash().unwrap(), hash);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
        let applied = editor.layer_workflow_inner("layer.matting.removeWhiteMatte", json!({"layer":layer}), false).unwrap();
        assert_eq!(applied["changed"], true, "羽化边缘的半透明像素被反预乘");
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps + 1);
        editor.undo().unwrap();
        assert_eq!(editor.content_hash().unwrap(), hash, "撤销恢复原像素");
        // 净化只移动软边像素的颜色；纯色实心区域没有可去的颜色差，属于无变化，不进历史。
        let untouched = editor.layer_workflow_inner("layer.matting.colorDecontaminate", json!({"layer":layer,"amount":100,"radius":4}), false).unwrap();
        assert_eq!(untouched["changed"], false, "无颜色差时不应写入");
        assert_eq!(editor.content_hash().unwrap(), hash);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
    }


    #[test]
    fn layer_comps_round_trip_and_report_missing_layers() {
        let mut editor = layered();
        let state = editor.layer_comps().unwrap();
        assert_eq!(state["comps"].as_array().unwrap().len(), 0);
        assert_eq!(state["hasLastDocumentState"], false);
        // 没有复合时不能 apply/update。
        for id in ["layerComp.apply", "layerComp.update", "layerComp.delete", "layerComp.previous"] {
            assert!(check(&editor.session, id, &Value::Null).is_err(), "{id}");
        }
        editor.layer_comp_command_inner("layerComp.new", json!({"name":"显示态"})).unwrap();
        let comps = editor.layer_comps().unwrap();
        assert_eq!(comps["comps"][0]["name"], "显示态");
        assert_eq!(comps["comps"][0]["layers"], editor.active_doc().unwrap().doc.walk().len());
        assert_eq!(comps["lastApplied"], comps["comps"][0]["id"]);
        // 隐藏一层后更新可用；应用只恢复声明字段。
        let hide = editor.active_layer_id().unwrap().0;
        editor.session.execute("layer.setProps", json!({"layer":hide,"visible":false})).unwrap();
        let updated = editor.layer_comp_command_inner("layerComp.update", json!({"comp":"显示态","what":"visibility"})).unwrap();
        assert_eq!(updated["result"]["changed"], true);
        editor.session.execute("layer.setProps", json!({"layer":hide,"visible":true})).unwrap();
        editor.layer_comp_command_inner("layerComp.apply", json!({"comp":"显示态"})).unwrap();
        assert!(!editor.active_doc().unwrap().doc.layer(LayerId(hide)).unwrap().visible);
        // 名称校验与预算。
        assert!(check(&editor.session, "layerComp.new", &json!({"name":""})).is_err());
        assert!(check(&editor.session, "layerComp.rename", &json!({"comp":9999,"name":"x"})).is_err());
        // 重开后复合仍有效。
        let bytes = editor.save_project().unwrap();
        let mut reopened = Editor::new();
        reopened.open_project(&bytes, None).unwrap();
        assert_eq!(reopened.layer_comps().unwrap()["comps"][0]["name"], "显示态");
        assert_eq!(photocraft_project_verify::verify(&bytes).unwrap().layer_count, 3);
    }

    /// U64：缺失层报告必须真的送到面板，而不是只回一个「成功」。
    ///
    /// 上游 `layerComp.updateWarnings` 的报告在命令返回值里（不在文档里）。统一入口若丢掉它，
    /// 面板就只能显示「检查完成」而拿不到缺失层清单——这正是之前 U64 的缺口。
    #[test]
    fn comp_missing_layer_report_reaches_the_caller() {
        let mut editor = layered();
        editor.layer_comp_command_inner("layerComp.new", json!({"name":"报告态"})).unwrap();
        // 没有缺失层时报告为空数组（不是缺字段）。
        let clean = editor.layer_comp_command_inner("layerComp.updateWarnings", json!({"comp":"报告态"})).unwrap();
        assert_eq!(clean["result"]["result"]["warnings"].as_array().map(Vec::len), Some(0));
        assert_eq!(clean["result"]["changed"], false, "只读报告不能写历史");
        // 删掉一层后必须点名缺失层，且被删层不出现在报告之外的地方。
        let gone = editor.active_doc().unwrap().doc.walk()[0].2.id.0;
        editor.session.execute("layer.delete", json!({"layer":gone})).unwrap();
        let report = editor.layer_comp_command_inner("layerComp.updateWarnings", json!({"comp":"报告态"})).unwrap();
        let warnings = report["result"]["result"]["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0]["missingLayers"], json!([gone]));
        assert_eq!(warnings[0]["name"], "报告态");
        // 报告本身不改文档：切复合仍成功，并把缺失层跳过。
        let applied = editor.layer_comp_command_inner("layerComp.apply", json!({"comp":"报告态"})).unwrap();
        assert_eq!(applied["result"]["changed"], true);
    }

    /// U64：复合要能**交付快照**，而不只是行摘要。
    ///
    /// 快照必须严格跟随该复合声明的三个选项：未声明的字段为 `null`，因为这些字段切复合时
    /// 不会恢复。若快照给出全部字段，宿主就无法判断「切过去到底改了什么」。
    #[test]
    fn layer_comp_snapshot_delivers_exactly_the_declared_fields() {
        let mut editor = layered();
        // 只保存可见性：位置与外观必须为 null。
        editor.layer_comp_command_inner(
            "layerComp.new",
            json!({"name":"仅可见","visibility":true,"position":false,"appearance":false}),
        ).unwrap();
        let snapshot = editor.layer_comps().unwrap()["comps"][0]["snapshot"].clone();
        let entries = snapshot.as_array().expect("快照必须逐层给出");
        assert_eq!(entries.len(), editor.active_doc().unwrap().doc.walk().len());
        for entry in entries {
            assert!(entry["visible"].is_boolean(), "声明的可见性必须给出具体值");
            assert_eq!(entry["position"], Value::Null, "未声明位置时必须为 null");
            assert_eq!(entry["appearance"], Value::Null, "未声明外观时必须为 null");
        }

        // 三项都声明：位置与外观给出规范值，且外观的混合模式用规范名。
        editor.layer_comp_command_inner(
            "layerComp.new",
            json!({"name":"全量","visibility":true,"position":true,"appearance":true}),
        ).unwrap();
        let full = editor.layer_comps().unwrap()["comps"][1]["snapshot"].clone();
        let entry = full.as_array().unwrap().iter()
            .find(|entry| entry["appearance"] != Value::Null)
            .expect("至少一层带外观");
        assert!(entry["visible"].is_boolean());
        let appearance = &entry["appearance"];
        assert!(appearance["opacity"].is_number());
        assert!(appearance["fillOpacity"].is_number());
        // 混合模式是规范名（小写连字符），不是 Rust 枚举的 Debug 名。
        let blend = appearance["blend"].as_str().unwrap();
        assert_eq!(blend, blend.to_lowercase());
        // 外观里的效果以内核声明顺序给出，是数组（可能为空，但绝不能缺失）。
        assert!(appearance["effects"]["items"].is_array(), "效果列表必须存在");
        assert!(appearance["effects"]["enabled"].is_boolean());

        // 快照是只读交付：取它不写历史、不改修订。
        let revision = editor.revision().unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();
        let _ = editor.layer_comps().unwrap();
        assert_eq!(editor.revision().unwrap(), revision);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
    }

    #[test]
    fn comp_budget_blocks_new_comps_without_touching_the_document() {
        let mut editor = layered();
        {
            let state = editor.active_doc().unwrap();
            assert!(MAX_LAYER_COMPS >= 64);
            let _ = state;
        }
        for index in 0..MAX_LAYER_COMPS {
            editor.layer_comp_command_inner("layerComp.new", json!({"name":format!("复合 {index}")})).unwrap();
        }
        let before = editor.content_hash().unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();
        let reason = editor.layer_workflow_inner("layerComp.new", json!({"name":"超限"}), false).unwrap_err();
        assert!(reason.to_string().contains("上限"), "{reason}");
        assert!(editor.layer_workflow_inner("layerComp.duplicate", json!({"comp":0}), false).is_err());
        assert_eq!(editor.content_hash().unwrap(), before);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
    }
}
