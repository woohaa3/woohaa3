//! 框选选区矩形的 2D 绘制（change: fix-group-and-marquee-preview）。
//!
//! JS 控制器在框选手势进行中把当前矩形作为瞬时字段 `marquee` 下发；本模块只负责画
//! 半透明底 + 边框。矩形是世界坐标轴对齐矩形，宽高可为负（拖拽方向决定），这里归一化。
//!
//! 抽出独立模块的理由：`render.rs` 已接近文件体积上限（`tests/file_size.rs` 守卫），
//! 且选区与其它画布元素的绘制来源（scene 字段）不同。

use crate::protocol::Marquee;
use crate::theme::ThemeResource;

use super::dash::dashed_rounded_rect;
use super::geometry::Geometry;

/// 选区 z 层：2D 相机正交 near/far 为 ±1000，节点卡片在 10 附近；选区取 500——
/// 高于所有卡片与连线，又在远平面内不被裁掉。
pub(crate) const MARQUEE_Z: f32 = 500.0;

/// 选区底色 alpha：半透明，保证不遮挡内容可读性。
const MARQUEE_FILL_ALPHA: f32 = 0.08;

/// 圆角半径与边框宽度。
const MARQUEE_RADIUS: f32 = 8.0;
const MARQUEE_BORDER: f32 = 1.0;

/// 把选区矩形追加进共享几何：半透明底 + **虚线**边框。
///
/// 虚线而非实线：与 group 容器框一致地表达「临时范围」，也符合用户对框选「虚线框」的预期。
pub(crate) fn draw_marquee(geometry: &mut Geometry, theme: &ThemeResource, marquee: &Marquee) {
    // 归一化：拖拽可能朝任意方向，宽高为负时取绝对值并把左上角改为较小坐标。
    let left = marquee.x.min(marquee.x + marquee.width);
    let top = marquee.y.min(marquee.y + marquee.height);
    let width = marquee.width.abs();
    let height = marquee.height.abs();
    geometry.rounded_rect_alpha(
        left,
        top,
        width,
        height,
        MARQUEE_RADIUS,
        MARQUEE_Z,
        theme.token_u32("canvasNodeSelectedHalo"),
        MARQUEE_FILL_ALPHA,
    );
    dashed_rounded_rect(
        geometry,
        left,
        top,
        width,
        height,
        MARQUEE_RADIUS,
        MARQUEE_BORDER,
        MARQUEE_Z + 0.001,
        theme.token_u32("canvasNodeBorderSelected"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::prelude::Mesh;

    fn marquee(x: f32, y: f32, width: f32, height: f32) -> Marquee {
        Marquee {
            x,
            y,
            width,
            height,
        }
    }

    /// 用 mesh 顶点数间接验证几何非空（Geometry 内部字段私有）。
    fn positions(geometry: Geometry) -> usize {
        let mesh = geometry.build();
        mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap().len()
    }

    #[test]
    fn marquee_emits_geometry() {
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        draw_marquee(&mut geometry, &theme, &marquee(10.0, 20.0, 100.0, 50.0));
        assert!(positions(geometry) > 40);
    }

    #[test]
    fn negative_size_is_normalized() {
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        // 反向拖拽（左上角是小的那个）：不应 panic 且仍产出几何。
        draw_marquee(&mut geometry, &theme, &marquee(100.0, 80.0, -40.0, -30.0));
        assert!(positions(geometry) > 40);
    }

    #[test]
    fn marquee_z_is_between_cards_and_far_plane() {
        // 选区必须高于节点卡片（10 附近）且低于远平面 1000。
        assert!(MARQUEE_Z > 10.0 && MARQUEE_Z < 1000.0);
    }
}
