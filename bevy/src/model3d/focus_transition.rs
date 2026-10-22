//! Embed the card camera in the full canvas without changing its screen-space image.
//!
//! 卡片预览是**透视**相机（与聚焦观察镜头同一姿态、距离与 FOV），所以这里不能沿用「正交
//! 固定视口高度」的换算。做法是按**焦点所在平面**（过卡片相机的注视点、垂直视线的平面）
//! 对齐两端：
//!
//! 1. 先求焦点在卡片图像里的 NDC 与它对应的画布像素；
//! 2. 把整屏相机沿同一条视线后退到 `d · surface.height / (card_height · zoom)`，使该平面
//!    的「每 CSS 像素世界长度」与卡片相同；
//! 3. 在视平面内横移，让焦点落到同一个画布像素。
//!
//! 于是焦点平面上的像素与卡片逐像素一致，进出聚焦首帧不跳；离开该平面的几何由透视自然
//! 缩放（整屏相机只是同视线后退，平面外的视差只会按比例摊薄，不会引入新的畸变）。
#![cfg_attr(not(feature = "canvas-core"), allow(dead_code))]
use bevy::{camera::ScalingMode, prelude::*};

use crate::{
    canvas_query::layout,
    protocol::{GraphNode, Scene},
};

pub(crate) fn overview_camera(
    scene: &Scene,
    node: &GraphNode,
    pose: &Transform,
    projection: &Projection,
    pivot: Vec3,
) -> Option<(Transform, Projection)> {
    let surface = scene.surface.as_ref()?;
    let (x, y, width, card_height) = layout::content_rect(node);
    let zoom = scene.viewport.zoom;
    if surface.width <= 0.0
        || surface.height <= 0.0
        || zoom <= 0.0
        || width <= 0.0
        || card_height <= 0.0
    {
        return None;
    }
    match projection {
        Projection::Orthographic(card) => {
            let ScalingMode::Fixed { height, .. } = card.scaling_mode else {
                return None;
            };
            let units_per_pixel = height / (card_height * zoom);
            let center = Vec2::new(
                (x + width / 2.0) * zoom + scene.viewport.x,
                (y + card_height / 2.0) * zoom + scene.viewport.y,
            );
            let mut pose = *pose;
            pose.translation += pose.rotation
                * Vec3::new(
                    surface.width / 2.0 - center.x,
                    center.y - surface.height / 2.0,
                    0.0,
                )
                * units_per_pixel;
            let mut projection = card.clone();
            projection.scaling_mode = ScalingMode::Fixed {
                width: surface.width * units_per_pixel,
                height: surface.height * units_per_pixel,
            };
            let mut projection = Projection::Orthographic(projection);
            projection.update(surface.width, surface.height);
            Some((pose, projection))
        }
        Projection::Perspective(card) => {
            let fov = card.fov;
            if !fov.is_finite() || fov <= 0.0 || fov >= std::f32::consts::PI {
                return None;
            }
            let tan_half = (fov * 0.5).tan();
            let aspect = surface.width / surface.height;
            // 焦点在卡片视图空间的位置：`-z` 即卡片取景距离。
            let view = pose.rotation.inverse() * (pivot - pose.translation);
            if !view.is_finite() || view.z >= -1e-4 {
                return None;
            }
            let depth = -view.z;
            // 焦点在卡片图像上的 NDC（y 向上）。
            let ndc = Vec2::new(
                view.x / (depth * tan_half * aspect),
                view.y / (depth * tan_half),
            );
            if !ndc.is_finite() {
                return None;
            }
            // 焦点对应的画布像素：卡片 NDC → 卡片内容矩形 → 视口变换。
            let target = Vec2::new(
                (x + (ndc.x + 1.0) * width / 2.0) * zoom + scene.viewport.x,
                (y + (1.0 - ndc.y) * card_height / 2.0) * zoom + scene.viewport.y,
            );
            let target_ndc = Vec2::new(
                (target.x - surface.width / 2.0) / (surface.width / 2.0),
                (surface.height / 2.0 - target.y) / (surface.height / 2.0),
            );
            // 整屏相机后退到「焦点平面每像素世界长度与卡片一致」的距离。
            let distance = depth * surface.height / (card_height * zoom);
            if !distance.is_finite() || distance <= 0.0 {
                return None;
            }
            let lateral = Vec2::new(
                target_ndc.x * distance * tan_half * aspect,
                target_ndc.y * distance * tan_half,
            );
            let mut overview_pose = *pose;
            overview_pose.translation =
                pivot - pose.rotation * Vec3::new(lateral.x, lateral.y, -distance);
            let mut overview = card.clone();
            overview.aspect_ratio = aspect.max(f32::MIN_POSITIVE);
            let mut overview = Projection::Perspective(overview);
            overview.update(surface.width, surface.height);
            Some((overview_pose, overview))
        }
        Projection::Custom(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene_for(node_json: serde_json::Value) -> Scene {
        Scene {
            nodes: serde_json::from_value(node_json).unwrap(),
            surface: Some(crate::protocol::SurfaceSize {
                width: 1280.0,
                height: 800.0,
                pixel_ratio: 2.0,
                content_right: 0.0,
                content_rect: None,
            }),
            ..default()
        }
    }

    /// 卡片相机姿态与注视点：相机沿 -Z 看 `distance` 处的焦点。
    fn card_pose(yaw: f32, distance: f32) -> (Transform, Vec3) {
        let pose = Transform::from_translation(Vec3::new(400.0, 60.0, -300.0))
            .with_rotation(Quat::from_euler(EulerRot::YXZ, yaw, -0.4, 0.0));
        let pivot = pose.translation + pose.rotation * Vec3::new(0.0, 0.0, -distance);
        (pose, pivot)
    }

    /// 卡片像素坐标（CSS px）。
    fn card_pixel(
        card: &Projection,
        local: Vec3,
        rect: (f32, f32, f32, f32),
        pan: (f32, f32),
        zoom: f32,
    ) -> Vec2 {
        let ndc = card.get_clip_from_view().project_point3(local);
        let (x, y, width, height) = rect;
        Vec2::new(
            (x + (ndc.x + 1.0) * width / 2.0) * zoom + pan.0,
            (y + (1.0 - ndc.y) * height / 2.0) * zoom + pan.1,
        )
    }

    /// 整屏画布像素坐标（CSS px）。
    fn surface_pixel(
        overview: &Projection,
        overview_pose: &Transform,
        world: Vec3,
        surface: Vec2,
    ) -> Vec2 {
        let view = overview_pose.rotation.inverse() * (world - overview_pose.translation);
        let ndc = overview.get_clip_from_view().project_point3(view);
        Vec2::new((ndc.x + 1.0) * surface.x / 2.0, (1.0 - ndc.y) * surface.y / 2.0)
    }

    #[test]
    fn orthographic_overview_preserves_card_pixels_after_pan_zoom_and_local_orbit() {
        let mut scene = scene_for(serde_json::json!([
            { "id": "model", "type": "model", "x": 720, "y": -140,
                "width": 280, "height": 240 }
        ]));
        let node = scene.nodes[0].clone();
        let rect = layout::content_rect(&node);
        let (_, _, width, height) = rect;
        for (pan_x, pan_y, zoom) in [(0.0, 0.0, 1.0), (-540.0, 320.0, 1.75), (80.0, 230.0, 0.6)] {
            scene.viewport.x = pan_x;
            scene.viewport.y = pan_y;
            scene.viewport.zoom = zoom;
            for yaw in [0.0, 0.8, -1.4] {
                let (pose, pivot) = card_pose(yaw, 8.0);
                let mut card = Projection::Orthographic(OrthographicProjection {
                    scaling_mode: ScalingMode::Fixed {
                        width: 8.0 * width / height,
                        height: 8.0,
                    },
                    ..OrthographicProjection::default_3d()
                });
                card.update(width, height);
                let (overview_pose, overview) =
                    overview_camera(&scene, &node, &pose, &card, pivot).unwrap();
                for local in [
                    Vec3::new(0.0, 0.0, -10.0),
                    Vec3::new(1.2, -0.7, -9.0),
                    Vec3::new(-2.0, 1.0, -12.0),
                ] {
                    let world = pose.transform_point(local);
                    let expected = card_pixel(&card, local, rect, (pan_x, pan_y), zoom);
                    let actual = surface_pixel(
                        &overview,
                        &overview_pose,
                        world,
                        Vec2::new(1280.0, 800.0),
                    );
                    assert!(
                        actual.abs_diff_eq(expected, 0.002),
                        "{actual:?} != {expected:?}"
                    );
                }
            }
        }
    }

    /// 透视卡片扩到整屏后，**焦点平面**上的像素与卡片逐像素一致；离开该平面才出现透视缩放。
    #[test]
    fn perspective_overview_matches_card_pixels_on_the_focus_plane() {
        let mut scene = scene_for(serde_json::json!([
            { "id": "model", "type": "model", "x": 720, "y": -140,
                "width": 280, "height": 240 }
        ]));
        let node = scene.nodes[0].clone();
        let rect = layout::content_rect(&node);
        let (_, _, width, height) = rect;
        let surface = Vec2::new(1280.0, 800.0);
        for (pan_x, pan_y, zoom) in [(0.0, 0.0, 1.0), (-540.0, 320.0, 1.75), (80.0, 230.0, 0.6)] {
            scene.viewport.x = pan_x;
            scene.viewport.y = pan_y;
            scene.viewport.zoom = zoom;
            for yaw in [0.0, 0.8, -1.4] {
                let distance = 8.0;
                let (pose, pivot) = card_pose(yaw, distance);
                let mut card = Projection::Perspective(PerspectiveProjection {
                    fov: crate::orbit_camera::ORBIT_DEFAULT_FOV,
                    near: crate::model3d::focus::FOCUS_NEAR,
                    far: crate::orbit_camera::ORBIT_DEFAULT_FAR,
                    ..default()
                });
                card.update(width, height);
                let (overview_pose, overview) =
                    overview_camera(&scene, &node, &pose, &card, pivot).unwrap();
                assert!(
                    matches!(overview, Projection::Perspective(_)),
                    "卡片透视应保持透视，不得退回正交"
                );
                // 焦点平面上的点：卡片像素位置必须逐像素保持。
                for local in [
                    Vec3::new(0.0, 0.0, -distance),
                    Vec3::new(1.2, -0.7, -distance),
                    Vec3::new(-2.0, 1.0, -distance),
                ] {
                    let world = pose.transform_point(local);
                    let expected = card_pixel(&card, local, rect, (pan_x, pan_y), zoom);
                    let actual = surface_pixel(&overview, &overview_pose, world, surface);
                    assert!(
                        actual.abs_diff_eq(expected, 0.02),
                        "焦点平面像素漂移：{actual:?} != {expected:?}"
                    );
                }
                // 透视判据：两点横向偏移相同、只有深度不同。正交投影下它们落到的屏幕
                // 偏移完全相等（透视为近大远小，必不相等）。整屏相机为保住焦点平面像素
                // 会沿同一视线后退，变化幅度不同，但「不相等」这一点必须成立。
                let lateral = Vec3::new(1.2, -0.7, 0.0);
                let offsets = |projection: &Projection, pose: &Transform, surface: Vec2| {
                    let centre = surface_pixel(projection, pose, pivot, surface);
                    [Vec3::new(0.0, 0.0, -distance * 0.5), Vec3::new(0.0, 0.0, -distance * 1.5)]
                        .map(|depth| {
                            (surface_pixel(
                                projection,
                                pose,
                                pose.transform_point(lateral + depth),
                                surface,
                            ) - centre)
                                .length()
                        })
                };
                let card_offsets = offsets(&card, &pose, Vec2::new(width, height));
                let overview_offsets = offsets(&overview, &overview_pose, surface);
                let ortho_offsets = offsets(
                    &Projection::Orthographic(OrthographicProjection::default_3d()),
                    &pose,
                    Vec2::new(width, height),
                );
                assert!(
                    (card_offsets[0] - card_offsets[1]).abs() > 1.0,
                    "卡片必须是透视：{card_offsets:?}"
                );
                assert!(
                    (overview_offsets[0] - overview_offsets[1]).abs() > 1.0,
                    "整屏不得退化为正交：{overview_offsets:?}"
                );
                assert!(
                    (ortho_offsets[0] - ortho_offsets[1]).abs() < 0.05,
                    "正交对照下同横向偏移的两点必须重合：{ortho_offsets:?}"
                );
            }
        }
    }

    #[test]
    fn unsupported_projection_returns_none() {
        let scene = scene_for(serde_json::json!([
            { "id": "model", "type": "model", "x": 0, "y": 0, "width": 280, "height": 240 }
        ]));
        let node = scene.nodes[0].clone();
        let (pose, pivot) = card_pose(0.0, 8.0);
        let mut left = Projection::Orthographic(OrthographicProjection {
            scaling_mode: ScalingMode::AutoMin {
                min_width: 2.0,
                min_height: 2.0,
            },
            ..OrthographicProjection::default_3d()
        });
        left.update(280.0, 188.0);
        assert!(overview_camera(&scene, &node, &pose, &left, pivot).is_none());
        let bad_fov = Projection::Perspective(PerspectiveProjection { fov: 0.0, ..default() });
        assert!(overview_camera(&scene, &node, &pose, &bad_fov, pivot).is_none());
        let behind = Projection::Perspective(PerspectiveProjection::default());
        assert!(
            overview_camera(&scene, &node, &pose, &behind, pose.translation).is_none(),
            "焦点位于相机后方时不得返回退化相机"
        );
    }
}
