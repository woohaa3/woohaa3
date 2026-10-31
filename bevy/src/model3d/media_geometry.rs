//! Shared media plane geometry for rendering, picking and drag coordinates.
//!
//! change: 2026-10-11-extract-film-set-extension D4/D7 —— 媒体平面与模型/地面共用**同一条根链**
//! `world = anchor + R_root × (unit × content_local)`。Web 映射层只下发内容局部几何
//! （`x`/`y`/`z`/`width`/`height`/`yaw`），本模块按节点模型资源派生的根 transform 放置平面；
//! 不再另走 `canvas_point_to_world(center + x, center + z, y)` 的画布中心嵌入，避免共同根
//! 平移/旋转/缩放改变模型与媒体的相对位置。
use crate::protocol::{GraphNode, ModelMediaPlane, ModelSnapshot};
use bevy::prelude::*;

/// 片场媒体平面的画布高度（画布单位），与 Web `FILM_SET_MEDIA_PLANE_HEIGHT` 同值。
pub(crate) const MEDIA_PLANE_CANVAS_HEIGHT: f32 = 48.0;

/// Match the scene-unit plane size used by the recording compiler.
///
/// 高度在**内容单位**里表达，再乘共同根 `unit` 得到画布尺寸。绝对米制下要让平面恒为
/// 48 画布单位，内容高度就是 `48 / CANVAS_UNITS_PER_METER`（change:
/// 2026-10-31-render-models-at-absolute-metric-scale），不再随场景 `extent` 变化。
pub(super) fn group_media_plane(
    owner: &str,
    binding: &crate::protocol::FilmSetGroupBinding,
    _model: Option<&ModelSnapshot>,
) -> ModelMediaPlane {
    let height = MEDIA_PLANE_CANVAS_HEIGHT / crate::model3d::CANVAS_UNITS_PER_METER;
    ModelMediaPlane {
        item_id: binding.binding_id.clone(),
        unit: 1.0,
        id: format!("{}::{}", owner, binding.binding_id),
        kind: binding.kind.clone(),
        x: 0.0,
        y: height / 2.0,
        z: 0.0,
        width: height * binding.aspect_ratio,
        height,
        yaw: 0.0,
        has_texture: true,
    }
}

/// 媒体平面按内容局部几何 + 共同根 transform 得到的世界 transform。
///
/// 平面竖直站立（Plane3d 默认法线 +Y，绕 X 轴 +90° 使其竖直），再绕世界 Y 轴 `yaw`；尺寸先乘
/// item 局部 scale（已在 Web 折算为内容单位），再乘共同根 `unit`。
pub(crate) fn plane_transform(plane: &ModelMediaPlane, root: &Transform) -> Transform {
    let world = root.transform_point(Vec3::new(plane.x, plane.y, plane.z));
    Transform {
        translation: world,
        rotation: root.rotation
            * Quat::from_rotation_y(plane.yaw)
            * Quat::from_rotation_x(std::f32::consts::FRAC_PI_2),
        scale: Vec3::new(plane.width, 1.0, plane.height) * root.scale,
    }
}

/// 节点片场组合的共同根 transform（模型/地面/媒体共用）。
///
/// 缺失模型资源时回退单位根（媒体仍可静态呈现，但不再有 fit/unit 语义）。
pub(crate) fn film_set_root(node: &GraphNode, model: Option<&ModelSnapshot>) -> Transform {
    match model {
        Some(model) => {
            let placement = node
                .model
                .as_ref()
                .map(|reference| reference.placement.clone())
                .unwrap_or_default();
            super::layout::film_set_root_transform(node, model, &placement)
        }
        None => {
            // A media-only node still has a canvas anchor, saved root and layout bounds.
            let fallback = ModelSnapshot {
                extent: node
                    .composite_asset
                    .as_ref()
                    .and_then(|scope| scope.content_extent)
                    .unwrap_or(2.0)
                    .max(0.001),
                ..Default::default()
            };
            let placement = node
                .model
                .as_ref()
                .map(|reference| reference.placement.clone())
                .or_else(|| {
                    node.composite_asset
                        .as_ref()
                        .and_then(|scope| scope.root_placement.clone())
                })
                .unwrap_or_default();
            super::layout::film_set_root_transform(node, &fallback, &placement)
        }
    }
}

/// 媒体平面候选世界 AABB（对象 picking / bounds 用）。
pub(crate) fn item_candidate(
    node: &GraphNode,
    model: Option<&ModelSnapshot>,
    plane: &ModelMediaPlane,
) -> crate::canvas_query::film_set_pick::FilmSetItemCandidate {
    let root = film_set_root(node, model);
    let transform = plane_transform(plane, &root);
    let corners: Vec<_> = [-0.5, 0.5]
        .into_iter()
        .flat_map(|x| {
            [-0.5, 0.5]
                .into_iter()
                .map(move |z| transform.transform_point(bevy::math::Vec3::new(x, 0.0, z)))
        })
        .collect();
    let min = corners
        .iter()
        .fold(bevy::math::Vec3::splat(f32::INFINITY), |a, b| a.min(*b));
    let max = corners
        .iter()
        .fold(bevy::math::Vec3::splat(f32::NEG_INFINITY), |a, b| a.max(*b));
    // 内容局部轴 → 世界：`R_root × unit`（与 `plane_transform` 的 content→world 完全同链，
    // 不做坐标置换，供媒体拖动逆变换使用）。
    let unit = if root.scale.x.is_finite() && root.scale.x > 0.0 {
        root.scale.x
    } else {
        1.0
    };
    let basis = bevy::math::Mat3::from_cols(
        root.rotation * bevy::math::Vec3::new(unit, 0.0, 0.0),
        root.rotation * bevy::math::Vec3::new(0.0, unit, 0.0),
        root.rotation * bevy::math::Vec3::new(0.0, 0.0, unit),
    );
    crate::canvas_query::film_set_pick::FilmSetItemCandidate {
        node_id: node.id.clone(),
        item_id: if plane.item_id.is_empty() {
            plane
                .id
                .strip_prefix(&format!("{}::", node.id))
                .unwrap_or(&plane.id)
                .to_owned()
        } else {
            plane.item_id.clone()
        },
        min: min.to_array(),
        max: max.to_array(),
        unit,
        yaw: root.rotation.to_euler(bevy::math::EulerRot::YXZ).0,
        world_to_local: Some(basis.inverse().to_cols_array()),
        plane_inverse: Some(transform.compute_affine().inverse()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 单位根下尺寸/高度跟随内容局部量；共同根缩放/平移各应用一次。
    #[test]
    fn dimensions_follow_content_local_geometry_and_root_scale() {
        let mut plane: ModelMediaPlane = serde_json::from_str(r#"{"id":"film::photo","kind":"image","x":3,"y":26,"z":4,"width":64,"height":48,"yaw":0.3}"#).unwrap();
        let root = Transform::IDENTITY;
        let first = plane_transform(&plane, &root);
        assert!((first.translation - Vec3::new(3.0, 26.0, 4.0)).length() < 1e-4);
        assert!(
            ((first.transform_point(Vec3::new(0.5, 0.0, 0.0)) - first.translation).length() - 32.0)
                .abs()
                < 1e-4
        );
        plane.width *= 2.0;
        plane.height *= 2.0;
        plane.y += 24.0;
        let second = plane_transform(&plane, &root);
        assert!(
            ((second.transform_point(Vec3::new(0.5, 0.0, 0.0)) - second.translation).length()
                - 64.0)
                .abs()
                < 1e-4
        );
        assert!(
            (second.translation - first.translation).abs_diff_eq(Vec3::new(0.0, 24.0, 0.0), 1e-4)
        );

        // 共同根等比缩放作用于位置与尺寸各一次。
        let scaled_root = Transform {
            translation: Vec3::new(10.0, 20.0, 30.0),
            rotation: Quat::IDENTITY,
            scale: Vec3::splat(2.0),
        };
        let scaled = plane_transform(&plane, &scaled_root);
        assert!(
            (scaled.translation
                - (Vec3::new(10.0, 20.0, 30.0) + Vec3::new(plane.x, plane.y, plane.z) * 2.0))
                .length()
                < 1e-4
        );
        assert!(
            ((scaled.transform_point(Vec3::new(0.5, 0.0, 0.0)) - scaled.translation).length()
                - plane.width * 2.0 * 0.5)
                .abs()
                < 1e-4
        );
    }
}

#[cfg(test)]
mod candidate_tests {
    use super::*;
    use crate::protocol;
    use bevy::math::{Mat3, Vec3};

    /// 媒体候选的逆变换与共同根同链：世界 delta → 内容局部 offset。
    #[test]
    fn media_only_film_set_has_bounds_and_inverse_placement_basis() {
        let node: protocol::GraphNode = serde_json::from_str(r#"{"id":"film","type":"model","x":200,"y":120,"width":260,"height":195,"compositeAsset":{"x":200,"y":120,"width":260,"height":195,"media":[{"id":"film::photo","itemId":"photo","unit":2,"kind":"image","x":6,"y":56,"z":10,"width":128,"height":96,"yaw":0.2}]}}"#).unwrap();
        let items = vec![item_candidate(
            &node,
            None,
            &node.composite_asset.as_ref().unwrap().media[0],
        )];
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "photo");
        assert!(items[0].plane_inverse.is_some());
        let inverse = Mat3::from_cols_array(&items[0].world_to_local.unwrap());
        // 无模型资源也使用适配后的共同根，逆变换必须恢复内容局部 delta。
        let root = film_set_root(&node, None);
        let delta = Vec3::new(6.0, 56.0, 10.0);
        let local = inverse * (root.rotation * (root.scale * delta));
        assert!(local.abs_diff_eq(Vec3::new(6.0, 56.0, 10.0), 1e-4));
    }
}
