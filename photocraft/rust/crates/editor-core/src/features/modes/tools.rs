//! 图像模式与调色板的编辑内核入口
//! （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 2.1 / design D1/D3）。
//!
//! 四个入口都遵守「预览不改正式文档」：
//!
//! - [`Editor::mode_info`]：只读模式信息（模式、颜色表、油墨、目标矩阵、陷印状态）；
//! - [`Editor::plan_mode`]：在 scratch 会话上算完整转换，返回报告 + 源像素预览，正式文档不动；
//! - [`Editor::apply_mode`]：核对 `baseRevision`/`baseContentHash` 后重算并一步提交；
//! - [`Editor::plan_color_table`] / [`Editor::apply_color_table`]：颜色表编辑的同一条路径。
//!
//! 没有长草稿状态：取消只是丢弃计划；因此不需要在共享的草稿门禁里新增分支，也不会有
//! 「保存时带着未结算预览」的窗口。参数在应用时重新校验，非法输入永远不会提交旧的候选。

use serde_json::{Value, json};

use crate::editor::*;
use crate::features::modes::mode::{self, ModePlan, ModeTarget};

fn preview_json(preview: &crate::editor::Preview) -> Value {
    json!({
        "width": preview.width,
        "height": preview.height,
        "pixelsBase64": mode::base64(&preview.pixels),
        "bytes": preview.pixels.len()
    })
}

/// 统一计划响应：报告、预览、基线快照与尺寸。
fn plan_json(plan: &ModePlan) -> Value {
    json!({
        "report": plan.report,
        "preview": preview_json(&plan.preview),
        "baseRevision": plan.base_revision,
        "baseContentHash": plan.base_hash,
        "changed": plan.changed
    })
}

fn expected<'a>(params: &'a Value, key: &str) -> Result<Option<&'a Value>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(value)),
    }
}

impl Editor {
    /// 核对客户端计划时的基线仍在：修订与内容指纹都必须一致。
    fn require_same_base(&self, params: &Value) -> Result<()> {
        let state = self.active_doc()?;
        if let Some(value) = expected(params, "baseRevision")? {
            let revision = value
                .as_u64()
                .ok_or_else(|| mode::error("image.mode", "`baseRevision` 必须是整数"))?;
            if revision != state.revision {
                return Err(mode::error("image.mode", "文档已变化，请重新预览后再确认"));
            }
        }
        if let Some(value) = expected(params, "baseContentHash")? {
            let hash = value
                .as_str()
                .ok_or_else(|| mode::error("image.mode", "`baseContentHash` 必须是字符串"))?;
            let current = self.content_hash()?;
            if hash != current {
                return Err(mode::error("image.mode", "文档内容已变化，请重新预览后再确认"));
            }
        }
        Ok(())
    }

    /// 只读模式信息：不改文档、历史或内容指纹。
    pub fn mode_info(&self) -> Result<Value> {
        self.require_no_stroke()?;
        let state = self.active_doc()?;
        let hash = self.content_hash()?;
        Ok(mode::info(&state.doc, state.revision, &hash, state.source_read_only))
    }

    /// 预览一次模式转换：正式文档、修订与历史都不变。
    pub fn plan_mode(&self, target: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let target = ModeTarget::parse(target)?;
        let state = self.active_doc()?;
        if state.source_read_only {
            return Err(mode::error(target.id(), "文档来自只读来源，不能修改模式"));
        }
        let side = params.get("maxSide").and_then(Value::as_u64).unwrap_or(256) as u32;
        let plan = mode::plan_mode(state, &self.registry, target, &params, side)?;
        Ok(plan_json(&plan))
    }

    /// 确认一次模式转换：重算候选后一步提交；无变化不新增历史。
    pub fn apply_mode(&mut self, target: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let target = ModeTarget::parse(target)?;
        if self.active_doc()?.source_read_only {
            return Err(mode::error(target.id(), "文档来自只读来源，不能修改模式"));
        }
        self.require_same_base(&params)?;
        let side = params.get("maxSide").and_then(Value::as_u64).unwrap_or(0) as u32;
        let plan = {
            let state = self.active_doc()?;
            mode::plan_mode(state, &self.registry, target, &params, side)?
        };
        if plan.changed {
            crate::preview_history::commit(&mut self.session, plan.candidate.clone(), Some(plan.active), target.label())
                .map_err(|failure| mode::error(target.id(), failure))?;
        }
        let mut out = plan_json(&plan);
        if let Some(object) = out.as_object_mut() {
            object.insert("committed".into(), json!(plan.changed));
            object.insert("state".into(), self.state()["document"].clone());
        }
        Ok(out)
    }

    /// 预览一次颜色表编辑（只在索引色模式可用）。
    pub fn plan_color_table(&self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        if state.source_read_only {
            return Err(mode::error("image.mode.colorTable", "文档来自只读来源，不能修改颜色表"));
        }
        let side = params.get("maxSide").and_then(Value::as_u64).unwrap_or(256) as u32;
        let plan = mode::plan_color_table(state, &self.registry, &params, side)?;
        Ok(plan_json(&plan))
    }

    /// 确认一次颜色表编辑：重算候选后一步提交；无变化不新增历史。
    pub fn apply_color_table(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if self.active_doc()?.source_read_only {
            return Err(mode::error("image.mode.colorTable", "文档来自只读来源，不能修改颜色表"));
        }
        self.require_same_base(&params)?;
        let side = params.get("maxSide").and_then(Value::as_u64).unwrap_or(0) as u32;
        let plan = {
            let state = self.active_doc()?;
            mode::plan_color_table(state, &self.registry, &params, side)?
        };
        if plan.changed {
            crate::preview_history::commit(&mut self.session, plan.candidate.clone(), Some(plan.active), "Color Table")
                .map_err(|failure| mode::error("image.mode.colorTable", failure))?;
        }
        let mut out = plan_json(&plan);
        if let Some(object) = out.as_object_mut() {
            object.insert("committed".into(), json!(plan.changed));
            object.insert("state".into(), self.state()["document"].clone());
        }
        Ok(out)
    }
}
