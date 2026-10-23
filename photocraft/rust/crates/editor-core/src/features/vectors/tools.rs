//! P5/P6/P7：调色、直方图、选区、修饰、滤镜、构图、文字与矢量的统一入口
//! （change: 2026-10-22-complete-photocraft-webui-editing，矢量部分由
//! 2026-10-22-add-photocraft-vector-canvas-tools 扩展 U08–U16）。
//!
//! 每个入口都遵守同一套事务规则（design D3）：
//! 草稿预览不推进修订／指纹／历史；确认只提交一次；无变化不增历史；失败保留现场。
//!
//! 矢量入口按**命令族**分派，而不是按前缀猜：`shape.presets.*` 与 `shape.*` 前缀相同但语义不同，
//! 因此先匹配更具体的族，再落到形状/蒙版/路径，最后才是直通内核的兜底。
use serde_json::Value;

use crate::editor::*;
use super::command_error;

impl Editor {
    /// 矢量命令统一入口（形状、路径、布尔运算、矢量蒙版、预设、路径转选区）。
    pub fn vector_command(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        if !crate::composition::VECTOR_COMMANDS.contains(&id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        // 预设族必须先于 `shape.` 前缀判断，否则会被形状入口拒绝。
        if crate::composition::PRESET_COMMANDS.contains(&id) {
            return crate::composition::shape_presets(&mut self.session, id, params);
        }
        if crate::composition::COMBINE_COMMANDS.contains(&id) {
            return crate::composition::combine_shapes(&mut self.session, id, params);
        }
        if crate::composition::PATH_EDIT_COMMANDS.contains(&id) {
            crate::features::vectors::path_edit::validate(id, &params).map_err(|failure| {
                command_error(id, failure.message())
            })?;
            return self
                .session
                .execute(id, params)
                .map_err(|failure| command_error("path.edit", failure));
        }
        match id {
            "edit.defineCustomShape" => crate::composition::define_custom_shape(&mut self.session, params),
            "path.toSelection" => crate::composition::path_to_selection(&mut self.session, params),
            value if value.starts_with("layer.vectorMask.") => {
                crate::composition::vector_mask(&mut self.session, id, params)
            }
            value if value.starts_with("shape.") => crate::composition::shape(&mut self.session, id, params),
            _ => self
                .session
                .execute(id, params)
                .map_err(|failure| command_error("vector.path", failure)),
        }
    }

    /// 矢量与参考线快照（叠加层只消费这份数据）。
    pub fn vector_snapshot(&self) -> Result<Value> {
        Ok(crate::composition::vector_snapshot(&self.active_doc()?.doc))
    }

    /// 形状预设库快照：库是工具状态，单独读取，不混进文档快照。
    pub fn vector_presets(&self) -> Value {
        crate::features::vectors::presets::snapshot(&self.session)
    }

    /// 画布拖绘参数 → `shape.create` 参数（拖绘预览与数值创建共用同一份几何）。
    ///
    /// 只做纯计算：不写文档、不推进历史；零面积或越界直接返回错误，调用方据此取消。
    pub fn vector_draw_params(&self, input: &Value) -> Result<Value> {
        let canvas = self
            .active_doc()
            .map(|state| [state.doc.size.width, state.doc.size.height])
            .unwrap_or([1, 1]);
        crate::features::vectors::gestures::parse_draw_input(input)
            .and_then(|input| crate::features::vectors::gestures::shape_create_params(&input, canvas))
    }
}
