//! 普通卡片的四角 resize 抓手（纯矩形命中区域）。
//!
//! 绘制（`canvas2d::cards`）与交互命中共用同一派生，命中半径随 zoom 反比放大。

use bevy::prelude::Vec2;

use super::layout;

/// 右下角方形抓手的世界矩形。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ResizeGrip {
    pub(crate) handle: &'static str,
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl ResizeGrip {
    /// 由卡片外接矩形派生四个角的命中区域。
    pub(crate) fn all_for_bounds(x: f32, y: f32, width: f32, height: f32) -> [Self; 4] {
        let rects = layout::resize_corner_rects(x, y, width, height);
        [
            Self {
                handle: "nw", x: rects[0].0, y: rects[0].1,
                width: rects[0].2, height: rects[0].3,
            },
            Self {
                handle: "ne", x: rects[1].0, y: rects[1].1,
                width: rects[1].2, height: rects[1].3,
            },
            Self {
                handle: "sw", x: rects[2].0, y: rects[2].1,
                width: rects[2].2, height: rects[2].3,
            },
            Self {
                handle: "se", x: rects[3].0, y: rects[3].1,
                width: rects[3].2, height: rects[3].3,
            },
        ]
    }

    /// 右下角兼容入口，供旧几何测试使用。
    pub(crate) fn for_bounds(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self::all_for_bounds(x, y, width, height)[3]
    }

    /// 点是否落在抓手上；`tolerance` 为世界单位容差（随 zoom 放大）。
    pub(crate) fn hit(&self, point: Vec2, tolerance: f32) -> bool {
        point.x >= self.x - tolerance
            && point.x <= self.x + self.width + tolerance
            && point.y >= self.y - tolerance
            && point.y <= self.y + self.height + tolerance
    }
}
