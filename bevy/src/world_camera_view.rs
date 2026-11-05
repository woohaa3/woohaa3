//! Shared camera/instance math for the live preview and immutable final capture.
use bevy::prelude::*;
use crate::protocol::{WorldCamera, WorldCameraProjection, WorldInstance, world_to_renderer, world_rotation_to_renderer, UNITS_PER_METER};

pub(crate) fn pose(camera: &WorldCamera) -> Transform {
    let p = world_to_renderer([camera.position.u, camera.position.v, camera.position.h]);
    Transform::from_translation(Vec3::from_array(p.map(|n| n as f32)))
        .with_rotation(Quat::from_array(world_rotation_to_renderer(camera.rotation).map(|n| n as f32)))
}

pub(crate) fn projection(camera: &WorldCamera, size: UVec2) -> Projection {
    let near = (camera.projection.near() * UNITS_PER_METER) as f32;
    let far = (camera.projection.far() * UNITS_PER_METER) as f32;
    match camera.projection {
        WorldCameraProjection::Perspective { vertical_fov_radians, .. } => Projection::Perspective(PerspectiveProjection {
            fov: vertical_fov_radians as f32, near, far, ..default()
        }),
        WorldCameraProjection::Isometric { vertical_size_meters, .. } => Projection::Orthographic(OrthographicProjection {
            scale: (vertical_size_meters * UNITS_PER_METER) as f32 / size.y.max(1) as f32,
            near, far, ..OrthographicProjection::default_3d()
        }),
    }
}

pub(crate) fn instance_pose(instance: &WorldInstance) -> Transform {
    let t = &instance.transform;
    let p = world_to_renderer([t.position.u, t.position.v, t.position.h]);
    Transform {
        translation: Vec3::from_array(p.map(|n| n as f32)),
        rotation: Quat::from_array(world_rotation_to_renderer(t.rotation).map(|n| n as f32)),
        scale: Vec3::splat((t.scale * UNITS_PER_METER) as f32),
    }
}
