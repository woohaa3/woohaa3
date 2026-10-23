//! 视图导航、参考线与分析辅助的内核入口（U70–U73）。
//!
//! change: `2026-10-22-add-photocraft-view-workspace-workflows`。
//!
//! ## 归属
//!
//! - **会话/偏好**：标尺、网格、吸附目标、单位、旋转角、Navigator 与多视图都在
//!   [`ViewAids`]（`self.view_aids`）里，不进文档内容、不进内容 hash、不进历史；
//! - **文档**：参考线位置、标尺原点、计数分组、测量比例/标尺、注释都是上游文档字段，
//!   走上游命令与历史，参与身份与核验；
//! - **会话**：颜色取样点在 `DocState::color_samplers`（上游语义），每文档独立、不保存。
//!
//! 所有写入口都先过统一的草稿门禁（`require_no_stroke` / `require_no_tool_draft`），
//! 再走唯一命令白名单 [`VIEW_COMMANDS`]；未声明的命令一律按能力关闭拒绝，不开放前缀。
use serde_json::{Value, json};

use crate::editor::*;
use crate::composition::{
    GUIDE_COMMANDS, GUIDE_LAYOUT_COMMANDS, MAX_VIEWS, SAMPLER_COMMANDS, SNAP_TARGETS, VIEW_COMMANDS,
    VIEW_POINTER_ACTIONS, VIEW_READ_COMMANDS, VIEW_UNITS, ViewModel, canonical_unit, snap_point,
};
use crate::features::views::view_geometry;

/// 一次视图操作的结果类型：会话数据或文档数据。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewScope {
    /// 视图/会话状态：不改文档、不造 dirty。
    Session,
    /// 文档数据：走历史与身份。
    Document,
}

impl ViewScope {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            ViewScope::Session => "session",
            ViewScope::Document => "document",
        }
    }
}

/// 命令的归属：决定 UI 是否因 dirty/历史刷新。
///
/// 颜色取样点、标尺/网格/吸附/单位/旋转与多视图都是会话或文档**视图字段**，它们不改像素，
/// 也不进入内容 hash；参考线、原点、计数、测量与注释属于文档数据。
pub fn view_scope(id: &str) -> Option<ViewScope> {
    if SAMPLER_COMMANDS.contains(&id) {
        Some(ViewScope::Session)
    } else if VIEW_COMMANDS.contains(&id) {
        Some(ViewScope::Document)
    } else {
        None
    }
}

fn bad(id: &str, message: impl std::fmt::Display) -> crate::error::EditorError {
    crate::error::EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

/// 命令是否真的可用：既在白名单里，所属能力也已开放（判定见
/// [`super::required_capability`]，与发布清单同一份数据）。
fn capability_open(id: &str) -> bool {
    crate::features::views::required_capability(id).is_some_and(crate::capability::is_enabled)
}

/// 参考线锁定是否拦下这条命令。
///
/// 锁定的是**参考线本身**：加/移/改/删和布局生成都拒绝；标尺原点不属于参考线，`clearGuides`
/// 是用户明确要移除全部参考线，二者都不受锁定影响。两个写入口共用这一判定，避免「面板能改、
/// 统一入口不能改」的分叉。
fn guide_lock_blocks(id: &str, locked: bool) -> bool {
    if !locked {
        return false;
    }
    let touches_guides = GUIDE_COMMANDS.contains(&id) || GUIDE_LAYOUT_COMMANDS.contains(&id);
    let is_origin = matches!(id, "view.setRulerOrigin" | "view.resetRulerOrigin");
    let is_clear = matches!(id, "view.clearGuides" | "view.clearCanvasGuides");
    touches_guides && !is_origin && !is_clear
}

/// 写入目标文档守卫（U72/U73「来源失效不误写目标」）。
///
/// 面板可能持有上一份文档的快照：切标签/换工程后，它的失焦提交仍带着**旧文档的索引**。
/// 调用方从 `viewSnapshot.document.id` 取到当前目标，写入时原样回传 `targetDocument`；
/// 与活动文档不一致就拒绝，而不是把 A 文档的第 0 条参考线/注释/标记写到 B 文档上。
///
/// 参数缺省表示调用方不参与守卫（旧宿主/精简替身），行为与之前一致；参与时该字段不会
/// 透传给上游命令，避免上游把它当成无关参数静默忽略。
fn guard_target_document(params: &mut Value, active: u64) -> Result<()> {
    let Some(target) = params.get("targetDocument") else {
        return Ok(());
    };
    let target = target
        .as_u64()
        .ok_or_else(|| bad("view.stale", "targetDocument 必须是文档 id"))?;
    if target != active {
        return Err(bad("view.stale", "目标文档已切换：请刷新视图后再重试，避免写到别的文档"));
    }
    if let Value::Object(map) = params {
        map.remove("targetDocument");
    }
    Ok(())
}

impl Editor {
    /// 视图辅助状态：工作区持有，不进文档内容或历史。
    ///
    /// 同时带上活动文档的标尺零点：叠加层与标尺刻度要同时拿到轮换角和零点才能画对，
    /// 而它们每帧都要重画，不该为此多打一次内核调用。
    pub fn view_aids(&self) -> Value {
        let origin = self
            .session
            .active()
            .map(|state| state.doc.ruler_origin)
            .unwrap_or([0.0, 0.0]);
        self.view_aids.to_json_with_origin(origin)
    }

    /// 更新视图辅助（网格、吸附、单位、旋转与多视图）。
    ///
    /// 每次修改都整体校验；非法值不落地，已接受的值保持。
    pub fn set_view_aids(&mut self, params: Value) -> Result<Value> {
        if let Some(value) = params.get("rulers").and_then(Value::as_bool) {
            self.view_aids.rulers = value;
        }
        if let Some(value) = params.get("grid").and_then(Value::as_bool) {
            self.view_aids.grid = value;
        }
        if let Some(value) = params.get("guides").and_then(Value::as_bool) {
            self.view_aids.guides = value;
        }
        if let Some(value) = params.get("lockGuides").and_then(Value::as_bool) {
            self.view_aids.lock_guides = value;
        }
        if let Some(value) = params.get("smartGuides").and_then(Value::as_bool) {
            self.view_aids.smart_guides = value;
        }
        if let Some(value) = params.get("navigator").and_then(Value::as_bool) {
            self.view_aids.navigator = value;
        }
        if let Some(value) = params.get("sideBySide").and_then(Value::as_bool) {
            // 并排至少需要两个视图：只有一个视图时打开它等于「什么都不会变」，直接拒绝而不是
            // 留一个看起来生效、实际单画布的开关。
            if value && self.view_aids.views.len() < 2 {
                return Err(bad("view.rotate", "并排显示需要至少两个视图，请先新建视图"));
            }
            self.view_aids.side_by_side = value;
        }
        if let Some(value) = params.get("suspend").and_then(Value::as_bool) {
            self.view_aids.snap_suspended = value;
        }
        if let Some(unit) = params.get("units").and_then(Value::as_str) {
            let unit = canonical_unit(unit)
                .ok_or_else(|| bad("view.snap", format!("units 必须是 {}", VIEW_UNITS.join(" / "))))?;
            self.view_aids.units = unit.to_string();
        }
        if let Some(subdivisions) = params.get("gridSubdivisions") {
            let number = subdivisions
                .as_u64()
                .filter(|value| (1..=32).contains(value))
                .ok_or_else(|| bad("view.snap", "gridSubdivisions 必须是 1–32 的整数"))?;
            self.view_aids.grid_subdivisions = number as u32;
        }
        if let Some(step) = params.get("gridStep").and_then(Value::as_array) {
            let values = step
                .iter()
                .filter_map(Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0 && *value <= 4096.0)
                .collect::<Vec<_>>();
            if values.len() != 2 {
                return Err(bad("view.snap", "gridStep 需要两个正的有限数值"));
            }
            self.view_aids.grid_step = [values[0], values[1]];
        }
        if let Some(snap) = params.get("snap").and_then(Value::as_object) {
            for (key, target) in [
                ("document", &mut self.view_aids.snap.document),
                ("guides", &mut self.view_aids.snap.guides),
                ("grid", &mut self.view_aids.snap.grid),
                ("layers", &mut self.view_aids.snap.layers),
                ("selection", &mut self.view_aids.snap.selection),
            ] {
                if let Some(value) = snap.get(key).and_then(Value::as_bool) {
                    *target = value;
                }
            }
        }
        // 旋转与取景：只改活动视图；越界值整体拒绝，保持原值。
        if let Some(rotation) = params.get("rotation") {
            self.set_rotation(rotation)?;
        }
        // 取景写入目标：默认活动视图；带 `viewId` 时写那个视图（并排的另一半画布要能改自己的
        // 取景，而不必先抢走活动视图——「输入归属」只约束像素/指针输入，不约束取景记录）。
        let framing_index = match params.get("viewId").and_then(Value::as_str) {
            Some(id) => Some(
                self.view_aids
                    .view_index(id)
                    .ok_or_else(|| bad("view.rotate", format!("没有视图 {id}")))?,
            ),
            None => None,
        };
        if let Some(zoom) = params.get("zoom") {
            let zoom = zoom
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0 && *value <= 32.0)
                .ok_or_else(|| bad("view.rotate", "zoom 必须是 0–32 的有限正数"))?;
            let index = framing_index.unwrap_or_else(|| self.view_aids.active_view_index());
            self.view_aids.views[index].zoom = zoom;
        }
        if let Some(offset) = params.get("offset").and_then(Value::as_array) {
            let values: Vec<f64> = offset.iter().filter_map(Value::as_f64).collect();
            if values.len() != 2 || values.iter().any(|value| !value.is_finite()) {
                return Err(bad("view.rotate", "offset 需要两个有限数值"));
            }
            let index = framing_index.unwrap_or_else(|| self.view_aids.active_view_index());
            self.view_aids.views[index].offset = [values[0], values[1]];
        }
        if let Some(action) = params.get("viewAction").and_then(Value::as_str) {
            self.view_action(action, params.get("viewId").and_then(Value::as_str))?;
        }
        Ok(self.view_aids.to_json())
    }

    /// 设置活动视图的旋转角（度，顺时针为正；`reset` 归零）。
    fn set_rotation(&mut self, value: &Value) -> Result<()> {
        let degrees = match value {
            Value::String(action) if action == "reset" => 0.0,
            other => other
                .as_f64()
                .filter(|degrees| degrees.is_finite() && degrees.abs() <= view_geometry::MAX_ROTATION_DEGREES)
                .ok_or_else(|| bad("view.rotate", format!("旋转角度必须在 ±{} 度以内", view_geometry::MAX_ROTATION_DEGREES)))?,
        };
        let index = self.view_aids.active_view_index();
        self.view_aids.views[index].rotation_degrees = degrees;
        self.view_aids.rotation_degrees = degrees;
        Ok(())
    }

    /// 多视图动作：新建、关闭、并排、激活。
    fn view_action(&mut self, action: &str, view_id: Option<&str>) -> Result<()> {
        match action {
            "new" => {
                if self.view_aids.views.len() >= MAX_VIEWS {
                    return Err(bad("view.rotate", format!("同一文档最多 {MAX_VIEWS} 个视图")));
                }
                let index = self.view_aids.views.len() + 1;
                let current = self.view_aids.active_view().clone();
                for view in &mut self.view_aids.views {
                    view.active = false;
                }
                self.view_aids.views.push(ViewModel {
                    id: format!("view-{index}"),
                    label: format!("视图 {index}"),
                    // 新视图从当前取景开始，之后各自独立。
                    zoom: current.zoom,
                    offset: current.offset,
                    rotation_degrees: current.rotation_degrees,
                    active: true,
                });
            }
            "close" => {
                if self.view_aids.views.len() <= 1 {
                    return Err(bad("view.rotate", "至少保留一个视图"));
                }
                let index = match view_id {
                    Some(id) => self
                        .view_aids
                        .views
                        .iter()
                        .position(|view| view.id == id)
                        .ok_or_else(|| bad("view.rotate", format!("没有视图 {id}")))?,
                    None => self.view_aids.active_view_index(),
                };
                let removed = self.view_aids.views.remove(index);
                if removed.active {
                    let last = self.view_aids.views.len().saturating_sub(1);
                    self.view_aids.views[last].active = true;
                    self.view_aids.rotation_degrees = self.view_aids.views[last].rotation_degrees;
                }
                // 只剩一个视图时并排没有意义：顺手关掉，避免界面拿着一个做不到的开关。
                if self.view_aids.views.len() < 2 {
                    self.view_aids.side_by_side = false;
                }
            }
            "activate" => {
                let id = view_id.ok_or_else(|| bad("view.rotate", "activate 需要 viewId"))?;
                let index = self
                    .view_aids
                    .views
                    .iter()
                    .position(|view| view.id == id)
                    .ok_or_else(|| bad("view.rotate", format!("没有视图 {id}")))?;
                for (position, view) in self.view_aids.views.iter_mut().enumerate() {
                    view.active = position == index;
                }
                self.view_aids.rotation_degrees = self.view_aids.views[index].rotation_degrees;
            }
            other => return Err(bad("view.rotate", format!("未知视图动作 {other}"))),
        }
        Ok(())
    }

    /// 源坐标吸附（屏幕阈值换算成源像素）。
    pub fn snap_point(&self, params: Value) -> Result<Value> {
        let point = params
            .get("point")
            .and_then(Value::as_array)
            .filter(|point| point.len() == 2)
            .ok_or_else(|| bad("view.snap", "point 需要 [x, y]"))?;
        let x = point[0].as_f64();
        let y = point[1].as_f64();
        let (Some(x), Some(y)) = (x, y) else {
            return Err(bad("view.snap", "point 必须是有限数值"));
        };
        let zoom = params
            .get("zoom")
            .and_then(Value::as_f64)
            .filter(|zoom| zoom.is_finite() && *zoom > 0.0)
            .unwrap_or(1.0);
        let screen = params
            .get("tolerance")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 64.0)
            .unwrap_or(6.0);
        let result = snap_point(
            &self.active_doc()?.doc,
            &self.view_aids,
            [x, y],
            screen / zoom,
        );
        Ok(json!({
            "point": result.point,
            "lines": result.lines.iter().map(|line| json!({
                "vertical": line.vertical, "position": line.position, "from": line.from, "to": line.to,
                "kind": line.kind, "smart": line.smart
            })).collect::<Vec<_>>(),
        }))
    }

    /// 参考线／标尺命令（U70）。
    ///
    /// 与 [`Self::view_command`] 同一套拒绝条件：未声明的 id 按能力关闭拒绝；参考线锁定时除「清除」
    /// 之外一律拒绝——面板的逐条编辑入口就走这里，不能让锁定只对另一个入口生效。
    pub fn guide_command(&mut self, id: &str, params: Value) -> Result<Value> {
        let active = self.active_doc()?;
        let active_id = active.doc.id.0;
        if !capability_open(id) {
            return Err(crate::error::EditorError::CapabilityDisabled(id.into()));
        }
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if guide_lock_blocks(id, self.view_aids.lock_guides) {
            return Err(bad("view.guides", "参考线已锁定，请先在视图辅助里解锁"));
        }
        let mut params = params;
        guard_target_document(&mut params, active_id)?;
        crate::composition::guide(&mut self.session, id, params)
    }

    /// 参考线布局与画布参考线（U71）。
    ///
    /// 这三条命令会改文档的 `guides`（视图字段，不进内容 hash），但仍走历史，
    /// 因此和普通文档命令一样受草稿门禁。
    pub fn guide_layout_command(&mut self, id: &str, params: Value) -> Result<Value> {
        let active_id = self.active_doc()?.doc.id.0;
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if !capability_open(id) {
            return Err(crate::error::EditorError::CapabilityDisabled(id.into()));
        }
        // 布局生成也是在改参考线，锁定时同样拒绝；「清除画布参考线」例外。
        if guide_lock_blocks(id, self.view_aids.lock_guides) {
            return Err(bad("view.guides", "参考线已锁定，请先在视图辅助里解锁"));
        }
        // `view.newGuidesFromShape` 需要形状图层；层参数缺省时用活动层。
        let mut params = params;
        guard_target_document(&mut params, active_id)?;
        if id == "view.newGuidesFromShape" && params.get("layer").is_none() {
            if let Some(layer) = self.active_doc()?.active_layer {
                params["layer"] = json!(layer.0);
            }
        }
        self.session
            .execute(id, params)
            .map_err(|failure| bad("view.guides", failure))
    }

    /// 本域统一写入口（参考线、原点、取样点、测量、计数、注释）。
    ///
    /// 只接受 [`VIEW_COMMANDS`] 里逐项声明过的 id；未声明的 id 与未知 id 一样拒绝，
    /// 不按前缀放开。只读命令（`list`/`info`/`export`）走这里也不产生历史，且**不过草稿门禁**：
    /// 正在落笔时也需要能读取样读数、测量日志和注释列表，否则 Info 会随手指抬起才刷新。
    pub fn view_command(&mut self, id: &str, params: Value) -> Result<Value> {
        let active_id = self.active_doc()?.doc.id.0;
        let read_only = VIEW_READ_COMMANDS.contains(&id);
        if !capability_open(id) {
            return Err(crate::error::EditorError::CapabilityDisabled(id.into()));
        }
        let mut params = params;
        guard_target_document(&mut params, active_id)?;
        if read_only {
            return self
                .session
                .execute(id, params)
                .map_err(|failure| bad("view.analysis", failure));
        }
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        // 参考线锁定：显式拒绝而不是静默不生效。
        if guide_lock_blocks(id, self.view_aids.lock_guides) {
            return Err(bad("view.guides", "参考线已锁定，请先在视图辅助里解锁"));
        }
        let scope = view_scope(id).unwrap_or(ViewScope::Document);
        let result = self
            .session
            .execute(id, params)
            .map_err(|failure| match scope {
                ViewScope::Session => bad("view.samplers", failure),
                ViewScope::Document => bad("view.analysis", failure),
            })?;
        // 取样点只写会话视图状态；其余写文档，清掉选区缓存等派生数据由上游处理。
        Ok(result)
    }

    /// 视图与分析快照：参考线、原点、活动视图几何、取样点、测量与计数。
    ///
    /// 这是只读投影，不写文档、不造历史；`view-aids` 的会话部分由 [`Self::view_aids`] 给出。
    pub fn view_snapshot(&self) -> Result<Value> {
        let state = self.active_doc()?;
        let document = &state.doc;
        let size = [f64::from(document.size.width), f64::from(document.size.height)];
        let transform = self.view_aids.transform();
        let corner = transform.document_to_view([0.0, 0.0], size);
        let center = transform.document_to_view([size[0] / 2.0, size[1] / 2.0], size);
        let measurement = &document.measurement;
        Ok(json!({
            // 文档身份：面板把它回传成写入的 `targetDocument`，切标签后旧面板不会写到新文档。
            "document": { "id": document.id.0 },
            "scope": {
                "view": "session",
                "guides": "document",
                "rulerOrigin": "document",
                // 采样点在上游是会话状态；本 change 把它投影到文档元数据（保存时写入、载入时
                // 灌回），所以既不是纯会话数据，也不是文档历史里的一步。
                "samplers": "session+project",
                "count": "document",
                "notes": "document",
            },
            "guides": {
                "horizontal": document.guides.horizontal,
                "vertical": document.guides.vertical,
                "colors": document.guides.colors.iter().map(|color| json!({
                    "vertical": color.vertical, "position": color.position,
                    "rgb": [color.rgb[0], color.rgb[1], color.rgb[2]]
                })).collect::<Vec<_>>(),
                "visible": self.view_aids.guides,
                "locked": self.view_aids.lock_guides,
            },
            "rulerOrigin": document.ruler_origin,
            "units": self.view_aids.units,
            // 单位与吸附目标的合法取值由内核给出，界面不复制一份枚举（避免两处漂移）。
            "unitOptions": VIEW_UNITS,
            "snapTargets": SNAP_TARGETS,
            "maxViews": MAX_VIEWS,
            "sideBySide": self.view_aids.side_by_side,
            "documentSize": size,
            "rotation": self.view_aids.rotation_degrees,
            "transform": view_geometry::transform_json(&transform),
            // 旋转后源坐标依然可换算：文档左上角与中心在新坐标系中的位置。
            "projected": { "origin": corner, "center": center },
            "samplers": state.color_samplers.iter().enumerate().map(|(index, point)| json!({
                "index": index, "position": point
            })).collect::<Vec<_>>(),
            "measurement": {
                "scale": {
                    "pixelLength": measurement.scale.pixel_length,
                    "logicalLength": measurement.scale.logical_length,
                    "units": measurement.scale.units,
                    "describe": measurement.scale.describe(),
                },
                "ruler": measurement.ruler.map(|ruler| json!({
                    "start": ruler.start, "end": ruler.end, "protractor": ruler.protractor,
                    "info": photocraft_engine::analysis_cmds::ruler_info(&ruler, &measurement.scale),
                })),
                "count": {
                    "total": measurement.count_total(),
                    "activeGroup": measurement.active_count_group,
                    "groups": measurement.count_groups.iter().map(|group| json!({
                        "name": group.name,
                        "color": group.color.to_rgb(),
                        "markerSize": group.marker_size,
                        "labelSize": group.label_size,
                        "visible": group.visible,
                        "count": group.points.len(),
                        "points": group.points,
                    })).collect::<Vec<_>>(),
                },
                "logRows": self.session.analysis.log.len(),
            },
            "notes": document.notes.iter().enumerate().map(|(index, note)| json!({
                "index": index,
                "author": note.author,
                "text": note.text,
                "color": note.color.to_rgb(),
                "position": note.position,
                "open": note.open,
            })).collect::<Vec<_>>(),
        }))
    }

    /// 取样点读数的稳定视图（Info 面板按它渲染，不自己读像素）。
    pub fn sampler_readout(&self, index: usize) -> Result<Value> {
        let state = self.active_doc()?;
        let position = state
            .color_samplers
            .get(index)
            .copied()
            .ok_or_else(|| bad("view.samplers", format!("没有第 {index} 个取样点")))?;
        Ok(photocraft_engine::sampler_cmds::point_json(&state.doc, index, position))
    }

    /// 画布指针几何（U70/U72）：把客户坐标换成源坐标并给出命中/拖动结果。
    ///
    /// 只读：命中不影响文档，拖动返回的新位置由界面作为草稿显示，提交时才走
    /// `view.moveGuide` / `view.setRulerOrigin`。因此这里不过草稿门禁、不产生历史。
    ///
    /// 旋转后仍取源坐标：全部判定经 [`view_geometry::ViewTransform`]，与 TS
    /// `features/views/view-transform.ts` 逐公式一致。
    pub fn view_pointer(&self, action: &str, params: Value) -> Result<Value> {
        if !VIEW_POINTER_ACTIONS.contains(&action) {
            return Err(bad("view.pointer", format!("{action} 不是已开放的指针几何动作")));
        }
        // 「仅活动视图接收输入」：多视图共用同一份文档，非活动视图的迟到指针（或后台视图的
        // 拖动）不得影响活动视图的取景与命中。调用方带上来源 `viewId`，这里逐一核对。
        if let Some(source) = params.get("viewId").and_then(Value::as_str) {
            if self.view_aids.active_view().id != source {
                return Err(bad("view.pointer", format!("视图 {source} 不是活动视图")));
            }
        }
        let client = pointer_point(&params, "client")?;
        let state = self.active_doc()?;
        let document = [f64::from(state.doc.size.width), f64::from(state.doc.size.height)];
        let transform = self.view_aids.transform();
        transform
            .validate()
            .map_err(|reason| bad("view.pointer", reason))?;
        let tolerance = params
            .get("tolerance")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 64.0)
            .unwrap_or(6.0);
        match action {
            "hit-guide" => {
                let hit = view_geometry::hit_guide(
                    &transform,
                    client,
                    document,
                    &state.doc.guides.vertical,
                    &state.doc.guides.horizontal,
                    tolerance,
                );
                Ok(json!({
                    // 锁定参考线时不允许拖动：界面据此显示禁止光标而不是拖了没反应。
                    "locked": self.view_aids.lock_guides,
                    "hit": hit.map(|hit| json!({
                        "vertical": hit.vertical, "index": hit.index,
                        "position": hit.position, "distance": hit.distance,
                    })),
                }))
            }
            "drag-guide" => {
                let vertical = params
                    .get("vertical")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| bad("view.pointer", "drag-guide 需要 vertical"))?;
                let position = view_geometry::guide_drag_position(&transform, client, document, vertical);
                Ok(json!({ "vertical": vertical, "position": position, "locked": self.view_aids.lock_guides }))
            }
            "probe" => {
                // Info 跟随光标的源像素读数（U73）：读数用上游同一份合成采样（单像素、不平均），
                // 所以与颜色采样点/吸管逐值一致。
                //
                // **这里故意不用旋转**：本 change 的旋转只作用于叠加层与参考线几何，像素平面仍由
                // 宿主按 `origin/zoom` 呈现（`renderCanvasBackground(origin, zoom)` 没有旋转参数，
                // Woohaa 节点模式的 Bevy 节点同理）。若把旋转也套进读数，屏幕上看到的是未旋转的
                // 像素、面板却报另一处的像素，等于给了个假读数。读数属于「像素」这一侧，因此与
                // 落笔映射（共享 `coordinates.ts`，同样无旋转）保持一致。
                let pixel_transform = view_geometry::ViewTransform {
                    rotation_degrees: 0.0,
                    ..transform
                };
                let source = pixel_transform.view_to_document(client, document);
                let inside = source[0] >= 0.0
                    && source[1] >= 0.0
                    && source[0] < document[0]
                    && source[1] < document[1];
                if !inside {
                    return Ok(json!({
                        "unit": self.view_aids.units,
                        "reading": Value::Null,
                    }));
                }
                let (rgb, cmyk) =
                    photocraft_engine::sampler_cmds::readout(&state.doc, [source[0].floor(), source[1].floor()]);
                Ok(json!({
                    "unit": self.view_aids.units,
                    "reading": {
                        "source": [source[0], source[1]],
                        "pixel": [source[0].floor(), source[1].floor()],
                        "rgb": rgb,
                        "cmyk": cmyk,
                    },
                }))
            }
            _ => {
                let origin = view_geometry::ruler_origin_at(&transform, client, document);
                Ok(json!({ "origin": origin, "current": state.doc.ruler_origin }))
            }
        }
    }
}

/// 读取 `[x, y]` 形式的指针参数；非有限值明确拒绝而不是当成 0 落点。
fn pointer_point(params: &Value, key: &str) -> Result<[f64; 2]> {
    let point = params
        .get(key)
        .and_then(Value::as_array)
        .filter(|point| point.len() == 2)
        .ok_or_else(|| bad("view.pointer", format!("{key} 需要 [x, y]")))?;
    match (point[0].as_f64(), point[1].as_f64()) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Ok([x, y]),
        _ => Err(bad("view.pointer", format!("{key} 必须是有限数值"))),
    }
}
