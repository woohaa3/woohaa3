//! P6：修饰笔迹与参数滤镜
//! （change: 2026-10-22-complete-photocraft-webui-editing，P6 / design D8；
//! change: 2026-10-22-add-photocraft-retouch-workflows，U37/U38/U39）。
//!
//! ## 统一约束
//!
//! 所有修饰与滤镜都先过 [`crate::adjustment_ext::writable_pixel_layer`]：目标必须是可写像素层；
//! 文字层要求显式栅格化，智能对象要求编辑内容或显式栅格化——**不悄悄改写**。
//!
//! ## 笔迹预览
//!
//! - 仿制图章、修复画笔：上游有 `LiveRetouch`，预览与提交共用同一实现；
//! - 图案图章、历史画笔、移除与其余局部修饰（模糊／锐化／涂抹／减淡／加深／海绵）：上游没有
//!   live stroke，本模块用「本笔基线冻结 + 逐步重放」保持预览与提交一致，重放走同一个上游命令。
//!   历史画笔的重放会话另外植入所选历史源，否则重放会话里没有源内容。
//!
//! ## 区域操作预览（U37）
//!
//! 修补、内容识别移动与红眼是「先选区域/点、再一次计算」的命令：本模块在隔离会话里先算候选
//! 文档作为预览，确认时才在正式会话执行同一命令一次（一步历史），取消只丢弃候选。
//!
//! ## 参数滤镜
//!
//! 高斯模糊与 USM 锐化使用隔离草稿：预览只改候选文档，确认才提交一步历史，取消恢复原内容。

use photocraft_doc::{Document, LayerId};
use photocraft_engine::Session;
use serde_json::{Value, json};
use std::sync::Arc;

use crate::error::{EditorError, Result};

fn error(id: impl std::fmt::Display, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.to_string(), message: message.to_string() }
}

/// 图标量错误（`&'static str`）的便捷包装，避免调用点写出完整的 Display 边界。
fn static_error(id: &'static str, message: impl std::fmt::Display) -> EditorError {
    error(id, message)
}

/// 支持 live stroke 的修饰命令（走上游 `LiveRetouch`）。
pub const LIVE_RETOUCH: &[&str] = &["paint.cloneStamp", "paint.healingBrush"];

/// 需要「基线 + 重放」预览的局部修饰命令（上游无 live stroke）。
///
/// `paint.patternStamp`（U38）与 `paint.historyBrush`（U38）参数形态与笔迹完全相同，因此复用同一
/// 重放机制；`paint.remove`（U37）按笔迹提交，也是一步历史。
pub const REPLAY_RETOUCH: &[&str] = &[
    "paint.blur",
    "paint.sharpen",
    "paint.smudge",
    "paint.dodge",
    "paint.burn",
    "paint.sponge",
    "paint.patternStamp",
    "paint.historyBrush",
    "paint.remove",
];

/// 先选区域/点、再一次计算并提交的区域命令（没有逐帧笔迹预览）。
pub const REGION_RETOUCH: &[&str] = &["paint.patch", "paint.contentAwareMove", "paint.redEye"];

/// 采样点/偏移是必需参数的命令。
pub const SOURCE_RETOUCH: &[&str] = &["paint.cloneStamp", "paint.healingBrush"];

/// 修饰命令是否是本能力开放的。
pub fn is_retouch_command(id: &str) -> bool {
    LIVE_RETOUCH.contains(&id) || REPLAY_RETOUCH.contains(&id) || id == "paint.spotHealing"
}

/// 命令的 `mode` 是否是混合模式（否则 `mode` 表示工具语义，例如海绵的增/减饱和）。
fn mode_is_blend(id: &str) -> bool {
    matches!(
        id,
        "paint.cloneStamp" | "paint.healingBrush" | "paint.spotHealing" | "paint.patternStamp" | "paint.historyBrush"
    )
}

/// 减淡/加深的可选范围。
const TONE_RANGES: &[&str] = &["shadows", "midtones", "highlights"];

/// 归一化笔迹参数：把通用画笔补丁修成本命令真正接受的形态。
///
/// 通用笔迹模板总会写入 `"mode":"normal"`，但海绵的 `mode` 只接受 `desaturate`/`saturate`
/// （上游 `DabTool::parse`），上轮实测因此报错并让编辑器落进错误边界。这里在**唯一入
/// 口**修正：海绵没有合法 `mode` 时改用工具选项或默认值；其它命令保留混合模式。
pub fn normalize_stroke_params(id: &str, params: &Value) -> Value {
    let mut params = params.clone();
    // 先把前端工具选项的别名映射成上游参数名，再清理不认识的键（顺序不能反）。
    if id == "paint.historyBrush" && params.get("state").and_then(Value::as_u64).is_none() {
        // 前端用 `historyState` 传历史源索引；内核参数名是 `state`。
        //
        // 原样搬到 `state`（不 `unwrap_or(0)`）：`-1`、`1.5`、`"2"` 这类非法值要留给
        // `validate_tool_params` 拒绝。早先的默认值会把它们静默变成「最旧状态」，用户看到
        // 成功、拿到的却是完全不同的内容。
        if let Some(state) = params.get("historyState").cloned() {
            params["state"] = state;
        }
    }
    if id == "paint.patternStamp" {
        if params.get("pattern").and_then(Value::as_str).is_none()
            && let Some(selected) = params.get("patternId").and_then(Value::as_str)
        {
            params["pattern"] = json!(selected);
        }
        let aliases = [("patternScale", "scale"), ("patternAngle", "angle"), ("patternImpressionist", "impressionist")];
        for (from, to) in aliases {
            if params.get(to).is_none()
                && let Some(value) = params.get(from).cloned()
            {
                params[to] = value;
            }
        }
    }
    if matches!(id, "paint.dodge" | "paint.burn")
        && params.get("range").is_none()
        && let Some(range) = params.get("toneRange").cloned()
    {
        params["range"] = range;
    }
    if id == "paint.remove" {
        for (from, to) in [("removeNewLayer", "newLayer"), ("removeCloseLoops", "closeLoops")] {
            if params.get(to).is_none()
                && let Some(value) = params.get(from).cloned()
            {
                params[to] = value;
            }
        }
    }
    if id == "paint.sponge" {
        let current = params.get("mode").and_then(Value::as_str).unwrap_or_default();
        if !matches!(current, "desaturate" | "saturate") {
            let requested = params
                .get("spongeMode")
                .and_then(Value::as_str)
                .filter(|value| matches!(*value, "desaturate" | "saturate"))
                .unwrap_or("desaturate");
            params["mode"] = json!(requested);
        }
    } else if !mode_is_blend(id)
        && let Some(map) = params.as_object_mut()
    {
        // 这些命令的 `mode` 不是混合模式（上游 `dab_cmd` 不读 `mode`）；不要发送会被误读的值。
        map.remove("mode");
    }
    if let Some(map) = params.as_object_mut() {
        // 这些是前端工具选项的键，不是上游命令参数（别名已在上方映射）。
        for key in [
            "spongeMode",
            "toneRange",
            "historyState",
            "patternId",
            "patternScale",
            "patternAngle",
            "patternImpressionist",
            "removeNewLayer",
            "removeCloseLoops",
        ] {
            map.remove(key);
        }
    }
    params
}

/// 逐命令校验工具专用参数，返回明确的拒绝原因。
fn validate_tool_params(id: &str, params: &Value) -> Result<()> {
    match id {
        "paint.dodge" | "paint.burn" => {
            if let Some(range) = params.get("range").and_then(Value::as_str)
                && !TONE_RANGES.contains(&range)
            {
                return Err(error(id, format!("范围 {range} 不受支持（shadows|midtones|highlights）")));
            }
            if let Some(exposure) = params.get("exposure").and_then(Value::as_f64)
                && !(1.0..=100.0).contains(&exposure)
            {
                return Err(error(id, "曝光必须在 1–100 之间"));
            }
        }
        "paint.sponge" => {
            let mode = params.get("mode").and_then(Value::as_str).unwrap_or("desaturate");
            if !matches!(mode, "desaturate" | "saturate") {
                return Err(error(id, format!("海绵模式 {mode} 不受支持（desaturate|saturate）")));
            }
        }
        "paint.smudge" | "paint.blur" | "paint.sharpen" => {
            if let Some(strength) = params.get("strength").and_then(Value::as_f64)
                && !(1.0..=100.0).contains(&strength)
            {
                return Err(error(id, "强度必须在 1–100 之间"));
            }
        }
        "paint.historyBrush" => {
            // 历史源索引必须是具体的历史状态：非法索引若被当成 0，会恢复**别的**状态的内容
            // 并报告成功。这里显式拒绝，给出可操作的范围提示。
            if let Some(state) = params.get("state")
                && state.as_u64().is_none()
            {
                return Err(error(
                    id,
                    format!("历史源索引必须是非负整数（state={state}）"),
                ));
            }
        }
        "paint.patternStamp" => {
            if let Some(scale) = params.get("scale").and_then(Value::as_f64)
                && !(1.0..=1000.0).contains(&scale)
            {
                return Err(error(id, "图案缩放必须在 1–1000 % 之间"));
            }
            if let Some(angle) = params.get("angle").and_then(Value::as_f64)
                && !angle.is_finite()
            {
                return Err(error(id, "图案角度必须是有限数值"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// 校验修饰命令的目标与参数，返回要作用于的像素层。
///
/// 采样层模式（`current` / `currentAndBelow` / `all`）只影响读取，不改变目标必须可写这一事实。
///
/// **不**在缺少 `layer` 时猜目标：早先取「文档最上层」与内核的「活动层」语义不一致（活动层
/// 通常是中间层），会让不带 `layer` 的落笔写到用户没选中的图层。缺省目标的补齐发生在拿得到
/// 会话的两处入口：[`RetouchBaseline::begin`]（笔迹，用 `active_layer`）与
/// [`RetouchOpDraft::begin`]（区域，同样用 `active_layer`）。
pub fn prepare_retouch(
    document: &Document,
    id: &str,
    params: &Value,
) -> Result<LayerId> {
    if !is_retouch_command(id) {
        return Err(static_error("paint.retouch", format!("{id} 不是已开放的修饰命令")));
    }
    let layer = params
        .get("layer")
        .and_then(Value::as_u64)
        .map(LayerId)
        .ok_or_else(|| static_error("paint.retouch", "缺少目标图层 layer"))?;
    crate::adjustment_ext::writable_pixel_layer(document, layer)?;
    if let Some(source) = params.get("sampleLayer").and_then(Value::as_str) {
        if !matches!(source, "current" | "currentAndBelow" | "all" | "currentAndBelowVisible") {
            return Err(static_error("paint.retouch", format!("采样层模式 {source} 不受支持")));
        }
    }
    validate_tool_params(id, params)?;
    // 仿制图章与修复画笔的取样来源在这里**不**判定：活动仿制源槽位（U39）也能提供来源，
    // 而槽位属于会话状态。该判定由 [`RetouchBaseline::begin`] 在实际落笔前完成，见
    // [`prepare_stroke_target`]。
    Ok(layer)
}

/// 落笔前的目标 + 来源校验：`prepare_retouch` 再加「必须有来源」。
///
/// 显式 `source`/`offset` 优先；否则看活动仿制源槽位是否已设过采样点（`cloneSource.set`）。
///
/// `params` 没写 `layer` 时用**当前活动层**（与内核 `parse_brush` / 区域命令的
/// `target_layer` 一致），而不是文档最上层；用户没选中的图层绝不被隐式改写。
pub fn prepare_stroke_target(session: &Session, id: &str, params: &Value) -> Result<LayerId> {
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let mut params = params.clone();
    if let Some(map) = params.as_object_mut()
        && map.get("layer").and_then(Value::as_u64).is_none()
    {
        match state.active_layer {
            Some(layer) => map.insert("layer".into(), json!(layer.0)),
            None => return Err(error(id, "没有活动图层；请先在图层面板选择一个像素层")),
        };
    }
    let layer = prepare_retouch(&state.doc, id, &params)?;
    if SOURCE_RETOUCH.contains(&id) && !has_explicit_source(&params) {
        let slot_has_source = session.presets.clone.active().source.is_some();
        if !slot_has_source {
            return Err(error(id, "需要采样点（source）或偏移（offset）；先用 Alt+单击或在仿制源面板设置采样点"));
        }
    }
    Ok(layer)
}

/// 仿制/修复的取样来源：显式 `source`/`offset`，或**活动仿制源槽位**已经设过采样点。
///
/// 槽位来源只有拿到会话才能判断，因此这里只做「显式参数」的部分；槽位回退在
/// [`RetouchBaseline::begin`] 里用同一判定补齐，避免同一个条件写两种结论。
pub fn has_explicit_source(params: &Value) -> bool {
    params.get("source").and_then(Value::as_array).is_some_and(|pair| pair.len() == 2)
        || params.get("offset").and_then(Value::as_array).is_some_and(|pair| pair.len() == 2)
}


/// 需要会话/文档资源才能判定的参数（图案来源）。
fn validate_session_params(
    session: &Session,
    state: &photocraft_engine::DocState,
    id: &str,
    params: &Value,
) -> Result<()> {
    if id == "paint.patternStamp" {
        let requested = params.get("pattern").and_then(Value::as_str).unwrap_or_default();
        // 空 key 表示「用图案面板当前图案」（上游 `resolve` 会回退到库里的第一个默认图案），
        // 这是合法用法；只有显式指定的图案找不到时才拒绝，不静默换成别的图案。
        if !requested.is_empty() && photocraft_engine::pattern_cmds::resolve(session, requested).is_none() {
            return Err(error(id, format!("图案 {requested} 不存在")));
        }
    }
    let _ = state;
    Ok(())
}

/// 历史画笔所选历史源的索引（`None` 表示上游默认的最旧状态）。
pub fn history_index(params: &Value) -> Option<usize> {
    params.get("state").and_then(Value::as_u64).map(|value| value as usize)
}

/// 冻结采样基线：本笔开始时的文档快照，避免采样正在写入的结果。
pub struct RetouchBaseline {
    pub document: Arc<Document>,
    layer: LayerId,
    id: String,
    points: Vec<Value>,
    /// 历史画笔的源文档快照（重放会话需要它才有可恢复的像素）。
    history_source: Option<Arc<Document>>,
    /// 本笔开始时的仿制源/图案等工具状态（重放会话据此得到同一取样来源与变换）。
    presets: photocraft_engine::presets::PresetState,
}

impl RetouchBaseline {
    /// 开始一笔：记录基线文档与首个采样点。
    pub fn begin(session: &Session, id: &str, params: &Value) -> Result<Self> {
        let params = normalize_stroke_params(id, params);
        let state = session.active().ok_or(EditorError::NoDocument)?;
        let layer = prepare_stroke_target(session, id, &params)?;
        validate_session_params(session, state, id, &params)?;
        let points = params
            .get("points")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| error(id, "缺少 points"))?;
        if points.is_empty() {
            return Err(error(id, "points 为空"));
        }
        let history_source = if id == "paint.historyBrush" {
            Some(resolve_history_source(state, &params, id)?)
        } else {
            None
        };
        let baseline = Self {
            document: state.doc.clone(),
            layer,
            id: id.to_string(),
            points,
            history_source,
            presets: session.presets.clone(),
        };
        if baseline.history_source.is_some() {
            // 历史源必须真的含有目标图层：最早的历史状态常常早于该图层创建（如 Open 快照），
            // 那时上游在落笔时才报错。这里在开始一笔时就用同一重放路径预演一次，给出可操作的
            // 中文原因，而不是让用户画到一半才失败。
            baseline.preview(&params).map_err(|failure| match failure {
                EditorError::CommandFailed { message, .. } if message.contains("did not exist") => error(
                    id,
                    "所选历史状态里没有这个图层（它在该状态之后才创建）；请改选包含该图层的状态",
                ),
                other => other,
            })?;
        }
        Ok(baseline)
    }

    /// 追加本帧采样点（预览用）。
    pub fn push(&mut self, points: &[Value]) -> Result<()> {
        for point in points {
            if !point.is_array() {
                return Err(error(&self.id, "采样点必须是数组"));
            }
        }
        self.points.extend_from_slice(points);
        Ok(())
    }

    /// 当前已累计的采样点数。
    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// 目标图层。
    pub fn layer(&self) -> LayerId {
        self.layer
    }

    /// 预览：在**基线副本**上重放整笔，返回候选文档。
    ///
    /// 与正式提交走同一个上游命令，因此预览与结果由同一实现保证一致；基线不变，所以采样
    /// 不会递归污染。
    pub fn preview(&self, params: &Value) -> Result<Arc<Document>> {
        let params = normalize_stroke_params(&self.id, params);
        let mut scratch = Session::new();
        scratch.add_document((*self.document).clone(), None);
        // 仿制源槽位（U39）是会话工具状态：重放会话必须带上同一份，否则带槽位来源的笔迹
        // 在预览里会报「缺 source」，与提交结果不一致。
        scratch.presets = self.presets.clone();
        if let Some(source) = &self.history_source {
            // 重放会话里植入所选历史源，`state: 0` 才会取到它而不是空历史。
            let state = scratch.active_mut().ok_or(EditorError::NoDocument)?;
            state.history.record("Replay source", source.clone(), Default::default());
        }
        let mut command = params;
        command["points"] = Value::Array(self.points.clone());
        command["layer"] = json!(self.layer.0);
        if self.history_source.is_some() {
            command["state"] = json!(0);
        }
        scratch.execute(&self.id, command).map_err(|failure| error(&self.id, failure))?;
        Ok(scratch.active().unwrap().doc.clone())
    }

    /// 提交：正式会话执行同一命令，一步历史。
    pub fn commit(self, session: &mut Session, params: &Value) -> Result<Value> {
        let params = normalize_stroke_params(&self.id, params);
        let mut command = params;
        command["points"] = Value::Array(self.points);
        command["layer"] = json!(self.layer.0);
        session.execute(&self.id, command).map_err(|failure| error(&self.id, failure))
    }
}

/// 取历史画笔的源文档：显式 `state`（0 = 最旧）或 `past_len`（当前文档）。
fn resolve_history_source(
    state: &photocraft_engine::DocState,
    params: &Value,
    id: &str,
) -> Result<Arc<Document>> {
    let past = state.history.past_len();
    match history_index(params) {
        None => Ok(state.history.state(0).unwrap_or_else(|| state.doc.clone())),
        Some(index) if index == past => Ok(state.doc.clone()),
        Some(index) => state.history.state(index).ok_or_else(|| {
            error(id, format!("历史源 {index} 不可用（0..={past}）；请选择仍保留的历史状态"))
        }),
    }
}

/// 当前可作历史画笔源的历史状态。
///
/// 每个状态都带上「是否包含目标图层」：历史画笔只能从含有该图层的状态取样（上游在落笔时
/// 用“did not exist”拒绝），UI 据此禁用不可用的源，而不是让用户先画一笔才失败。
pub fn history_sources(state: &photocraft_engine::DocState) -> Value {
    let labels = state.history.entries();
    let past = state.history.past_len();
    let layer = state.active_layer;
    let available = |index: usize| -> bool {
        let Some(layer) = layer else { return false };
        let Some(document) = (if index == past { Some(state.doc.clone()) } else { state.history.state(index) }) else {
            return false;
        };
        document.layer(layer).is_some()
    };
    json!({
        "states": labels
            .iter()
            .enumerate()
            .map(|(index, label)| json!({
                "index": index,
                "label": label,
                "current": index == past,
                "available": available(index),
            }))
            .collect::<Vec<_>>(),
        "layer": layer.map(|id| id.0),
    })
}

/// 区域修饰草稿（修补／内容识别移动／红眼）：候选在隔离会话算出，确认才提交。
pub struct RetouchOpDraft {
    command: String,
    params: Value,
    /// 候选文档（预览）。
    pub document: Arc<Document>,
    /// 候选结果的命令回执（确认时重新执行，不直接复用这次的回执）。
    result: Value,
    /// 起始修订与文档 id，晚到确认按它们丢弃。
    pub base_revision: u64,
    pub document_id: u64,
    /// 候选是否真的改变了像素（无变化不新增历史）。
    pub changed: bool,
}

impl RetouchOpDraft {
    /// 校验并在隔离会话算出候选结果。
    ///
    /// 目标图层在这里就固定进 `params`：不带 `layer` 时用**当前活动层**（与内核
    /// `target_layer` 一致），既让可写性校验提前到开始前，也让确认时提交的候选与预览指向
    /// 同一层，不会因为中途改选图层而落到别处（改选本身也会推进修订并让候选过期）。
    pub fn begin(session: &Session, id: &str, params: &Value) -> Result<Self> {
        if !REGION_RETOUCH.contains(&id) {
            return Err(static_error("paint.retouch", format!("{id} 不是已开放的区域修饰命令")));
        }
        let state = session.active().ok_or(EditorError::NoDocument)?;
        let mut params = params.clone();
        if let Some(map) = params.as_object_mut()
            && map.get("layer").and_then(Value::as_u64).is_none()
        {
            match state.active_layer {
                Some(layer) => map.insert("layer".into(), json!(layer.0)),
                None => return Err(error(id, "没有活动图层；请先在图层面板选择一个像素层")),
            };
        }
        validate_region_params(&state.doc, id, &params)?;
        let mut scratch = Session::new();
        scratch.add_document((*state.doc).clone(), None);
        scratch.active_mut().map(|active| active.active_layer = state.active_layer);
        let result = scratch.execute(id, params.clone()).map_err(|failure| error(id, failure))?;
        let document = scratch.active().ok_or(EditorError::NoDocument)?.doc.clone();
        let changed = result.get("changed").and_then(Value::as_bool) != Some(false)
            && !Arc::ptr_eq(&document, &state.doc);
        Ok(Self {
            command: id.to_string(),
            params,
            document,
            result,
            base_revision: state.revision,
            document_id: state.doc.id.0,
            changed,
        })
    }

    /// 候选结果的摘要（UI 用来显示范围/像素数）。
    pub fn result(&self) -> Value {
        self.result.clone()
    }

    /// 命令 id。
    pub fn command(&self) -> &str {
        &self.command
    }

    /// 候选用的参数（已补上目标 `layer`）；确认时按同一份提交，避免预览与提交落在不同图层。
    pub fn params(&self) -> &Value {
        &self.params
    }

    /// 从持久化的候选信封恢复（确认时执行同一命令一次）。
    ///
    /// 候选文档本身不再携带（确认只重新执行命令），因此 `document` 是当前正式文档的占位副本，
    /// 只用于满足结构；真正被提交的是 `session.execute` 的结果。
    pub fn restore(
        session: &Session,
        command: &str,
        params: Value,
        base_revision: u64,
        document_id: u64,
        result: Value,
    ) -> Result<Self> {
        if !REGION_RETOUCH.contains(&command) {
            return Err(static_error("paint.retouch", format!("{command} 不是已开放的区域修饰命令")));
        }
        let state = session.active().ok_or(EditorError::NoDocument)?;
        Ok(Self {
            command: command.to_string(),
            params,
            document: state.doc.clone(),
            result,
            base_revision,
            document_id,
            changed: true,
        })
    }

    /// 确认：在正式会话执行同一命令一次，返回命令回执。
    ///
    /// 起始修订/文档已变时不提交（晚到候选不得写入别的文档或更新的修订）。
    pub fn commit(self, session: &mut Session) -> Result<Value> {
        let state = session.active().ok_or(EditorError::NoDocument)?;
        if state.doc.id.0 != self.document_id {
            return Err(error(&self.command, "文档已切换，丢弃过期候选"));
        }
        if state.revision != self.base_revision {
            return Err(error(&self.command, "文档已修改，丢弃过期候选"));
        }
        session.execute(&self.command, self.params).map_err(|failure| error(&self.command, failure))
    }
}

/// 区域命令的参数与目标校验。
fn validate_region_params(document: &Document, id: &str, params: &Value) -> Result<()> {
    if let Some(layer) = params.get("layer").and_then(Value::as_u64) {
        crate::adjustment_ext::writable_pixel_layer(document, LayerId(layer))?;
    }
    let offset = || -> Result<()> {
        let pair = params
            .get("offset")
            .and_then(Value::as_array)
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| error(id, "需要拖动偏移 offset（[dx, dy]）"))?;
        if !pair.iter().all(|value| value.as_f64().is_some_and(f64::is_finite)) {
            return Err(error(id, "偏移必须是两个有限数值"));
        }
        Ok(())
    };
    match id {
        "paint.patch" | "paint.contentAwareMove" => {
            if document.selection.is_none() {
                return Err(error(id, "请先选择要修补或移动的区域"));
            }
            offset()?;
            if let Some(mode) = params.get("mode").and_then(Value::as_str) {
                let allowed: &[&str] = if id == "paint.patch" { &["source", "destination"] } else { &["move", "extend"] };
                if !allowed.contains(&mode) {
                    return Err(error(id, format!("模式 {mode} 不受支持（{}）", allowed.join("|"))));
                }
            }
            if let Some(structure) = params.get("structure").and_then(Value::as_f64)
                && !(1.0..=7.0).contains(&structure)
            {
                return Err(error(id, "结构必须在 1–7 之间"));
            }
            if let Some(color) = params.get("color").and_then(Value::as_f64)
                && !(0.0..=10.0).contains(&color)
            {
                return Err(error(id, "颜色适应必须在 0–10 之间"));
            }
        }
        "paint.redEye" => {
            let clicks = params.get("points").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            let single = params.get("x").and_then(Value::as_f64).is_some() && params.get("y").and_then(Value::as_f64).is_some();
            if clicks == 0 && !single {
                return Err(error(id, "请给出红眼位置（x/y 或 points）"));
            }
            if clicks > 64 {
                return Err(error(id, "一次最多修正 64 处红眼"));
            }
            if let Some(pupil) = params.get("pupilSize").and_then(Value::as_f64)
                && !(1.0..=100.0).contains(&pupil)
            {
                return Err(error(id, "瞳孔大小必须在 1–100 之间"));
            }
            if let Some(darken) = params.get("darken").and_then(Value::as_f64)
                && !(0.0..=100.0).contains(&darken)
            {
                return Err(error(id, "变暗量必须在 0–100 之间"));
            }
        }
        other => return Err(static_error("paint.retouch", format!("{other} 不是区域修饰命令"))),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Color, ColorMode, LayerContent, SampleType, Size};

    fn document() -> Document {
        let mut document = Document::with_background(
            "doc",
            Size::new(24, 20),
            ColorMode::Rgb,
            SampleType::U8,
            Color::rgb(0.3, 0.5, 0.7),
        );
        let mut layer = photocraft_doc::Layer::raster("上层", document.pixel_format());
        if let LayerContent::Raster(surface) = &mut layer.content {
            surface.fill_rect(photocraft_geom::Rect::new(2, 2, 12, 10), &[0.8, 0.2, 0.2, 1.0]);
        }
        document.layers.push(layer);
        document
    }

    fn session() -> (Session, LayerId) {
        let document = document();
        let layer = document.layers[1].id;
        let mut session = Session::new();
        session.add_document(document, None);
        session.active_mut().unwrap().active_layer = Some(layer);
        (session, layer)
    }

    #[test]
    fn retouch_requires_a_source_point_and_a_writable_target() {
        let (session, layer) = session();
        let state = session.active().unwrap();
        // `prepare_retouch` 只判定目标与工具参数；来源判定在落笔入口 `prepare_stroke_target`。
        assert!(prepare_stroke_target(&session, "paint.cloneStamp", &json!({"points":[[1,1]]})).is_err());
        assert!(
            prepare_stroke_target(
                &session,
                "paint.cloneStamp",
                &json!({"layer":layer.0,"points":[[1,1]],"source":[4,4]})
            )
            .is_ok()
        );
        prepare_retouch(
            &state.doc,
            "paint.cloneStamp",
            &json!({"layer":layer.0,"points":[[1,1]],"source":[4,4]}),
        )
        .unwrap();
        assert!(prepare_retouch(&state.doc, "select.all", &json!({})).is_err());
        // 没有显式 layer 时不允许猜目标：静默取「最上层」会写进用户没选中的图层。
        assert!(prepare_retouch(&state.doc, "paint.blur", &json!({"points":[[4,4]]})).is_err());
        assert!(prepare_retouch(
            &state.doc,
            "paint.blur",
            &json!({"layer":layer.0,"sampleLayer":"elsewhere"})
        )
        .is_err());
        // 文字层与锁定层被拒绝。
        let mut document = state.doc.clone();
        let text = photocraft_doc::Layer::new("文字", LayerContent::Text(Default::default()));
        let text_id = text.id;
        Arc::make_mut(&mut document).layers.push(text);
        assert!(prepare_retouch(&document, "paint.blur", &json!({"layer":text_id.0})).is_err());
        Arc::make_mut(&mut document).layers[1].locks.pixels = true;
        assert!(prepare_retouch(&document, "paint.blur", &json!({"layer":layer.0})).is_err());
    }

    #[test]
    fn missing_layer_defaults_to_the_active_layer_not_the_topmost_one() {
        // 文档自下而上是「背景 + 上层」，活动层是上层；再加一个更上方的锁定层，
        // 让「最上层」与「活动层」明确不同——旧实现会落到这个锁定层上。
        let (mut session, active) = session();
        let mut locked = photocraft_doc::Layer::raster("锁定层", session.active().unwrap().doc.pixel_format());
        locked.locks.pixels = true;
        let locked_id = locked.id;
        Arc::make_mut(&mut session.active_mut().unwrap().doc).layers.push(locked);
        // 活动层仍是上层（不是新加的锁定层）。
        assert_eq!(session.active().unwrap().active_layer, Some(active));
        // 不带 layer 的落笔使用活动层，因此不被锁定层拒绝。
        assert_eq!(
            prepare_stroke_target(&session, "paint.blur", &json!({"points":[[4,4]],"size":6})).unwrap(),
            active,
            "缺省目标必须是活动层"
        );
        // 显式指定锁定层仍然被拒绝（可写性校验没有被绕过）。
        assert!(prepare_stroke_target(&session, "paint.blur", &json!({"layer":locked_id.0,"points":[[4,4]],"size":6})).is_err());
        // 区域命令同样以活动层为目标并提前拒绝不可写目标。
        session.execute("select.rect", json!({"x":2,"y":2,"width":4,"height":4,"mode":"replace"})).unwrap();
        let draft = RetouchOpDraft::begin(&session, "paint.patch", &json!({"offset":[4,0]})).unwrap();
        assert_eq!(draft.params["layer"], json!(active.0), "区域候选也要固定活动层");
        assert!(RetouchOpDraft::begin(&session, "paint.patch", &json!({"layer":locked_id.0,"offset":[4,0]})).is_err());
    }

    #[test]
    fn replay_baseline_preview_matches_commit_and_does_not_recursively_sample() {
        let (mut session, layer) = session();
        let before = session.active().unwrap().doc.clone();
        let params = json!({"layer":layer.0,"points":[[6,6],[7,7],[8,8]],"size":8,"hardness":50,"opacity":100,"flow":100,"spacing":25,"strength":60});
        let mut baseline = RetouchBaseline::begin(&session, "paint.blur", &params).unwrap();
        assert_eq!(baseline.len(), 3);
        let preview = baseline.preview(&params).unwrap();
        // 预览不改变正式文档，且基线本身不变（采样不递归）。
        assert!(Arc::ptr_eq(&session.active().unwrap().doc, &before));
        assert!(Arc::ptr_eq(&baseline.document, &before));
        baseline.push(&[json!([9, 9])]).unwrap();
        let preview2 = baseline.preview(&params).unwrap();
        assert_ne!(preview, preview2);
        let value = baseline.commit(&mut session, &params).unwrap();
        assert!(value["damage"].is_array());
        // 提交后文档变化，并且只增加一步历史。
        assert!(!Arc::ptr_eq(&session.active().unwrap().doc, &before));
        assert_eq!(session.active().unwrap().history.past_len(), 1);
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().doc, before);
    }

    #[test]
    fn sponge_sends_saturate_or_desaturate_instead_of_a_blend_mode() {
        // 上轮实测：通用画笔补丁写入 mode=normal，海绵报 unknown mode 并让编辑器落进错误边界。
        let (mut session, layer) = session();
        let params = json!({"layer":layer.0,"points":[[6,6],[7,7]],"size":8,"hardness":50,"opacity":100,"flow":100,"spacing":25,"mode":"normal"});
        let normalized = normalize_stroke_params("paint.sponge", &params);
        assert_eq!(normalized["mode"], json!("desaturate"));
        normalize_stroke_params("paint.sponge", &json!({"mode":"normal","spongeMode":"saturate"}))
            .get("mode")
            .map(|mode| assert_eq!(mode, &json!("saturate")));
        let mut baseline = RetouchBaseline::begin(&session, "paint.sponge", &params).unwrap();
        baseline.push(&[json!([9, 9])]).unwrap();
        baseline.preview(&params).expect("预览必须走 saturate/desaturate");
        baseline.commit(&mut session, &params).expect("提交必须走 saturate/desaturate");
        assert_eq!(session.active().unwrap().history.past_len(), 1);
        // 少/多饱和各是一条有效命令，非法 mode 仍被拒绝。
        for mode in ["desaturate", "saturate"] {
            let p = json!({"layer":layer.0,"points":[[5,5]],"size":6,"hardness":50,"opacity":100,"flow":100,"spacing":25,"mode":mode});
            prepare_retouch(&session.active().unwrap().doc, "paint.sponge", &p).unwrap();
        }
        assert!(prepare_retouch(
            &session.active().unwrap().doc,
            "paint.sponge",
            &json!({"points":[[5,5]],"mode":"normal"})
        )
        .is_err());
        // 混合模式仍然是图章的语义，不被改成海绵模式。
        assert_eq!(normalize_stroke_params("paint.cloneStamp", &json!({"mode":"multiply"}))["mode"], json!("multiply"));
        assert!(mode_is_blend("paint.cloneStamp"));
        assert!(!mode_is_blend("paint.sponge"));
    }

    #[test]
    fn dodge_burn_and_smudge_reject_parameters_outside_the_kernel_range() {
        let (session, layer) = session();
        let state = session.active().unwrap();
        for (id, bad, good) in [
            ("paint.dodge", json!({"range":"elsewhere"}), json!({"range":"highlights","exposure":40})),
            ("paint.burn", json!({"exposure":0}), json!({"range":"shadows","exposure":100})),
            ("paint.smudge", json!({"strength":0}), json!({"strength":75,"fingerPainting":true})),
            ("paint.sharpen", json!({"strength":101}), json!({"strength":20,"protectDetail":false})),
            ("paint.patternStamp", json!({"scale":0}), json!({"scale":200,"angle":30,"aligned":false})),
        ] {
            let mut base = json!({"layer":layer.0,"points":[[4,4]],"size":6});
            for (key, value) in bad.as_object().unwrap() {
                base[key] = value.clone();
            }
            assert!(prepare_retouch(&state.doc, id, &base).is_err(), "{id} 应拒绝 {bad}");
            let mut base = json!({"layer":layer.0,"points":[[4,4]],"size":6});
            for (key, value) in good.as_object().unwrap() {
                base[key] = value.clone();
            }
            prepare_retouch(&state.doc, id, &base).unwrap_or_else(|error| panic!("{id} 应接受 {good}: {error}"));
        }
    }

    #[test]
    fn history_brush_restores_the_chosen_state_and_refuses_a_cleared_source() {
        let (mut session, layer) = session();
        let opened = session.active().unwrap().doc.clone();
        session
            .execute(
                "paint.dodge",
                json!({"layer":layer.0,"points":[[3,3],[4,4]],"size":6,"hardness":100,"opacity":100,"flow":100,"spacing":25,"range":"midtones","exposure":100}),
            )
            .unwrap();
        let painted = session.active().unwrap().doc.clone();
        assert_ne!(painted, opened);
        // 取最旧状态（Open）作为源。
        let params = json!({"layer":layer.0,"points":[[3,3]],"size":6,"hardness":100,"opacity":100,"flow":100,"spacing":25,"historyState":0});
        let baseline = RetouchBaseline::begin(&session, "paint.historyBrush", &params).unwrap();
        let preview = baseline.preview(&params).unwrap();
        assert_ne!(preview, painted, "预览必须已经恢复历史源内容");
        let mut commit_params = params.clone();
        commit_params["state"] = json!(0);
        baseline.commit(&mut session, &commit_params).unwrap();
        // 确认不改动当前历史游标之外的既有记录，只多一步。
        assert_eq!(session.active().unwrap().history.past_len(), 2);
        // 不可用的历史源被拒绝，不静默退化为普通画笔。
        let missing = json!({"layer":layer.0,"points":[[3,3]],"size":6,"historyState":99});
        let error = RetouchBaseline::begin(&session, "paint.historyBrush", &missing)
            .err()
            .expect("不可用的历史源必须被拒绝");
        assert!(format!("{error}").contains("99"));
    }

    #[test]
    fn region_commands_preview_without_touching_the_document_and_commit_once() {
        let (mut session, layer) = session();
        session.execute("select.rect", json!({"x":2,"y":2,"width":5,"height":5,"mode":"replace"})).unwrap();
        let before = session.active().unwrap().clone();
        let params = json!({"layer":layer.0,"offset":[6,0],"mode":"source"});
        let draft = RetouchOpDraft::begin(&session, "paint.patch", &params).unwrap();
        assert_eq!(session.active().unwrap().revision, before.revision, "预览不改正式修订");
        assert!(!Arc::ptr_eq(&draft.document, &before.doc));
        assert_ne!(draft.result(), Value::Null);
        draft.commit(&mut session).unwrap();
        // 只增加修补这一步（选区那一步先于基线）。
        assert_eq!(session.active().unwrap().history.past_len(), before.history.past_len() + 1);
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().doc, before.doc);
    }

    #[test]
    fn region_commands_reject_missing_selection_offsets_and_bad_red_eye_parameters() {
        let (mut session, layer) = session();
        // 没有选区：修补/内容识别移动先被拒绝（与上游 `patch::enabled` 同义）。
        assert!(RetouchOpDraft::begin(&session, "paint.patch", &json!({"layer":layer.0,"offset":[2,0]})).is_err());
        assert!(
            RetouchOpDraft::begin(&session, "paint.contentAwareMove", &json!({"layer":layer.0,"offset":[2,0]})).is_err()
        );
        session.execute("select.rect", json!({"x":2,"y":2,"width":5,"height":5,"mode":"replace"})).unwrap();
        assert!(RetouchOpDraft::begin(&session, "paint.patch", &json!({"layer":layer.0})).is_err());
        assert!(RetouchOpDraft::begin(&session, "paint.patch", &json!({"layer":layer.0,"offset":[2]})).is_err());
        assert!(RetouchOpDraft::begin(&session, "paint.patch", &json!({"layer":layer.0,"offset":[2,0],"mode":"elsewhere"}))
            .is_err());
        assert!(RetouchOpDraft::begin(&session, "paint.patch", &json!({"layer":layer.0,"offset":[2,0],"structure":9}))
            .is_err());
        assert!(RetouchOpDraft::begin(&session, "paint.contentAwareMove", &json!({"layer":layer.0,"offset":[2,0]}))
            .is_ok());
        assert!(RetouchOpDraft::begin(&session, "paint.redEye", &json!({"layer":layer.0})).is_err());
        assert!(RetouchOpDraft::begin(&session, "paint.redEye", &json!({"layer":layer.0,"x":4,"y":4,"pupilSize":0}))
            .is_err());
        assert!(RetouchOpDraft::begin(&session, "paint.redEye", &json!({"layer":layer.0,"x":4,"y":4,"darken":101}))
            .is_err());
        // 非区域命令不能进区域草稿。
        assert!(RetouchOpDraft::begin(&session, "paint.blur", &json!({"points":[[1,1]]})).is_err());
    }

    #[test]
    fn op_draft_refuses_a_stale_revision_instead_of_writing_it() {
        let (mut session, layer) = session();
        session.execute("select.rect", json!({"x":1,"y":1,"width":6,"height":6,"mode":"replace"})).unwrap();
        let draft = RetouchOpDraft::begin(&session, "paint.patch", &json!({"layer":layer.0,"offset":[5,0]})).unwrap();
        session
            .execute("select.rect", json!({"x":0,"y":0,"width":2,"height":2,"mode":"replace"}))
            .unwrap();
        let error = draft.commit(&mut session).unwrap_err();
        assert!(format!("{error}").contains("过期候选"));
    }

    #[test]
    fn history_sources_lists_every_retained_state() {
        let (mut session, layer) = session();
        session
            .execute(
                "paint.dodge",
                json!({"layer":layer.0,"points":[[3,3]],"size":6,"hardness":100,"opacity":100,"flow":100,"spacing":25}),
            )
            .unwrap();
        let state = session.active().unwrap();
        let sources = history_sources(state);
        let list = sources["states"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["index"], json!(0));
        assert_eq!(list[1]["current"], json!(true));
    }

    #[test]
    fn filter_draft_previews_commits_one_step_and_rejects_bad_params() {
        let (mut session, layer) = session();
        let before = session.active().unwrap().clone();
        let mut draft = FilterDraft::begin(&session, "filter.blur.gaussianBlur", Some(layer), json!({"radius":2})).unwrap();
        let first = draft.document.clone();
        assert_eq!(session.active().unwrap().revision, before.revision, "预览不改正式修订");
        draft.update(json!({"radius":4})).unwrap();
        assert_ne!(&first, &draft.document);
        // 非法参数：草稿报错，但保留上一次有效预览（不能静默确认）。
        assert!(draft.update(json!({"radius":0})).is_err());
        assert!(draft.update(json!({"radius":1e9})).is_err());
        assert_ne!(&first, &draft.document);
        draft.commit(&mut session).unwrap();
        assert_eq!(session.active().unwrap().history.past_len(), before.history.past_len() + 1);
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().doc, before.doc);
    }

    #[test]
    fn filters_reject_non_rgb_targets_and_unknown_ids() {
        let (session, layer) = session();
        assert!(FilterDraft::begin(&session, "filter.liquify", Some(layer), json!({})).is_err());
        assert!(FilterDraft::begin(&session, "filter.blur.gaussianBlur", Some(LayerId(u64::MAX)), json!({})).is_err());
        assert!(validate_filter("filter.blur.gaussianBlur", &json!({"radius":0.05})).is_err());
        assert!(validate_filter("filter.sharpen.unsharpMask", &json!({"amount":0})).is_err());
        assert!(validate_filter("filter.sharpen.unsharpMask", &json!({"threshold":300})).is_err());
        validate_filter("filter.sharpen.unsharpMask", &json!({"amount":120,"radius":1.5,"threshold":3}))
            .unwrap();
    }
}

#[path = "../filters/filter_draft.rs"]
mod filters_implementation;
pub use filters_implementation::*;
