//! P5/P6/P7：调色、直方图、选区、修饰、滤镜、构图、文字与矢量的统一入口
//! （change: 2026-10-22-complete-photocraft-webui-editing）。
//!
//! 每个入口都遵守同一套事务规则（design D3）：
//! 草稿预览不推进修订／指纹／历史；确认只提交一次；无变化不增历史；失败保留现场。
use serde_json::{Value, json};

use crate::editor::*;
use super::command_error;


impl Editor {
    /// 文字排版：校验后走 `type.setStyle`（需要活动文字草稿或已选文字层）。
    pub fn apply_typography(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        // `layer` 是目标选择，不是排版参数本身：先取出再校验其余键。
        let mut patch_params = params.clone();
        let layer = patch_params
            .as_object_mut()
            .and_then(|object| object.remove("layer"))
            .and_then(|value| value.as_u64());
        let patch = crate::composition::typography_patch(&patch_params)?;
        // `kernPair` 只由上游 `type.edit` 消费（按住 Alt 方向键的语义：把光标前那一对字符
        // 变成手工字距）。`type.setStyle` 会静默忽略它，所以必须分开投递，否则界面会
        // 「成功」但文档没变。
        let mut edit = patch
            .as_object()
            .and_then(|object| object.get("edit"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut command = patch.clone();
        if let Some(object) = command.as_object_mut() {
            object.remove("edit");
        }
        // 排版只作用于文字层：非文字目标在提交前明确拒绝，而不是让内核报通用错误。
        let target = layer.or_else(|| self.active_doc().ok().and_then(|state| state.active_layer.map(|id| id.0)));
        if let Some(target) = target {
            let state = self.active_doc()?;
            if !matches!(
                state.doc.layer(photocraft_doc::LayerId(target)).map(|layer| &layer.content),
                Some(photocraft_doc::LayerContent::Text(_))
            ) {
                return Err(command_error("type.setStyle", "请选择文字层后再应用排版参数"));
            }
            // 这条入口同样写文字内容，必须与 `typeCommand` 用同一套锁定语义：上游
            // `type.setStyle` 不看 `effective_locks`，漏这一步会让面板在「全部锁定」的
            // 文字层上依然改得动行距/字距（规格明确要求拒绝）。
            if state.doc.effective_locks(photocraft_doc::LayerId(target)).all {
                return Err(command_error("type.setStyle", "文字图层已全部锁定，请先解锁再修改文字"));
            }
            if !command.as_object().is_some_and(|object| object.is_empty()) {
                command["layer"] = json!(target);
            }
            // 只有真的存在 `type.edit` 参数时才补目标：否则空补丁也会让上游提交一步历史，
            // 使一次「应用排版」变成两步，撤销一次回不到原状。
            if !edit.is_empty() {
                edit.insert("layer".into(), json!(target));
            }
        }
        // 先提交 `type.setStyle`（行距/字距/段落等），再提交 `type.edit`（手工字偶距）。
        // 两步各自一步历史，避免把不同上游命令揉成一次不可解释的写入。
        let mut result = Value::Null;
        if command.as_object().is_some_and(|object| !object.is_empty()) {
            result = self
                .session
                .execute("type.setStyle", command)
                .map_err(|failure| command_error("type.setStyle", failure))?;
        }
        if !edit.is_empty() {
            let edited = self
                .session
                .execute("type.edit", Value::Object(edit))
                .map_err(|failure| command_error("type.edit", failure))?;
            // `type.edit` 的返回值是文字投影；有它时以它为准（包含更新后的 runs）。
            if !edited.is_null() {
                result = edited;
            }
        }
        if result.is_null() {
            return Err(command_error("type.setStyle", "排版参数没有可提交的内容"));
        }
        Ok(result)
    }

    /// 进入文字草稿前校验字体是否真实可用（缺字体明确报告，不伪造）。
    pub fn check_font(&self, font: &str) -> Result<Value> {
        let available = crate::BUNDLED_FONTS.iter().any(|path| {
            let stem = path.rsplit('/').next().unwrap_or(path);
            font.eq_ignore_ascii_case("Inter") && stem.starts_with("Inter")
                || font.eq_ignore_ascii_case("Noto Sans SC") && stem.starts_with("NotoSansSC")
        });
        Ok(json!({ "font": font, "available": available,
            "fallback": if available { Value::Null } else { json!("Noto Sans SC") } }))
    }
}
