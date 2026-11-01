//! 普通卡片的右下角 resize 抓手（纯矩形）。
//!
//! 绘制（`canvas2d::cards`）与交互命中共用同一派生：抓手从卡片右下角向内缩进
//! `layout::resize_rect`，命中半径随 zoom 反比放大（`layout::hit_radius`）。

use bevy::prelude::Vec2;

use super::layout;

/// 右下角方形抓手的世界矩形。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ResizeGrip {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl ResizeGrip {
    /// 由卡片外接矩形派生（与 `layout::resize_rect` 同一内缩）。
    pub(crate) fn for_bounds(x: f32, y: f32, width: f32, height: f32) -> Self {
        let (x, y, width, height) = layout::resize_rect(x, y, width, height);
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// 点是否落在抓手上；`tolerance` 为世界单位容差（随 zoom 放大）。
    pub(crate) fn hit(&self, point: Vec2, tolerance: f32) -> bool {
        point.x >= self.x - tolerance
            && point.x <= self.x + self.width + tolerance
            && point.y >= self.y - tolerance
            && point.y <= self.y + self.height + tolerance
    }
}
