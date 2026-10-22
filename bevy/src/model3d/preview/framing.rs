use bevy::prelude::*;
use crate::{protocol::{GraphNode, ModelSnapshot}, renderer_protocol::CompositeAssetFrameRequest};

/// Same immutable reference geometry and card scale as the browser; no animated bounds.
pub(super) fn reference_frame(model: &ModelSnapshot, frame: Option<&CompositeAssetFrameRequest>) -> (Transform, Vec3, f32) {
    let Some(frame) = frame else {
        let (center, radius) = crate::model3d::preview_focus(model).unwrap_or((Vec3::ZERO, 1.0));
        return (Transform::default(), center, radius);
    };
    let node: GraphNode = serde_json::from_value(serde_json::json!({
        "id":"preview", "type":"composite-asset", "x":0, "y":0, "width":frame.width, "height":frame.height,
        "compositeAsset": {"x":0,"y":0,"width":frame.width,"height":frame.height,"layoutAabb":frame.layout_aabb}
    })).expect("validated preview frame");
    let mut reference = model.clone();
    reference.extent = frame.resource_extent;
    let unit = super::super::layout::model_unit(&node, &reference, &model.placement);
    let rotation = Quat::from_rotation_y(model.placement.yaw.to_radians());
    let bounds = frame.layout_aabb.as_ref().map(|bounds| crate::model3d::scene::ModelAabb::new(bounds.min, bounds.max).transformed(&Transform { rotation, scale: Vec3::splat(unit), ..default() }))
        .or_else(|| crate::model3d::scene::model_world_aabb(model, rotation, unit));
    let (center, radius) = bounds.map(|b| (b.center(), b.radius())).unwrap_or((Vec3::ZERO, 1.0));
    (Transform { rotation, scale: Vec3::splat(unit), ..default() }, center, radius)
}
