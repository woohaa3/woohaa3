//! 选区与蒙版完整交互的内核入口（U17–U24）。
//!
//! 每个入口都遵守同一套事务规则（design D3）：
//! 草稿预览不推进修订／指纹／历史；确认只提交一次；无变化不增历史；失败保留现场。
//!
//! 这里只做**编译与事务**：选区、蒙版、快速蒙版与细化都走固定上游命令，本域不维护第二份
//! 选区/蒙版状态。上游没有的命令（命名选区的覆盖确认、蒙版属性、查看模式）由 UI 会话补上
//! 前置检查后仍交给上游执行。

use serde_json::{Value, json};

use crate::editor::*;
use super::command_error;
// 草稿类型由既有装配（`adjustment_ext` 里的 `#[path]` 引入本域文件）唯一定义；这里只使用它，
// 不复制第二份草稿状态，也不新建第二个内核会话类型。
use crate::adjustment_ext::{
    DraftKind, RefineOutput, SelectionDraft, refine_brushes, refine_edge_params,
};

#[cfg(test)]
#[path = "tests_workflows.rs"]
mod tests_workflows;

impl Editor {
    // ------------------------------------------------------------------ 通用草稿门禁

    /// 打开草稿前的门禁：没有活动文档、已有其他草稿或笔迹时拒绝。
    fn selection_draft_gate(&self) -> Result<()> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if self.selection_draft.is_some() {
            return Err(command_error("select.draft", "已有活动选区草稿，请先确认或取消"));
        }
        Ok(())
    }

    /// 草稿是否仍归属当前活动文档。
    ///
    /// 草稿的候选是打开时那份文档的快照。活动文档一旦被换掉（切标签、关掉再开、父子回写
    /// 换了目标），同一份候选就不再是"这个文档的候选"：确认它等于把 A 的选区写进 B。这里在
    /// 提交入口统一比对 `DocState::doc.id`，不一致就拒绝并要求重新打开草稿。
    fn selection_draft_owner_gate(&self, draft: &SelectionDraft) -> Result<()> {
        let active = self
            .session
            .active()
            .ok_or_else(|| command_error("select.draft", "没有可编辑的文档，已丢弃过期选区草稿"))?;
        if draft.owner().0 != active.doc.id.0 {
            return Err(command_error(
                "select.draft",
                "活动文档已切换，过期选区草稿不能写入当前文档；请取消后重新打开",
            ));
        }
        Ok(())
    }

    /// 当前草稿（对外只读视图，含候选边界与种类）。
    pub fn selection_draft_state(&self) -> Value {
        match self.selection_draft.as_ref() {
            None => json!({ "active": false }),
            Some(draft) => {
                let (document, revision) = draft.owner();
                // `stale` 只表示"草稿仍在，但它属于别的文档"，供界面提示并禁用确认；
                // 判定与提交入口共用同一来源（活动 `DocState::doc.id`）。
                let stale = self
                    .session
                    .active()
                    .is_none_or(|active| active.doc.id.0 != document);
                json!({
                    "active": true,
                    "kind": draft.kind().id(),
                    "document": document,
                    "revision": revision,
                    "stale": stale,
                    "bounds": draft.bounds(),
                    "maskBounds": draft.mask_bounds(),
                    "invalid": draft.invalid(),
                    "draft": draft.describe(),
                })
            }
        }
    }

    /// 候选边界（预览叠加直接读这里，保证预览与确认后内核边界一致）。
    pub fn selection_draft_outline(&self) -> Value {
        json!(self.selection_draft.as_ref().map(SelectionDraft::outline).unwrap_or_default())
    }

    /// 关闭当前草稿（取消语义；不写文档）。
    pub fn cancel_selection_draft(&mut self) -> Value {
        let had = self.selection_draft.take().is_some();
        json!({ "cancelled": had })
    }

    /// 提交当前草稿：一次历史或一条上游命令；失败保留草稿现场。
    pub fn commit_selection_draft(&mut self) -> Result<Value> {
        let draft = self
            .selection_draft
            .take()
            .ok_or_else(|| command_error("select.draft", "没有活动选区草稿"))?;
        if let Err(failure) = self.selection_draft_owner_gate(&draft) {
            // 过期草稿不能重试成功，直接丢弃现场，避免用户反复确认同一份错候选。
            return Err(failure);
        }
        match draft.apply(&mut self.session) {
            Ok(value) => Ok(value),
            Err(failure) => {
                // 失败保留现场，调用方可以修正参数后重试。
                self.selection_draft = Some(draft);
                Err(failure)
            }
        }
    }

    // ------------------------------------------------------------------ 选区修改（既有契约）

    /// 打开选区修改草稿（扩展／收缩／平滑／边界／羽化）。
    pub fn begin_selection_modify(&mut self, params: Value) -> Result<Value> {
        self.selection_draft_gate()?;
        let operation = params
            .get("operation")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("select.modify", "缺少 operation"))?;
        let radius = params
            .get("radius")
            .and_then(Value::as_f64)
            .ok_or_else(|| command_error("select.modify", "缺少 radius"))?;
        let draft = SelectionDraft::new(self.active_doc()?, operation, radius)?;
        let info = json!({ "bounds": draft.bounds(), "outline": draft.outline(), "draft": draft.describe() });
        self.selection_draft = Some(draft);
        Ok(info)
    }

    /// 更新选区修改草稿：始终以打开时快照为基线，避免叠加在旧候选上。
    pub fn update_selection_modify(&mut self, params: Value) -> Result<Value> {
        let (base, operation) = match self.selection_draft.as_ref() {
            Some(draft) if draft.kind() == DraftKind::Modify => (
                draft.base_state(),
                draft.params.get("operation").and_then(Value::as_str).unwrap_or("expand").to_string(),
            ),
            _ => return Err(command_error("select.modify", "没有活动选区修改")),
        };
        let operation = params.get("operation").and_then(Value::as_str).unwrap_or(&operation).to_string();
        let radius = params.get("radius").and_then(Value::as_f64);
        let base_radius = self
            .selection_draft
            .as_ref()
            .and_then(|draft| draft.params.get("radius").and_then(Value::as_f64))
            .unwrap_or(1.0);
        match SelectionDraft::new(&base, &operation, radius.unwrap_or(base_radius)) {
            Ok(draft) => {
                let info = json!({ "bounds": draft.bounds(), "outline": draft.outline(), "draft": draft.describe() });
                self.selection_draft = Some(draft);
                Ok(info)
            }
            Err(failure) => {
                if let Some(draft) = self.selection_draft.as_mut() {
                    draft.mark_invalid();
                }
                Err(failure)
            }
        }
    }

    /// 确认选区修改：一次历史。
    pub fn commit_selection_modify(&mut self) -> Result<Value> {
        if let Some(draft) = self.selection_draft.as_ref() {
            // 活动文档已被换掉时不能把旧候选写进新文档；保留现场，让调用方先取消。
            self.selection_draft_owner_gate(draft)?;
        }
        let draft = self
            .selection_draft
            .take()
            .ok_or_else(|| command_error("select.modify", "没有活动选区修改"))?;
        let bounds = draft.bounds();
        match draft.commit(&mut self.session) {
            Ok(()) => Ok(json!({ "committed": true, "bounds": bounds })),
            Err(failure) => {
                // 失败保留现场，调用方可以修正参数后重试。
                self.selection_draft = Some(draft);
                Err(failure)
            }
        }
    }

    /// 取消选区修改（关闭文档时也会调用）。
    pub fn cancel_selection_modify(&mut self) -> Value {
        self.cancel_selection_draft()
    }

    /// 选区为空时任何依赖选区的操作都明确拒绝（修饰、滤镜共用）。
    pub fn require_selection(&self) -> Result<()> {
        let state = self.active_doc()?;
        if state.doc.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
            return Err(command_error("select", "没有活动选区"));
        }
        Ok(())
    }

    // ------------------------------------------------------------------ U17 单行/单列选框

    /// 单行／单列选框：一行／一列源像素，沿用同一选择组合模式。
    ///
    /// 参数是文档坐标的单击点；`line` 为 `row`（单行）或 `column`（单列）。
    pub fn select_line(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let x = params
            .get("x")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| command_error("select.line", "缺少有效的 x 坐标"))?;
        let y = params
            .get("y")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| command_error("select.line", "缺少有效的 y 坐标"))?;
        let line = params.get("line").and_then(Value::as_str).unwrap_or("row");
        if line != "row" && line != "column" {
            return Err(command_error("select.line", format!("line 必须是 row 或 column，收到 {line}")));
        }
        let (width, height) = (state.doc.size.width, state.doc.size.height);
        let (x, y) = (x.floor() as i64, y.floor() as i64);
        if x < 0 || y < 0 || x >= i64::from(width) || y >= i64::from(height) {
            return Err(command_error(
                "select.line",
                format!("单击点在画布外（{x}, {y}）；画布为 {width}×{height}"),
            ));
        }
        let line_params = json!({
            // 单行/单列是“一行/一列源像素”本身：单击只决定落在哪一行/列，跨度覆盖整个画布。
            "x": if line == "row" { 0 } else { x },
            "y": if line == "row" { y } else { 0 },
            "width": if line == "row" { width } else { 1 },
            "height": if line == "row" { 1 } else { height },
            "mode": params.get("mode").and_then(Value::as_str).unwrap_or("replace"),
            "line": line,
            "antiAlias": false,
            "feather": 0,
        });
        if let Some(value) = params.get("feather").and_then(Value::as_f64) {
            // 单行/单列不羽化：羽化会把一像素行扩散成多行，与“准确的一源像素行”冲突。
            if value != 0.0 {
                return Err(command_error("select.line", "单行/单列选框不支持羽化"));
            }
        }
        let result = self.execute("select.rect", line_params)?;
        Ok(json!({ "line": line, "x": x, "y": y, "result": result, "bounds": self.selection_bounds_json() }))
    }

    /// 当前选区包围盒 `[x, y, w, h]`（无选区为 null）。
    pub fn selection_bounds_json(&self) -> Value {
        match self.active_doc().ok().and_then(|state| state.doc.selection.as_ref()).map(|selection| selection.content_bounds()) {
            Some(rect) if !rect.is_empty() => json!([rect.x0, rect.y0, rect.width() as i32, rect.height() as i32]),
            _ => Value::Null,
        }
    }

    // ------------------------------------------------------------------ U18 多边形/磁性套索

    /// 多边形套索：预览候选并在确认时提交一次；锚点不足直接拒绝。
    pub fn begin_magnetic_lasso(&mut self, params: Value) -> Result<Value> {
        self.selection_draft_gate()?;
        let draft = SelectionDraft::magnetic(self.active_doc()?, params)?;
        let info = json!({
            "kind": DraftKind::Magnetic.id(),
            "bounds": draft.bounds(),
            "outline": draft.outline(),
            "draft": draft.describe(),
        });
        self.selection_draft = Some(draft);
        Ok(info)
    }

    /// 磁性套索参数更新（重新追踪）；非法输入标记草稿不可确认。
    pub fn update_magnetic_lasso(&mut self, params: Value) -> Result<Value> {
        let current = self
            .selection_draft
            .as_ref()
            .filter(|draft| draft.kind() == DraftKind::Magnetic)
            .ok_or_else(|| command_error("select.magneticLasso", "没有活动的磁性套索预览"))?;
        let base = current.base_state();
        match SelectionDraft::magnetic(&base, params) {
            Ok(draft) => {
                let info = json!({ "bounds": draft.bounds(), "outline": draft.outline(), "draft": draft.describe() });
                self.selection_draft = Some(draft);
                Ok(info)
            }
            Err(failure) => {
                if let Some(draft) = self.selection_draft.as_mut() {
                    draft.mark_invalid();
                }
                Err(failure)
            }
        }
    }

    // ------------------------------------------------------------------ U19 命名选区 / Grow / Similar

    /// 命名选区的存储名额：新增一个通道前的条目核对。
    ///
    /// 每个命名选区都是**整整一个画布大小**的灰度平面，作为独立条目跟工程一起保存。上游命令
    /// 不设上限，所以这里复用工程已有的权威预算 `MAX_ENTRIES`（与 `project-limits.json` 由
    /// `limits_agree` 交叉核对），不另造一套数字。
    ///
    /// 只按条目计，不按字节估算：工程里通道是**稀疏分块**存储的，按画布面积推算字节会把
    /// 已有的大画布多图层工程误判为超限。条目数是一对一可核对的边界。
    fn check_named_selection_capacity(doc: &photocraft_doc::Document) -> Result<()> {
        use photocraft_project_verify::MAX_ENTRIES;
        // 层与通道共享同一份条目预算（工程按条目解包）；这次新增要再占一个。
        let used = doc.layers.len() + doc.channels.len() + 1;
        if used > MAX_ENTRIES {
            return Err(command_error(
                "select.saveSelection",
                format!(
                    "命名选区条目已满（层 {} + 通道 {} ≥ 上限 {}）；请覆盖已有命名选区或删除不用的通道",
                    doc.layers.len(),
                    doc.channels.len(),
                    MAX_ENTRIES,
                ),
            ));
        }
        Ok(())
    }

    /// 保存命名选区：同名未确认覆盖时拒绝（`overwrite` 明确后才替换）。
    pub fn save_named_selection(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| command_error("select.saveSelection", "命名选区必须有名称"))?;
        if name.chars().count() > 200 {
            return Err(command_error("select.saveSelection", "选区名称过长（最多 200 字符）"));
        }
        let state = self.active_doc()?;
        if state.doc.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
            return Err(command_error("select.saveSelection", "没有可保存的选区"));
        }
        let existing = state.doc.channels.iter().position(|channel| channel.name == name);
        let overwrite_allowed = params.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
        if existing.is_some() && !overwrite_allowed {
            return Err(command_error(
                "select.saveSelection",
                format!("已存在名为“{name}”的通道；请确认覆盖或换一个名称"),
            ));
        }
        // 新增命名选区会多一整个画布大小的灰度平面：名额与体积都要先核对。
        // 覆盖同名通道不增加存储，因此只在"新增"这一支做预算检查。
        if existing.is_none() {
            Self::check_named_selection_capacity(&state.doc)?;
        }
        let mut save = json!({
            "name": name,
            "operation": if existing.is_some() { "replace" } else { "new" },
        });
        if let Some(index) = existing {
            save["channel"] = json!(index);
        }
        let result = self.execute("select.saveSelection", save)?;
        Ok(json!({ "saved": true, "name": name, "overwritten": existing, "result": result }))
    }

    /// 加载命名选区：按名称或 `"selection"`（进入快速蒙版前的选区）恢复。
    pub fn load_named_selection(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let channel = match params.get("name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()) {
            Some(name) => {
                let exists = state.doc.channels.iter().any(|channel| channel.name == name);
                if !exists {
                    return Err(command_error("select.loadSelection", format!("没有名为“{name}”的命名选区")));
                }
                json!(name)
            }
            None => json!("selection"),
        };
        let mut load = json!({
            "channel": channel,
            "operation": params.get("operation").and_then(Value::as_str).unwrap_or("new"),
        });
        if let Some(invert) = params.get("invert").and_then(Value::as_bool) {
            load["invert"] = json!(invert);
        }
        let result = self.execute("select.loadSelection", load)?;
        Ok(json!({ "loaded": true, "result": result, "bounds": self.selection_bounds_json() }))
    }

    /// 按颜色扩大或选取相似：与几何扩展不同，预览走真实候选选区。
    pub fn begin_color_grow(&mut self, similar: bool, params: Value) -> Result<Value> {
        self.selection_draft_gate()?;
        let draft = SelectionDraft::color_grow(self.active_doc()?, similar, params)?;
        let info = json!({
            "kind": draft.kind().id(),
            "bounds": draft.bounds(),
            "outline": draft.outline(),
            "draft": draft.describe(),
        });
        self.selection_draft = Some(draft);
        Ok(info)
    }

    /// 按颜色扩大/相似的参数更新；非法容差标记草稿不可确认。
    pub fn update_color_grow(&mut self, params: Value) -> Result<Value> {
        let (base, similar) = match self.selection_draft.as_ref() {
            Some(draft) if draft.kind() == DraftKind::Grow => (draft.base_state(), false),
            Some(draft) if draft.kind() == DraftKind::Similar => (draft.base_state(), true),
            _ => return Err(command_error("select.grow", "没有活动的扩大/相似预览")),
        };
        match SelectionDraft::color_grow(&base, similar, params) {
            Ok(draft) => {
                let info = json!({ "bounds": draft.bounds(), "outline": draft.outline(), "draft": draft.describe() });
                self.selection_draft = Some(draft);
                Ok(info)
            }
            Err(failure) => {
                if let Some(draft) = self.selection_draft.as_mut() {
                    draft.mark_invalid();
                }
                Err(failure)
            }
        }
    }

    // ------------------------------------------------------------------ U20 快速蒙版

    /// 进入快速蒙版：保留进入时的选区作为基线，绘画只写临时通道。
    pub fn begin_quick_mask(&mut self) -> Result<Value> {
        self.selection_draft_gate()?;
        let draft = SelectionDraft::quick_mask(self.active_doc()?)?;
        let info = json!({
            "kind": DraftKind::QuickMask.id(),
            "bounds": draft.bounds(),
            "quickMask": true,
            "draft": draft.describe(),
        });
        self.selection_draft = Some(draft);
        Ok(info)
    }

    /// 快速蒙版笔迹：只写候选文档的临时选择通道。
    pub fn paint_quick_mask(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let draft = self
            .selection_draft
            .as_mut()
            .ok_or_else(|| command_error("select.editInQuickMaskMode", "没有活动的快速蒙版会话"))?;
        draft.paint_quick_mask(params)
    }

    /// 退出快速蒙版并转回选区（提交一次历史）；`cancel` 恢复进入前的选区。
    pub fn exit_quick_mask(&mut self, cancel: bool) -> Result<Value> {
        let Some(draft) = self.selection_draft.as_ref() else {
            return Err(command_error("select.editInQuickMaskMode", "没有活动的快速蒙版会话"));
        };
        if draft.kind() != DraftKind::QuickMask {
            return Err(command_error("select.editInQuickMaskMode", "当前草稿不是快速蒙版"));
        }
        if cancel {
            self.selection_draft = None;
            return Ok(json!({ "quickMask": false, "cancelled": true, "bounds": self.selection_bounds_json() }));
        }
        let value = self.commit_selection_draft()?;
        Ok(json!({ "quickMask": false, "committed": true, "result": value, "bounds": self.selection_bounds_json() }))
    }

    // ------------------------------------------------------------------ U21 传统分割

    /// 传统对象／主体／天空／焦点选择与移除背景：采样区域、参数、候选遮罩。
    ///
    /// 这些是上游的**传统**分割（超像素显著性 + GrabCut / 局部拉普拉斯），不是 AI 模型；
    /// 命令本身在 `session.execute` 里一次成史，这里只做参数编译与候选预览。
    pub fn begin_smart_select(&mut self, kind: &str, params: Value) -> Result<Value> {
        self.selection_draft_gate()?;
        let command = match kind {
            "object" => "select.object",
            "subject" => "select.subject",
            "sky" => "select.sky",
            "focusArea" => "select.focusArea",
            "removeBackground" => "layer.removeBackground",
            other => {
                return Err(command_error("select.smart", format!("未知的传统分割类型：{other}")));
            }
        };
        let compiled = compile_smart_select(kind, &params)?;
        // 能力门禁是唯一写入口：草稿确认直接调用会话，因此必须在这里先过同一道门。
        if !crate::capability::command_allowed(command) {
            return Err(EditorError::CapabilityDisabled(command.into()));
        }
        let state = self.active_doc()?;
        if kind == "removeBackground" {
            // 移除背景写图层蒙版：先确认目标层是未锁定的像素层，避免长计算后才发现不能写。
            let layer = state
                .active_layer
                .ok_or_else(|| command_error(command, "没有活动图层"))?;
            let target = state.doc.layer(layer).ok_or_else(|| command_error(command, "活动图层已不存在"))?;
            if !matches!(target.content, photocraft_doc::LayerContent::Raster(_)) {
                return Err(command_error(command, "移除背景只作用于像素图层"));
            }
            let locks = state.doc.effective_locks(layer);
            if locks.pixels || locks.all {
                return Err(command_error(command, "图层像素已锁定，无法移除背景"));
            }
            if target.mask.is_some() {
                return Err(command_error(command, "图层已有蒙版；请先删除或应用现有蒙版"));
            }
        }
        let preview = scratch_smart_select(state, command, compiled.clone())?;
        if kind == "sky" && preview.get("changed").and_then(Value::as_bool) == Some(false) {
            return Err(command_error(command, "没有检测到天空；请调整阈值或软化"));
        }
        // 输出目标属于本域草稿的意图，不能交给上游分割命令；确认时由草稿自己执行第二步。
        let mut compiled = compiled;
        let output = match params.get("output").and_then(Value::as_str) {
            None | Some("selection") => "selection",
            Some("mask" | "layerMask") => "mask",
            Some(other) => {
                return Err(command_error(command, format!("未知输出目标：{other}（selection|mask）")));
            }
        };
        if kind == "removeBackground" && output == "mask" {
            return Err(command_error(command, "移除背景本身就是输出像素蒙版，不需要再选输出目标"));
        }
        if let Some(object) = compiled.as_object_mut() {
            object.insert("output".into(), json!(output));
        }
        let info = json!({
            "kind": kind,
            "command": command,
            "params": compiled,
            "output": output,
            "preview": preview,
            "bounds": preview.get("bounds").cloned().unwrap_or(Value::Null),
            "traditional": true,
        });
        self.selection_draft = Some(SelectionDraft::smart_select(state, command, compiled, preview)?);
        Ok(info)
    }

    // ------------------------------------------------------------------ U22 色彩范围

    /// 色彩范围：画布多点/增减取样、局部颜色群组与范围、色调区间、采样层。
    pub fn begin_color_range(&mut self, params: Value) -> Result<Value> {
        self.selection_draft_gate()?;
        let draft = SelectionDraft::color_range(self.active_doc()?, params)?;
        let info = json!({
            "kind": DraftKind::ColorRange.id(),
            "bounds": draft.bounds(),
            "outline": draft.outline(),
            "draft": draft.describe(),
        });
        self.selection_draft = Some(draft);
        Ok(info)
    }

    /// 色彩范围参数更新；非法取样标记草稿不可确认。
    pub fn update_color_range(&mut self, params: Value) -> Result<Value> {
        let base = match self.selection_draft.as_ref() {
            Some(draft) if draft.kind() == DraftKind::ColorRange => draft.base_state(),
            _ => return Err(command_error("select.colorRange", "没有活动的色彩范围预览")),
        };
        match SelectionDraft::color_range(&base, params) {
            Ok(draft) => {
                let info = json!({ "bounds": draft.bounds(), "outline": draft.outline(), "draft": draft.describe() });
                self.selection_draft = Some(draft);
                Ok(info)
            }
            Err(failure) => {
                if let Some(draft) = self.selection_draft.as_mut() {
                    draft.mark_invalid();
                }
                Err(failure)
            }
        }
    }

    // ------------------------------------------------------------------ U23 选择并遮住

    /// 选择并遮住：真实内核隔离草稿（边缘 + 前景/背景修边笔 + smartRadius + 采样层）。
    pub fn begin_refine_edge(&mut self, params: Value) -> Result<Value> {
        self.selection_draft_gate()?;
        let draft = SelectionDraft::refine(self.active_doc()?, params)?;
        let info = json!({
            "kind": DraftKind::Refine.id(),
            "bounds": draft.bounds(),
            "maskBounds": draft.mask_bounds(),
            "outline": draft.outline(),
            "output": draft.params.get("output").cloned().unwrap_or(json!("selection")),
            "draft": draft.describe(),
        });
        self.selection_draft = Some(draft);
        Ok(info)
    }

    /// 选择并遮住参数／笔迹更新：每次都从候选基线重新计算，预览即确认结果。
    pub fn update_refine_edge(&mut self, params: Value) -> Result<Value> {
        let base = match self.selection_draft.as_ref() {
            Some(draft) if draft.kind() == DraftKind::Refine => draft.base_state(),
            _ => return Err(command_error("select.refineEdge", "没有活动的选择并遮住预览")),
        };
        match SelectionDraft::refine(&base, params) {
            Ok(draft) => {
                let info = json!({
                    "bounds": draft.bounds(),
                    "maskBounds": draft.mask_bounds(),
                    "outline": draft.outline(),
                    "output": draft.params.get("output").cloned().unwrap_or(json!("selection")),
                    "draft": draft.describe(),
                });
                self.selection_draft = Some(draft);
                Ok(info)
            }
            Err(failure) => {
                if let Some(draft) = self.selection_draft.as_mut() {
                    draft.mark_invalid();
                }
                Err(failure)
            }
        }
    }

    /// 只编译选择并遮住参数（不建草稿，供参数回执与旧 UI 兼容）。
    pub fn prepare_refine_edge(&self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let state = self.active_doc()?;
        let has_mask = state
            .active_layer
            .and_then(|id| state.doc.layer(id))
            .and_then(|layer| layer.mask.as_ref())
            .is_some();
        if state.doc.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) && !has_mask {
            return Err(command_error("select.refineEdge", "没有可细化的选区"));
        }
        let output = RefineOutput::parse(params.get("output"))?;
        let mut compiled = refine_edge_params(&params, output)?;
        let strokes = refine_brushes(&params)?;
        if !strokes.is_empty() {
            compiled["refineStrokes"] = json!(strokes);
        }
        Ok(json!({ "params": compiled, "output": output.command() }))
    }

    // ------------------------------------------------------------------ U24 像素蒙版属性

    /// 像素蒙版 density／非破坏 feather：只改属性，不动蒙版采样值。
    pub fn edit_layer_mask(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let layer = match params.get("layer").and_then(Value::as_u64) {
            Some(id) => photocraft_doc::LayerId(id),
            None => state
                .active_layer
                .ok_or_else(|| command_error("layer.layerMask.edit", "没有活动图层"))?,
        };
        let target = state
            .doc
            .layer(layer)
            .ok_or_else(|| command_error("layer.layerMask.edit", "目标图层已不存在"))?;
        let mask = target
            .mask
            .as_ref()
            .ok_or_else(|| command_error("layer.layerMask.edit", "目标图层没有像素蒙版"))?;
        if params.get("density").is_none() && params.get("feather").is_none() {
            return Err(command_error("layer.layerMask.edit", "至少需要一个 density 或 feather 参数"));
        }
        if let Some(density) = params.get("density").and_then(Value::as_f64) {
            if !density.is_finite() || !(0.0..=100.0).contains(&density) {
                return Err(command_error("layer.layerMask.edit", "密度必须在 0–100 之间"));
            }
        }
        if let Some(feather) = params.get("feather").and_then(Value::as_f64) {
            if !feather.is_finite() || !(0.0..=1000.0).contains(&feather) {
                return Err(command_error("layer.layerMask.edit", "羽化必须在 0–1000 源像素之间"));
            }
        }
        let (before_density, before_feather) = (mask.density, mask.feather);
        let before = (target.mask.as_ref().map(|mask| mask.surface.content_bounds()), before_density, before_feather);
        let mut edit = params.clone();
        if let Some(object) = edit.as_object_mut() {
            object.insert("layer".into(), json!(layer.0));
            object.insert("document".into(), json!(state.doc.id.0));
        }
        let result = self.execute("layer.layerMask.edit", edit)?;
        let after = self.active_doc()?.doc.layer(layer).and_then(|layer| layer.mask.as_ref());
        // 只改 density／feather 属性：蒙版采样值必须原样保留（比较采样包围盒）。
        let pixels_preserved = after.map(|mask| mask.surface.content_bounds()) == before.0;
        let after = after.map(|mask| (mask.density, mask.feather));
        Ok(json!({
            "result": result,
            "layer": layer.0,
            // 内核按 f32 存 density（0–1），回执换算回 0–100 时按两位小数取整，避免 40.000000596。
            "density": after.map_or(f64::from(before_density) * 100.0, |(density, _)| round_percent(f64::from(density) * 100.0)),
            "feather": after.map_or(before_feather, |(_, feather)| feather),
            "pixelsPreserved": pixels_preserved,
            "changed": after != Some((before_density, before_feather)),
        }))
    }

    /// 像素蒙版的属性视图：density、feather 与可见查看模式。
    pub fn layer_mask_properties(&self, layer: Option<u64>) -> Result<Value> {
        let state = self.active_doc()?;
        let id = match layer.map(photocraft_doc::LayerId).or(state.active_layer) {
            Some(id) => id,
            None => return Ok(json!({ "layer": Value::Null, "mask": Value::Null })),
        };
        let target = state
            .doc
            .layer(id)
            .ok_or_else(|| command_error("layer.layerMask.edit", "目标图层已不存在"))?;
        let view = photocraft_engine::mask_view_cmds::current(state);
        Ok(json!({
            "layer": id.0,
            "mask": target.mask.as_ref().map(|mask| json!({
                "enabled": mask.enabled,
                "linked": mask.linked,
                "density": round_percent(f64::from(mask.density) * 100.0),
                "feather": mask.feather,
            })),
            "view": view.map(|shown| if shown.mode == photocraft_engine::mask_view_cmds::MaskViewMode::Gray { "gray" } else { "overlay" }),
            "editTarget": if crate::layer_preview::mask_target(state) { "mask" } else { "pixels" },
        }))
    }

    /// 独立／叠加查看蒙版（查看状态：不是内容历史）。
    pub fn view_layer_mask(&mut self, params: Value) -> Result<Value> {
        let state = self.active_doc()?;
        let id = match params.get("layer").and_then(Value::as_u64) {
            Some(id) => photocraft_doc::LayerId(id),
            None => state
                .active_layer
                .ok_or_else(|| command_error("view.layerMask", "没有活动图层"))?,
        };
        if state.doc.layer(id).and_then(|layer| layer.mask.as_ref()).is_none() {
            return Err(command_error("view.layerMask", "目标图层没有像素蒙版"));
        }
        let mode = params.get("mode").and_then(Value::as_str).unwrap_or("off");
        let wire = match mode {
            "off" => "off",
            "gray" | "isolated" => "gray",
            "overlay" => "overlay",
            "toggleGray" => "toggleGray",
            "toggleOverlay" => "toggleOverlay",
            other => {
                return Err(command_error(
                    "view.layerMask",
                    format!("未知查看模式：{other}（off|gray|overlay|toggleGray|toggleOverlay）"),
                ))
            }
        };
        let before = self.content_hash().ok();
        let result = self.execute("view.layerMask", json!({ "layer": id.0, "mode": wire }))?;
        // 查看不是内容历史：内容指纹必须不变。
        let after = self.content_hash().ok();
        Ok(json!({
            "result": result,
            "layer": id.0,
            "mode": mode,
            "contentUnchanged": before == after,
        }))
    }
}

/// 蒙版 density 的对外百分比（内核按 f32 存 0–1，回执按两位小数取整）。
fn round_percent(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// 传统分割的参数编译：只保留命令真正接受的字段，并校验范围。
fn compile_smart_select(kind: &str, params: &Value) -> Result<Value> {
    let number = |key: &str, range: (f64, f64), fallback: f64| -> Result<f64> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(fallback),
            Some(value) => value
                .as_f64()
                .filter(|value| value.is_finite() && *value >= range.0 && *value <= range.1)
                .ok_or_else(|| command_error("select.smart", format!("{key} 必须在 {}–{} 之间", range.0, range.1))),
        }
    };
    let mode = params.get("mode").and_then(Value::as_str).unwrap_or("replace");
    if !matches!(mode, "replace" | "new" | "add" | "subtract" | "intersect") {
        return Err(command_error("select.smart", format!("未知选择模式：{mode}")));
    }
    let sample_all = params.get("sampleAllLayers").and_then(Value::as_bool);
    match kind {
        "object" => {
            let rect = params.get("rect");
            let point = params.get("point");
            if rect.is_none() && point.is_none() {
                return Err(command_error("select.object", "对象选择需要矩形区域或取样点"));
            }
            let mut out = json!({ "mode": mode });
            if let Some(rect) = rect {
                let values = rect
                    .as_array()
                    .filter(|values| values.len() == 4)
                    .map(|values| values.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
                    .filter(|values| values.len() == 4 && values.iter().all(|value| value.is_finite()))
                    .ok_or_else(|| command_error("select.object", "rect 必须是 [x, y, w, h]"))?;
                if values[2] <= 0.0 || values[3] <= 0.0 {
                    return Err(command_error("select.object", "矩形宽高必须为正"));
                }
                out["rect"] = json!(values);
            }
            if let Some(point) = point {
                let values = point
                    .as_array()
                    .filter(|values| values.len() == 2)
                    .map(|values| values.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
                    .filter(|values| values.len() == 2 && values.iter().all(|value| value.is_finite()))
                    .ok_or_else(|| command_error("select.object", "point 必须是 [x, y]"))?;
                out["point"] = json!(values);
            }
            if let Some(sample_all) = sample_all {
                out["sampleAllLayers"] = json!(sample_all);
            }
            Ok(out)
        }
        "subject" => {
            let mut out = json!({ "mode": mode, "sampleAllLayers": sample_all.unwrap_or(true) });
            if let Some(value) = out.as_object_mut() {
                value.entry("sampleAllLayers").or_insert(json!(true));
            }
            Ok(out)
        }
        "sky" => Ok(json!({
            "mode": mode,
            "sampleAllLayers": sample_all.unwrap_or(true),
            "threshold": number("threshold", (0.0, 100.0), 50.0)?,
            "softness": number("softness", (0.0, 100.0), 50.0)?,
        })),
        "focusArea" => Ok(json!({
            "mode": mode,
            "sampleAllLayers": sample_all.unwrap_or(true),
            "range": number("range", (0.0, 1.0), 0.5)?,
            "noise": number("noise", (0.0, 1.0), 0.0)?,
        })),
        _ => Ok(json!({
            "sampleAllLayers": sample_all.unwrap_or(false),
            "refine": params.get("refine").and_then(Value::as_bool).unwrap_or(true),
        })),
    }
}

/// 传统分割的候选预览：在临时会话里跑一次真实命令，只报告候选包围盒与是否命中。
fn scratch_smart_select(state: &photocraft_engine::DocState, command: &str, params: Value) -> Result<Value> {
    let mut scratch = photocraft_engine::Session::new();
    scratch.add_document((*state.doc).clone(), None);
    if let Some(active) = scratch.active_mut() {
        *active = state.clone();
    }
    let result = scratch
        .execute(command, params)
        .map_err(|failure| command_error(command, failure))?;
    let active = scratch
        .active()
        .ok_or_else(|| command_error(command, "临时会话没有活动文档"))?;
    let bounds = active
        .doc
        .selection
        .as_ref()
        .map(|selection| selection.content_bounds())
        .filter(|rect| !rect.is_empty())
        .map(|rect| json!([rect.x0, rect.y0, rect.width() as i32, rect.height() as i32]));
    let layer = state.active_layer.and_then(|id| active.doc.layer(id));
    let mask_bounds = layer
        .and_then(|layer| layer.mask.as_ref())
        .map(|mask| mask.surface.content_bounds())
        .filter(|rect| !rect.is_empty())
        .map(|rect| json!([rect.x0, rect.y0, rect.width() as i32, rect.height() as i32]));
    Ok(json!({
        "selected": active.doc.selection.is_some(),
        "bounds": bounds,
        "maskBounds": mask_bounds,
        "changed": result.get("changed").cloned().unwrap_or(json!(true)),
        "coverage": result.get("coverage").cloned().unwrap_or(Value::Null),
        "message": result.get("message").cloned().unwrap_or(Value::Null),
    }))
}
