//! P5/P6/P7：调色、直方图、选区、修饰、滤镜、构图、文字与矢量的统一入口
//! （change: 2026-10-22-complete-photocraft-webui-editing）。
//!
//! 每个入口都遵守同一套事务规则（design D3）：
//! 草稿预览不推进修订／指纹／历史；确认只提交一次；无变化不增历史；失败保留现场。
use crate::composition::ComposeDraft;
use serde_json::{Value, json};

use crate::editor::*;
use super::command_error;


impl Editor {
    pub fn begin_compose(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let draft = ComposeDraft::begin(&self.session, id, params)?;
        let size = draft.size();
        self.compose_draft = Some(draft);
        Ok(json!({ "command": id, "width": size.0, "height": size.1 }))
    }

    pub fn update_compose(&mut self, params: Value) -> Result<Value> {
        let draft = self
            .compose_draft
            .as_mut()
            .ok_or_else(|| command_error("image.compose", "没有活动构图草稿"))?;
        draft.update(params)?;
        let size = draft.size();
        Ok(json!({ "width": size.0, "height": size.1 }))
    }

    pub fn commit_compose(&mut self) -> Result<Value> {
        let draft = self
            .compose_draft
            .take()
            .ok_or_else(|| command_error("image.compose", "没有活动构图草稿"))?;
        // 无变化不增历史：与调整/属性/文字草稿同一判据（内容指纹），例如对整幅画布再裁剪一次。
        let hash = crate::document_content::document_content_hash(&draft.document, &self.registry)
            .ok_or_else(|| command_error("image.compose", "构图草稿无法计算内容指纹"))?;
        if hash != self.content_hash()? {
            draft.commit(&mut self.session)?;
        }
        draft.outcome()
    }

    pub fn cancel_compose(&mut self) -> Value {
        self.compose_draft = None;
        json!({ "cancelled": true })
    }

    /// 执行一个构图工作流（U50–U56）。
    ///
    /// 参数先由 [`crate::composition_workflows::prepare`] 编译成上游命令与规范化参数，再走
    /// [`Editor::execute`] 的唯一命令门：未开放的命令既不会被静默替换，也不会绕过能力协商。
    pub fn run_workflow(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        match crate::composition_workflows::prepare(&self.session, id, params)? {
            crate::composition_workflows::Prepared::Unchanged(result) => Ok(result),
            crate::composition_workflows::Prepared::Command(command, compiled) => self.execute(command, compiled),
        }
    }

    /// 构图工作流清单（含可用性与具体原因），供界面决定是否渲染入口。
    pub fn workflow_manifest(&self) -> Value {
        crate::composition_workflows::manifest()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::Editor;

    fn editor() -> Editor {
        let mut editor = Editor::new();
        editor.execute("file.new", json!({"width": 20, "height": 20})).unwrap();
        editor
    }

    #[test]
    fn committing_an_unchanged_compose_adds_no_history_step() {
        let mut editor = editor();
        let before = editor.state();
        // 对整幅画布再裁剪一次：候选与原文一致，确认不应留下历史步骤。
        editor.begin_compose("image.crop", json!({"x":0,"y":0,"width":20,"height":20})).unwrap();
        let outcome = editor.commit_compose().unwrap();
        assert_eq!(outcome["width"], 20);
        assert_eq!(editor.state()["document"]["history"], before["document"]["history"]);
        assert_eq!(editor.state()["document"]["revision"], before["document"]["revision"]);
    }

    #[test]
    fn committing_a_real_compose_adds_exactly_one_named_step() {
        let mut editor = editor();
        let before = editor.state()["document"]["history"].as_array().unwrap().len();
        editor.begin_compose("image.crop", json!({"x":2,"y":2,"width":10,"height":8})).unwrap();
        editor.commit_compose().unwrap();
        let state = editor.state();
        let history = state["document"]["history"].as_array().unwrap();
        assert_eq!(history.len(), before + 1);
        assert_eq!(history.last().unwrap(), "裁剪");
        // 一步撤销回到原尺寸。
        editor.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(editor.state()["document"]["width"], 20);
        assert_eq!(editor.state()["document"]["height"], 20);
    }

    /// 相对画布走完整条链路：`run_workflow` 编译出的增量必须**只**由上游加一次。
    ///
    /// 这条曾经是真实缺陷：编译器把增量先加到文档尺寸上，上游又加一遍，`+10/+10` 得到
    /// 90×70 而不是 50×40。单测 `canvas_size` 只查编译结果，抓不到「上游也加一次」。
    #[test]
    fn relative_canvas_extension_adds_the_delta_exactly_once() {
        let mut editor = editor();
        let outcome = editor
            .run_workflow("canvasSize", json!({"width":10,"height":10,"relative":true,"anchor":"center"}))
            .unwrap();
        assert_eq!((outcome["width"].as_u64(), outcome["height"].as_u64()), (Some(30), Some(30)));
        assert_eq!(editor.state()["document"]["width"], 30);
        assert_eq!(editor.state()["document"]["height"], 30);
        // 收缩同样只应用一次；增量可为负。
        editor
            .run_workflow("canvasSize", json!({"width":-10,"height":-5,"relative":true,"anchor":"topLeft"}))
            .unwrap();
        assert_eq!(editor.state()["document"]["width"], 20);
        assert_eq!(editor.state()["document"]["height"], 25);
        // 收缩到 1 像素以下必须拒绝，且不改文档。
        let before = editor.state()["document"]["width"].clone();
        assert!(editor
            .run_workflow("canvasSize", json!({"width":-100,"height":0,"relative":true}))
            .is_err());
        assert_eq!(editor.state()["document"]["width"], before);
    }

    #[test]
    fn workflow_manifest_exposes_only_whitelisted_commands() {
        let mut editor = editor();
        let manifest = editor.workflow_manifest();
        let entries = manifest.as_array().unwrap();
        let allowed: Vec<&str> = entries
            .iter()
            .filter(|entry| entry["allowed"] == true)
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        // U50–U56 的 36 个内核命令入口全部开放；剩下 5 个是宿主交付入口（无内核命令），永远不可执行。
        assert_eq!(allowed.len(), 36, "{allowed:?}");
        for id in [
            "crop", "perspectiveCrop", "imageSize", "canvasSize", "trim", "revealAll", "rotateArbitrary",
            "transformAgain", "transformAgainCopy", "warp", "warpGrid", "splitWarpCrosswise",
            "splitWarpHorizontally", "splitWarpVertically", "removeWarpSplit", "perspectiveWarp",
            "puppetWarp", "fill", "contentAwareFill", "contentAwareScale", "stroke", "fade",
            "autoAlign", "autoBlend", "photomerge", "mergeToHdr", "cropAndStraighten",
            "newArtboard", "artboardFromLayers", "setArtboard", "newFrame", "frameFromLayers",
            "newSlice", "slicesFromGuides", "layerSlice", "listSlices",
        ] {
            assert!(allowed.contains(&id), "{id} 应已开放；实际 {allowed:?}");
        }
        // 宿主交付入口保持关闭，并给出固定原因。
        for entry in entries.iter().filter(|entry| entry["allowed"] == false) {
            assert!(entry["command"].is_null(), "{} 不该有内核命令", entry["id"]);
            assert!(entry["reason"].as_str().is_some_and(|reason| !reason.is_empty()), "{}", entry["id"]);
        }
        assert_eq!(entries.iter().filter(|entry| entry["allowed"] == false).count(), 5);
        // 已开放的入口可以真正执行业务命令（前置条件不满足时是命令错误，不是能力拒绝）。
        assert!(editor.run_workflow("crop", json!({"x":0,"y":0,"width":10,"height":10})).is_ok());
        assert!(editor.run_workflow("revealAll", json!({})).is_ok());
        // U50 透视裁剪：命令真的执行并改变文档，而不是只「不再被能力门拒绝」。
        assert_eq!(editor.state()["document"]["width"].as_u64(), Some(10));
        let result = editor
            .run_workflow("perspectiveCrop", json!({"corners":[[0,0],[6,0],[6,4],[0,4]]}))
            .unwrap();
        assert_eq!(result["width"].as_u64(), Some(6));
        assert_eq!(result["height"].as_u64(), Some(4));
        assert_eq!(editor.state()["document"]["width"].as_u64(), Some(6));
        assert_eq!(editor.state()["document"]["height"].as_u64(), Some(4));
        // U52 任意角度旋转：同样真的执行（6×4 顺时针 90° → 4×6）。
        editor
            .run_workflow("rotateArbitrary", json!({"angle":90,"direction":"cw"}))
            .unwrap();
        assert_eq!(editor.state()["document"]["width"].as_u64(), Some(4));
        assert_eq!(editor.state()["document"]["height"].as_u64(), Some(6));
    }
}
