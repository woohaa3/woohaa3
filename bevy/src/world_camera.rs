//! Shared-world camera presence: a pickable body and a bounded frustum in the 3D world.
//!
//! A `world-camera` node keeps its 2D card, but the card alone cannot express where the
//! camera stands or what it sees. This module draws the real pose from the accepted
//! `worldCamera` payload and derives the same small body bounds used by ray picking.
//!
//! The drawn frustum is deliberately bounded to a short display depth: the canonical
//! far plane may be hundreds of meters away and would otherwise cover the whole canvas.
//! Capture/framing still uses the canonical near/far values; this is presence only.

use std::collections::HashMap;
use std::fmt::Write as _;

use bevy::{camera::visibility::RenderLayers, prelude::*};

use crate::protocol::{
    world_rotation_to_renderer, world_to_renderer, Scene, WorldCamera, WorldCameraProjection,
};
use crate::theme::ThemeResource;

/// Maximum frustum depth drawn in the canvas overview, in meters.
pub(crate) const FRUSTUM_DISPLAY_DEPTH_METERS: f64 = 3.0;
/// Isometric framing is shown as a compact glyph, not a full-size 8 m box.
const ISOMETRIC_GIZMO_FRAME_SCALE: f32 = 0.28;
/// Perspective frames are also compressed; this is a camera glyph, not a live frame.
const PERSPECTIVE_GIZMO_FRAME_SCALE: f32 = 0.55;
/// Camera body half extent used by both drawing and picking, in renderer units.
pub(crate) const CAMERA_BODY_HALF_EXTENT: f32 = 18.0;
/// Overlay layer reserved for editor-only camera/scene-area gizmos. The main canvas
/// camera includes it; the world-camera preview camera deliberately does not.
pub(crate) use crate::preview_layers::WORLD_CAMERA_GIZMO_LAYER;

#[derive(Component)]
pub(crate) struct WorldCameraMarker;

#[derive(Resource, Default)]
pub(crate) struct WorldCameraPresence {
    key: Option<String>,
    entities: Vec<Entity>,
    assets: CameraAssets,
}

#[derive(Default)]
struct CameraAssets {
    cube: Option<Handle<Mesh>>,
    materials: HashMap<u32, Handle<StandardMaterial>>,
}

impl CameraAssets {
    fn cube(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.cube
            .get_or_insert_with(|| meshes.add(Cuboid::new(1.0, 1.0, 1.0)))
            .clone()
    }

    fn material(
        &mut self,
        materials: &mut Assets<StandardMaterial>,
        color: u32,
    ) -> Handle<StandardMaterial> {
        self.materials
            .entry(color)
            .or_insert_with(|| {
                materials.add(StandardMaterial {
                    base_color: Color::srgba_u8(
                        (color >> 16) as u8,
                        (color >> 8) as u8,
                        color as u8,
                        180,
                    ),
                    unlit: true,
                    alpha_mode: AlphaMode::Blend,
                    ..default()
                })
            })
            .clone()
    }
}

/// Renderer-space camera glyph/pick geometry.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CameraFrustum {
    pub(crate) position: Vec3,
    pub(crate) rotation: Quat,
    pub(crate) forward: Vec3,
    pub(crate) right: Vec3,
    pub(crate) up: Vec3,
    pub(crate) display_far: f32,
    pub(crate) far_half: Vec2,
}

impl CameraFrustum {
    pub(crate) fn far_corners(self) -> [Vec3; 4] {
        let center = self.position + self.forward * self.display_far;
        let half = if self.far_half.is_finite() && self.far_half.x > 0.0 && self.far_half.y > 0.0 {
            self.far_half
        } else {
            Vec2::splat(1.0)
        };
        [
            center - self.right * half.x - self.up * half.y,
            center + self.right * half.x - self.up * half.y,
            center + self.right * half.x + self.up * half.y,
            center - self.right * half.x + self.up * half.y,
        ]
    }
}

/// Derive renderer-space camera geometry from a validated camera payload.
pub(crate) fn frustum(camera: &WorldCamera) -> Option<CameraFrustum> {
    let [x, y, z] = world_to_renderer([camera.position.u, camera.position.v, camera.position.h]);
    let position = Vec3::new(x as f32, y as f32, z as f32);
    let rotation = Quat::from_array(world_rotation_to_renderer(camera.rotation).map(|v| v as f32));
    if !position.is_finite() || !rotation.is_finite() {
        return None;
    }
    let near_meters = camera.projection.near();
    let far_meters = camera.projection.far();
    let near = (near_meters * crate::protocol::UNITS_PER_METER) as f32;
    let display_far = ((far_meters
        .min(FRUSTUM_DISPLAY_DEPTH_METERS)
        .max(near_meters + 0.1))
        * crate::protocol::UNITS_PER_METER) as f32;
    if !near.is_finite() || !display_far.is_finite() || near <= 0.0 || display_far <= near {
        return None;
    }
    let aspect = (camera.aspect.width / camera.aspect.height) as f32;
    if !aspect.is_finite() || aspect <= 0.0 {
        return None;
    }
    let far_half = match &camera.projection {
        WorldCameraProjection::Isometric {
            vertical_size_meters,
            ..
        } => {
            let half = (*vertical_size_meters * crate::protocol::UNITS_PER_METER / 2.0) as f32
                * ISOMETRIC_GIZMO_FRAME_SCALE;
            Vec2::new(half * aspect, half)
        }
        WorldCameraProjection::Perspective {
            vertical_fov_radians,
            ..
        } => {
            let tan = (*vertical_fov_radians as f32 * 0.5).tan();
            let half = display_far * tan * PERSPECTIVE_GIZMO_FRAME_SCALE;
            Vec2::new(half * aspect, half)
        }
    };
    if ![far_half.x, far_half.y]
        .iter()
        .all(|value| value.is_finite() && *value > 0.0)
    {
        return None;
    }
    Some(CameraFrustum {
        position,
        rotation,
        forward: rotation * Vec3::NEG_Z,
        right: rotation * Vec3::X,
        up: rotation * Vec3::Y,
        display_far,
        far_half,
    })
}

/// World-space AABB of the camera body used by the shared model pick query.
pub(crate) fn pick_bounds(camera: &WorldCamera) -> Option<([f32; 3], [f32; 3])> {
    let frustum = frustum(camera)?;
    let min = frustum.position - Vec3::splat(CAMERA_BODY_HALF_EXTENT);
    let max = frustum.position + Vec3::splat(CAMERA_BODY_HALF_EXTENT);
    if !min.is_finite() || !max.is_finite() {
        return None;
    }
    Some((min.to_array(), max.to_array()))
}

pub(crate) struct CameraPickRegion {
    pub(crate) min: [f32; 3],
    pub(crate) max: [f32; 3],
    pub(crate) triangles: Option<Vec<crate::canvas_query::model_pick::SurfaceTriangle>>,
}

impl CameraPickRegion {
    fn bounds((min, max): ([f32; 3], [f32; 3])) -> Self {
        Self { min, max, triangles: None }
    }
}

/// Body/lens bounds and thin, oriented wireframe surfaces. A diagonal line's AABB
/// is only a broad phase: its empty corners must not hide visible world models.
pub(crate) fn pick_regions(camera: &WorldCamera) -> Vec<CameraPickRegion> {
    let Some(frustum) = frustum(camera) else {
        return Vec::new();
    };
    let Some(body) = pick_bounds(camera) else {
        return Vec::new();
    };
    let mut regions = vec![CameraPickRegion::bounds(body)];
    let lens = frustum.position + frustum.forward * 16.0;
    regions.push(CameraPickRegion::bounds((
        (lens - Vec3::splat(9.0)).to_array(),
        (lens + Vec3::splat(9.0)).to_array(),
    )));
    let far = frustum.far_corners();
    for index in 0..4 {
        let next = (index + 1) % 4;
        regions.push(segment_region(far[index], far[next], 1.6));
        regions.push(segment_region(frustum.position, far[index], 1.6));
    }
    regions
}

fn segment_region(start: Vec3, end: Vec3, pad: f32) -> CameraPickRegion {
    let delta = end - start;
    let rotation = Quat::from_rotation_arc(Vec3::Y, delta.normalize_or_zero());
    let center = (start + end) * 0.5;
    let half = Vec3::new(pad, delta.length() * 0.5 + pad, pad);
    let vertices = [
        [-1., -1., -1.], [1., -1., -1.], [1., 1., -1.], [-1., 1., -1.],
        [-1., -1., 1.], [1., -1., 1.], [1., 1., 1.], [-1., 1., 1.],
    ].map(|v| center + rotation * (Vec3::from_array(v) * half));
    let min = vertices.iter().copied().fold(Vec3::splat(f32::INFINITY), Vec3::min);
    let max = vertices.iter().copied().fold(Vec3::splat(f32::NEG_INFINITY), Vec3::max);
    let triangles = [
        [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
        [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
        [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
    ].map(|face| crate::canvas_query::model_pick::SurfaceTriangle {
        vertices: face.map(|index| vertices[index].to_array()),
        cull_back: false,
    }).to_vec();
    CameraPickRegion { min: min.to_array(), max: max.to_array(), triangles: Some(triangles) }
}

/// 世界镜头呈现指纹：主题、选择/悬停、焦点与全部相机参数共同决定重建。
fn presentation_key(scene: &Scene, theme: &ThemeResource) -> String {
    let mut key = String::new();
    let _ = write!(key, "t{};", theme.fingerprint());
    for node in &scene.nodes {
        let Some(camera) = &node.world_camera else {
            continue;
        };
        let _ = write!(
            key,
            "{}:{}{}:{:.4},{:.4},{:.4}/{:.4},{:.4},{:.4},{:.4}/",
            node.id,
            scene.selection.nodes.iter().any(|id| id == &node.id) as u8,
            scene
                .hover
                .as_ref()
                .and_then(|hover| hover.node_id.as_deref())
                == Some(node.id.as_str()),
            camera.position.u,
            camera.position.v,
            camera.position.h,
            camera.rotation[0],
            camera.rotation[1],
            camera.rotation[2],
            camera.rotation[3],
        );
        match &camera.projection {
            WorldCameraProjection::Isometric {
                vertical_size_meters,
                near_meters,
                far_meters,
            } => {
                let _ = write!(
                    key,
                    "o{vertical_size_meters:.4},{near_meters:.4},{far_meters:.4};"
                );
            }
            WorldCameraProjection::Perspective {
                vertical_fov_radians,
                near_meters,
                far_meters,
            } => {
                let _ = write!(
                    key,
                    "p{vertical_fov_radians:.4},{near_meters:.4},{far_meters:.4};"
                );
            }
        }
        let _ = write!(key, "{}x{};", camera.aspect.width, camera.aspect.height);
    }
    key.push_str(
        scene
            .model_focus
            .as_ref()
            .map_or("-", |focus| focus.node_id.as_str()),
    );
    key
}

/// Rebuild camera presence from the accepted scene.
pub(crate) fn sync(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    scene: Res<crate::app::CurrentScene>,
    theme: Res<ThemeResource>,
    mut presence: ResMut<WorldCameraPresence>,
) {
    let key = presentation_key(&scene.0, &theme);
    if presence.key.as_deref() == Some(key.as_str()) {
        return;
    }
    presence.key = Some(key);
    for entity in presence.entities.drain(..) {
        commands.entity(entity).try_despawn();
    }
    // Keep world space readable while focusing media/models.
    if scene.0.model_focus.is_some()
        || scene.0.image_focus.is_some()
        || scene.0.video_focus.is_some()
    {
        return;
    }
    if !scene.0.nodes.iter().any(|node| node.world_camera.is_some()) {
        return;
    }
    let cube = presence.assets.cube(&mut meshes);
    for node in &scene.0.nodes {
        let Some(camera) = &node.world_camera else {
            continue;
        };
        let Some(frustum) = frustum(camera) else {
            continue;
        };
        let selected = scene.0.selection.nodes.iter().any(|id| id == &node.id);
        let hovered = scene
            .0
            .hover
            .as_ref()
            .and_then(|hover| hover.node_id.as_deref())
            == Some(node.id.as_str());
        let color = if selected {
            theme.token_u32("canvasNodeBorderSelected")
        } else if hovered {
            theme.token_u32("interactionAccentHover")
        } else {
            theme.token_u32("canvasPortDefault")
        };
        spawn_camera(
            &mut commands,
            &mut presence,
            &cube,
            &mut materials,
            color,
            frustum,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_camera(
    commands: &mut Commands,
    presence: &mut WorldCameraPresence,
    cube: &Handle<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    color: u32,
    frustum: CameraFrustum,
) {
    let material = presence.assets.material(materials, color);
    let mut spawn = |translation: Vec3, rotation: Quat, scale: Vec3| {
        let entity = commands
            .spawn((
                WorldCameraMarker,
                Mesh3d(cube.clone()),
                MeshMaterial3d(material.clone()),
                Transform::from_translation(translation)
                    .with_rotation(rotation)
                    .with_scale(scale),
                RenderLayers::layer(WORLD_CAMERA_GIZMO_LAYER),
                Visibility::Inherited,
            ))
            .id();
        presence.entities.push(entity);
    };
    // Body + lens make the pose readable even when the frustum is nearly edge-on.
    spawn(
        frustum.position,
        frustum.rotation,
        Vec3::new(
            CAMERA_BODY_HALF_EXTENT * 0.9,
            CAMERA_BODY_HALF_EXTENT * 0.7,
            CAMERA_BODY_HALF_EXTENT,
        ),
    );
    spawn(
        frustum.position + frustum.forward * 16.0,
        frustum.rotation,
        Vec3::splat(CAMERA_BODY_HALF_EXTENT * 0.42),
    );
    // Ground anchor: a vertical stem and a diamond at the camera's ground projection.
    let ground = Vec3::new(frustum.position.x, 0.0, frustum.position.z);
    let height = (frustum.position.y - ground.y).abs();
    if height > 1.0 {
        line(&mut spawn, ground, frustum.position, 1.6);
    }
    let radius = CAMERA_BODY_HALF_EXTENT * 0.85;
    for (dx, dz, yaw) in [
        (radius * 0.5, radius * 0.5, 45.0_f32),
        (radius * 0.5, -radius * 0.5, 135.0),
        (-radius * 0.5, -radius * 0.5, -135.0),
        (-radius * 0.5, radius * 0.5, -45.0),
    ] {
        let edge = radius * std::f32::consts::SQRT_2;
        spawn(
            Vec3::new(ground.x + dx, ground.y + 1.0, ground.z + dz),
            Quat::from_rotation_y(yaw.to_radians()),
            Vec3::new(edge, 1.6, 1.6),
        );
    }

    let far = frustum.far_corners();
    for index in 0..4 {
        let next = (index + 1) % 4;
        line(&mut spawn, far[index], far[next], 1.4);
        line(&mut spawn, frustum.position, far[index], 1.2);
    }
}

fn line(spawn: &mut impl FnMut(Vec3, Quat, Vec3), start: Vec3, end: Vec3, thickness: f32) {
    let delta = end - start;
    let length = delta.length();
    if !length.is_finite() || length <= 1e-4 {
        return;
    }
    let rotation = Quat::from_rotation_arc(Vec3::Y, delta / length);
    spawn(
        (start + end) * 0.5,
        rotation,
        Vec3::new(thickness, length, thickness),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera(projection: WorldCameraProjection) -> WorldCamera {
        WorldCamera {
            kind: "world-camera".to_owned(),
            version: "shared-world-v1".to_owned(),
            camera_id: "camera-1".to_owned(),
            settings_version: "v1".to_owned(),
            position: crate::protocol::WorldCameraPoint {
                u: 0.0,
                v: 0.0,
                h: 6.928203230275509,
            },
            rotation: [
                -0.27984814233312133,
                -0.11591689595929515,
                0.3647051996310009,
                0.8804762392171493,
            ],
            projection,
            capture_mode: crate::protocol::WorldCameraCaptureMode::Static,
            aspect: crate::protocol::WorldCameraAspect {
                width: 16.0,
                height: 9.0,
            },
            bound_instance_id: None,
        }
    }

    #[test]
    fn isometric_frustum_is_a_compact_bounded_frame() {
        let value = camera(WorldCameraProjection::Isometric {
            vertical_size_meters: 8.0,
            near_meters: 0.1,
            far_meters: 500.0,
        });
        let frustum = frustum(&value).unwrap();
        assert!((frustum.display_far - (FRUSTUM_DISPLAY_DEPTH_METERS as f32 * 64.0)).abs() < 1e-3);
        let expected_half = 8.0 * 64.0 / 2.0 * ISOMETRIC_GIZMO_FRAME_SCALE as f64;
        assert!((frustum.far_half.y as f64 - expected_half).abs() < 1e-3);
        assert!((frustum.far_half.x as f64 - expected_half * (16.0 / 9.0)).abs() < 1e-3);
        assert_eq!(frustum.far_corners().len(), 4);
    }

    #[test]
    fn perspective_frustum_widens_with_depth() {
        let value = camera(WorldCameraProjection::Perspective {
            vertical_fov_radians: std::f64::consts::FRAC_PI_3,
            near_meters: 0.1,
            far_meters: 500.0,
        });
        let frustum = frustum(&value).unwrap();
        let expected = frustum.display_far
            * (std::f64::consts::FRAC_PI_3 as f32 * 0.5).tan()
            * PERSPECTIVE_GIZMO_FRAME_SCALE;
        assert!((frustum.far_half.y - expected).abs() < 1e-3);
        assert!((frustum.far_half.x - expected * (16.0 / 9.0)).abs() < 1e-3);
    }

    #[test]
    fn pick_bounds_stay_near_the_body_instead_of_covering_the_frustum() {
        let value = camera(WorldCameraProjection::Isometric {
            vertical_size_meters: 8.0,
            near_meters: 0.1,
            far_meters: 500.0,
        });
        let frustum = frustum(&value).unwrap();
        let (min, max) = pick_bounds(&value).unwrap();
        let extent = max[0] - min[0];
        assert!(extent <= CAMERA_BODY_HALF_EXTENT * 2.0 + 1.0);
        assert!((frustum.position.y - 6.928203230275509 * 64.0).abs() < 1.0);
        let regions = pick_regions(&value);
        assert_eq!(regions.len(), 10);
        assert!(regions
            .iter()
            .all(|region| region.min.iter().zip(region.max).all(|(a, b)| *a <= b)));
    }

    #[test]
    fn diagonal_wireframe_keeps_empty_corners_click_through_and_lines_pickable() {
        use std::sync::Arc;
        use crate::canvas_query::model_pick::{pick_candidates, ModelCandidate, SurfaceTriangle};
        let region = segment_region(Vec3::ZERO, Vec3::new(100., 100., 0.), 1.6);
        let camera = ModelCandidate {
            node_id: "camera".into(), shared_world: true, empty_marker: true,
            min: region.min, max: region.max, triangles: region.triangles.map(Arc::new),
        };
        let origin = Vec3::new(0., 100., -10.);
        assert!(pick_candidates(&[camera.clone()], origin, Vec3::Z, 100.).is_none());
        assert_eq!(pick_candidates(&[camera.clone()], Vec3::new(50., 50., -10.), Vec3::Z, 100.).unwrap().0, "camera");
        let model = ModelCandidate {
            node_id: "product".into(), shared_world: true, empty_marker: false,
            min: [-10., 90., 10.], max: [10., 110., 10.],
            triangles: Some(Arc::new(vec![SurfaceTriangle {
                vertices: [[-10., 90., 10.], [10., 90., 10.], [0., 110., 10.]], cull_back: false,
            }])),
        };
        assert_eq!(pick_candidates(&[camera, model], origin, Vec3::Z, 100.).unwrap().0, "product");
    }
}
