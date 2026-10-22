//! 图片聚焦瞬时投影（change: 2026-10-08-add-image-focus-editing-and-unified-node-history，
//! 任务 4.2/4.3 / design D2）。
//!
//! 只承载浏览器本地呈现态：聚焦 canonical 图片 `nodeId`、本地二维取景与源尺寸。Bevy 保持
//! **同一** Camera2d/画布，按此取景缩放显示原图纹理；不进入 ServerCanvas /
//! CanvasCommand / Y.Doc。缺失即普通画布。

use serde::Deserialize;

/// 图片聚焦 schema 版本；必须与 Web `IMAGE_FOCUS_VERSION` 一致，未知版本稳定拒绝整帧。
pub(crate) const IMAGE_FOCUS_VERSION: &str = "woohaa-image-focus-v1";

/// 画布局部二维取景：`zoom` 为「1 源像素 = zoom 个 CSS px」，`x`/`y` 为画布局部平移（CSS px）。
#[derive(Clone, Copy, Debug, Deserialize)]
pub(crate) struct ImageFocusViewport {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) zoom: f32,
}

/// 图片聚焦瞬时投影（change: 2026-10-08-...，design D2）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageFocus {
    /// schema 版本；缺失按未知处理并在 `validate` 拒绝。
    #[serde(default)]
    pub(crate) version: String,
    /// 聚焦 canonical 图片节点 id。
    pub(crate) node_id: String,
    /// 入场完成后才启用遮罩与节点外框隐藏；缺省兼容既有调用方。
    #[serde(default = "presentation_ready_default")]
    pub(crate) presentation_ready: bool,
    /// 本地二维取景（pan + zoom）。
    pub(crate) viewport: ImageFocusViewport,
    /// 源像素宽（用于缩放与校验）。
    pub(crate) source_width: f32,
    /// 源像素高。
    pub(crate) source_height: f32,
}

fn presentation_ready_default() -> bool { true }

impl ImageFocus {
    /// 边界级防御校验：版本、id 长度、有限取景与正源尺寸。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != IMAGE_FOCUS_VERSION {
            return Err("Unknown image focus version");
        }
        if self.node_id.is_empty() || self.node_id.len() > 128 {
            return Err("Invalid image focus node id");
        }
        if ![self.viewport.x, self.viewport.y, self.viewport.zoom]
            .iter()
            .all(|value| value.is_finite())
            || self.viewport.zoom <= 0.0
        {
            return Err("Invalid image focus viewport");
        }
        if !self.source_width.is_finite()
            || !self.source_height.is_finite()
            || self.source_width <= 0.0
            || self.source_height <= 0.0
        {
            return Err("Invalid image focus source size");
        }
        Ok(())
    }
}
