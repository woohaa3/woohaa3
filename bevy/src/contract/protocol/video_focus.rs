//! 视频聚焦瞬时投影
//! （change: 2026-10-10-add-video-node-focus-workspace，任务 1.3 / design D2）。
//!
//! 与图片聚焦共用同一二维媒体取景语义：只承载浏览器本地呈现态：聚焦 canonical 视频
//! `nodeId`、本地二维取景与源尺寸。Bevy 保持**同一** Camera2d/画布，隐藏其它内容，按此
//! 取景缩放显示视频真实解码纹理；不进入 ServerCanvas / CanvasCommand / Y.Doc。缺失即普通画布。

use super::image_focus::ImageFocusViewport;
use serde::Deserialize;

/// 视频聚焦 schema 版本；必须与 Web `VIDEO_FOCUS_VERSION` 一致，未知版本稳定拒绝整帧。
pub(crate) const VIDEO_FOCUS_VERSION: &str = "woohaa-video-focus-v1";

/// 视频聚焦瞬时投影（change: 2026-10-10-...，design D2）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoFocus {
    /// schema 版本；缺失按未知处理并在 `validate` 拒绝。
    #[serde(default)]
    pub(crate) version: String,
    /// 聚焦 canonical 视频节点 id。
    pub(crate) node_id: String,
    /// 本地二维取景（pan + zoom）。
    pub(crate) viewport: ImageFocusViewport,
    /// 源像素宽（用于缩放与校验）。
    pub(crate) source_width: f32,
    /// 源像素高。
    pub(crate) source_height: f32,
}

impl VideoFocus {
    /// 边界级防御校验：版本、id 长度、有限取景与正源尺寸。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != VIDEO_FOCUS_VERSION {
            return Err("Unknown video focus version");
        }
        if self.node_id.is_empty() || self.node_id.len() > 128 {
            return Err("Invalid video focus node id");
        }
        if ![self.viewport.x, self.viewport.y, self.viewport.zoom]
            .iter()
            .all(|value| value.is_finite())
            || self.viewport.zoom <= 0.0
        {
            return Err("Invalid video focus viewport");
        }
        if !self.source_width.is_finite()
            || !self.source_height.is_finite()
            || self.source_width <= 0.0
            || self.source_height <= 0.0
        {
            return Err("Invalid video focus source size");
        }
        Ok(())
    }
}
