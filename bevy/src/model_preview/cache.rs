//! Cache identity uses the camera relative to the subject, never its canvas anchor.
use crate::protocol::{GraphNode, ModelReference};
use bevy::prelude::*;

pub(super) fn signature(
    node: &GraphNode,
    reference: &ModelReference,
    relative_pose: Transform,
    size: UVec2,
    projection: &Projection,
    clear: Color,
    quality: &str,
) -> String {
    let _ = node;
    format!(
        "{}:{}:{:?}:{:?}:{:?}:{:?}:{}:{}:{}",
        reference.resource_key,
        reference.signature,
        relative_pose,
        size,
        projection,
        clear,
        reference.placement.yaw,
        reference.placement.scale,
        quality
    )
}
