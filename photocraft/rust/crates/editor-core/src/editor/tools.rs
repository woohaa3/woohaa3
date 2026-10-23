//! P5/P6/P7：调色、直方图、选区、修饰、滤镜、构图、文字与矢量的统一入口
//! （change: 2026-10-22-complete-photocraft-webui-editing）。
//!
//! 每个入口都遵守同一套事务规则（design D3）：
//! 草稿预览不推进修订／指纹／历史；确认只提交一次；无变化不增历史；失败保留现场。
use crate::document_content;

use super::*;

impl Editor {

    /// 内容指纹（测试与 UI 用来确认「只读操作没有改内容」）。
    pub fn content_fingerprint(&self) -> Option<String> {
        self.active_doc()
            .ok()
            .and_then(|state| document_content::document_content_hash(&state.doc, &self.registry))
    }
}

/// 图层种类 id：与 `packages/editor` 视图模型的 `kind` 一一对应。
pub(super) fn canonical_kind(content: &photocraft_doc::LayerContent) -> &'static str {
    use photocraft_doc::LayerContent;
    match content {
        LayerContent::Raster(_) => "raster",
        LayerContent::Group(_) => "group",
        LayerContent::Adjustment(_) => "adjustment",
        LayerContent::Fill(_) => "fill",
        LayerContent::Text(_) => "text",
        LayerContent::Shape(_) => "shape",
        LayerContent::Smart(_) => "smart",
    }
}

pub(super) fn command_error(id: impl std::fmt::Display, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.to_string(), message: message.to_string() }
}

#[path = "../features/files/tools.rs"]
mod files_feature;

#[path = "../features/io/tools.rs"]
mod io_feature;

#[path = "../features/vectors/tools.rs"]
mod vectors_feature;

#[path = "../features/selections/tools.rs"]
mod selections_feature;

#[path = "../features/channels/tools.rs"]
mod channels_feature;

#[path = "../features/painting/tools.rs"]
mod painting_feature;

#[path = "../features/retouch/tools.rs"]
mod retouch_feature;

#[path = "../features/adjustments/tools.rs"]
mod adjustments_feature;

#[path = "../features/modes/tools.rs"]
mod modes_feature;

#[path = "../features/filters/tools.rs"]
mod filters_feature;

#[path = "../features/composition/tools.rs"]
mod composition_feature;

#[path = "../features/layers/tools.rs"]
mod layers_feature;

#[path = "../features/smart/tools.rs"]
mod smart_feature;

#[path = "../features/type/tools.rs"]
mod type_feature;

#[path = "../features/views/tools.rs"]
mod views_feature;

#[path = "../features/customization/tools.rs"]
mod customization_feature;

#[path = "../features/history/tools.rs"]
mod history_feature;

#[path = "../features/animation/tools.rs"]
mod animation_feature;
