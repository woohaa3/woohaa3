//! P5/P6/P7：修饰工具的唯一入口（change: 2026-10-22-add-photocraft-retouch-workflows，U37/U38/U39）。
//!
//! 三种事务形态，共用 `Editor` 的草稿门禁与历史：
//! - **笔迹**（`begin_retouch`/`append_retouch`/`commit_retouch`/`cancel_retouch`）：逐帧预览，
//!   确认一步历史；仿制/修复/图案图章/历史画笔/移除与局部修饰都走这里。
//! - **区域**（`begin_retouch_region`/`commit_retouch_region`/`cancel_retouch_region`）：修补、
//!   内容识别移动与红眼先算候选，确认才提交一次。
//! - **只读查询**（`retouch_history_sources`/`retouch_state`）：历史画笔源与活动门禁状态，
//!   不写内容、不制造 dirty。
//!
//! 区域候选不新增 `Editor` 字段：它复用既有的 `retouch_preview`（合成预览走同一
//! `preview_document` 分支）、`retouch_params`（带 `retouchRegion` 标记的信封）与
//! `retouch_command`。这样候选像素可见、正式文档与历史都不动；确认时用信封里的
//! `baseRevision`/`documentId` 丢弃晚到候选，取消或关闭文档只清空这三个槽位。
//! 共享门禁 `require_no_tool_draft` 仍只认笔迹基线，区域候选的“保存/切文档”拦截由
//! 集成负责人按 [parallel-work.md](../../../../../openspec/changes/2026-10-22-add-photocraft-retouch-workflows/parallel-work.md)
//! 扩展；候选本身从不改正式内容，因此保存冻结的仍是原文档。
use crate::retouch::{RetouchOpDraft, RetouchBaseline, history_sources, normalize_stroke_params};
use serde_json::{Value, json};

use crate::editor::*;
use super::command_error;

/// 区域候选信封在 `retouch_params` 中的标记键。
const REGION_MARKER: &str = "retouchRegion";

/// 区域候选的持久化形态（存在 `retouch_params`）。
///
/// 存的是**补齐后的**候选参数（`draft.params()`）：确认时按预览同一份参数提交，不重新解释
/// 缺省目标层。
fn region_envelope(draft: &RetouchOpDraft) -> Value {
    json!({
        REGION_MARKER: {
            "command": draft.command(),
            "params": draft.params(),
            "baseRevision": draft.base_revision,
            "documentId": draft.document_id,
            "changed": draft.changed,
            "result": draft.result(),
        }
    })
}

impl Editor {
    /// 开始修饰笔迹：冻结本笔基线并返回目标图层。
    pub fn begin_retouch(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if self.retouch_region_active() {
            return Err(command_error("paint.retouch", "请先确认或取消当前区域修饰候选"));
        }
        let params = normalize_stroke_params(id, &params);
        let baseline = RetouchBaseline::begin(&self.session, id, &params)?;
        let info = json!({
            "command": id,
            "layer": baseline.layer().0,
            "points": baseline.len(),
            "live": crate::retouch::LIVE_RETOUCH.contains(&id),
            "historySource": crate::retouch::history_index(&params),
        });
        self.retouch_baseline = Some(baseline);
        self.retouch_command = Some(id.to_string());
        self.retouch_params = Some(params);
        Ok(info)
    }

    /// 追加修饰采样点并返回预览文档（RGBA8 由调用方另行渲染或直接读 `render_preview`）。
    pub fn append_retouch(&mut self, points: Value) -> Result<Value> {
        if self.retouch_region_active() {
            return Err(command_error("paint.retouch", "区域修饰没有逐点预览"));
        }
        let params = self
            .retouch_params
            .as_ref()
            .ok_or_else(|| command_error("paint.retouch", "没有活动修饰笔迹"))?;
        let baseline = self
            .retouch_baseline
            .as_mut()
            .ok_or_else(|| command_error("paint.retouch", "没有活动修饰笔迹"))?;
        let list = points
            .get("points")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| command_error("paint.retouch", "缺少 points"))?;
        baseline.push(&list)?;
        let preview = baseline.preview(params)?;
        self.retouch_preview = Some(preview);
        Ok(json!({ "points": baseline.len() }))
    }

    /// 提交修饰笔迹：一步历史。
    pub fn commit_retouch(&mut self) -> Result<Value> {
        if self.retouch_region_active() {
            return Err(command_error("paint.retouch", "请使用区域修饰的确认入口"));
        }
        let params = self
            .retouch_params
            .take()
            .ok_or_else(|| command_error("paint.retouch", "没有活动修饰笔迹"))?;
        let baseline = self
            .retouch_baseline
            .take()
            .ok_or_else(|| command_error("paint.retouch", "没有活动修饰笔迹"))?;
        let points = baseline.len();
        let result = baseline.commit(&mut self.session, &params)?;
        self.retouch_preview = None;
        self.retouch_command = None;
        Ok(json!({ "points": points, "result": result }))
    }

    /// 取消修饰笔迹：不补交半笔。
    pub fn cancel_retouch(&mut self) -> Value {
        self.retouch_baseline = None;
        self.retouch_preview = None;
        self.retouch_command = None;
        self.retouch_params = None;
        json!({ "cancelled": true })
    }

    /// 修饰笔迹的活动状态（UI 门禁用）。
    pub fn retouch_state(&self) -> Value {
        json!({
            "active": self.retouch_baseline.is_some(),
            "command": self.retouch_command,
            "points": self.retouch_baseline.as_ref().map_or(0, |baseline| baseline.len()),
            "region": self.retouch_region_active(),
        })
    }

    /// 是否有活动的区域候选。
    pub fn retouch_region_active(&self) -> bool {
        self.retouch_params
            .as_ref()
            .is_some_and(|params| params.get(REGION_MARKER).is_some())
    }

    /// 开始区域修饰（修补／内容识别移动／红眼）：隔离会话算出候选，不写正式文档。
    pub fn begin_retouch_region(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if self.retouch_baseline.is_some() || self.retouch_region_active() {
            return Err(command_error("paint.retouch", "请先确认或取消当前修饰操作"));
        }
        let draft = RetouchOpDraft::begin(&self.session, id, &params)?;
        let info = json!({
            "command": id,
            "result": draft.result(),
            "changed": draft.changed,
            "revision": draft.base_revision,
        });
        self.retouch_preview = Some(draft.document.clone());
        self.retouch_command = Some(id.to_string());
        self.retouch_params = Some(region_envelope(&draft));
        Ok(info)
    }

    /// 确认区域修饰：最新有效候选提交一次，产生一步历史；无变化不新增历史。
    pub fn commit_retouch_region(&mut self) -> Result<Value> {
        let params = self
            .retouch_params
            .take()
            .ok_or_else(|| command_error("paint.retouch", "没有活动的区域修饰候选"))?;
        self.retouch_preview = None;
        self.retouch_command = None;
        let Some(region) = params.get(REGION_MARKER).cloned() else {
            return Err(command_error("paint.retouch", "没有活动的区域修饰候选"));
        };
        let command = region
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("paint.retouch", "区域候选缺少命令"))?
            .to_string();
        if region.get("changed").and_then(Value::as_bool) == Some(false) {
            // 无变化：不新增历史，也不把旧候选当成成功提交。
            return Ok(json!({ "command": command, "changed": false, "result": region.get("result").cloned().unwrap_or(Value::Null) }));
        }
        let draft = RetouchOpDraft::restore(
            &self.session,
            &command,
            region.get("params").cloned().unwrap_or(Value::Null),
            region.get("baseRevision").and_then(Value::as_u64).unwrap_or(0),
            region.get("documentId").and_then(Value::as_u64).unwrap_or(0),
            region.get("result").cloned().unwrap_or(Value::Null),
        )?;
        let result = draft.commit(&mut self.session)?;
        Ok(json!({ "command": command, "changed": true, "result": result }))
    }

    /// 取消区域修饰：丢弃候选，保留原文档。
    pub fn cancel_retouch_region(&mut self) -> Value {
        if self.retouch_region_active() {
            self.retouch_preview = None;
            self.retouch_command = None;
            self.retouch_params = None;
        }
        json!({ "cancelled": true })
    }

    /// 历史画笔可用的历史源（只读；标签与索引来自同一历史栈）。
    pub fn retouch_history_sources(&self) -> Result<Value> {
        let state = self.active_doc()?;
        Ok(history_sources(state))
    }

    /// 仿制源槽位与叠加选项（只读）。
    ///
    /// `cloneSource.list` 本身不写内容，但走 [`Editor::execute`] 时会先撞上共享草稿门禁
    /// `require_no_tool_draft`：落笔期间的叠加取样框与面板刷新正好需要它，结果整笔都拿不到
    /// 取景（叠加预览在真正作画的那一刻消失）。这里直接查会话的 presets：不写内容、不推进
    /// 历史、不制造 dirty，也**不**放开 select/set/overlay 等写命令的门禁——落笔中改工具
    /// 状态仍被拒绝，取样变换因此保持冻结。
    ///
    /// 仍先过唯一命令门：这条命令没有登记时拒绝，而不是绕开门禁。
    pub fn retouch_clone_sources(&mut self) -> Result<Value> {
        if !crate::capability::command_allowed("cloneSource.list") {
            return Err(EditorError::CapabilityDisabled("cloneSource.list".into()));
        }
        self.session
            .execute("cloneSource.list", Value::Null)
            .map_err(|failure| command_error("paint.retouch", failure.to_string()))
    }
}

#[cfg(test)]
#[path = "tests_workflows.rs"]
mod workflow_tests;
