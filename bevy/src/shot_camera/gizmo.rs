//! Shot camera rig 的可丢弃 gizmo 视图
//! （change: add-reusable-bevy-shot-camera，任务 3.2 / design D5）。
//!
//! 由 rig 当前派生 pose 生成方位环、镜头原点、视线与 frustum，绘制在独立 editor layer；
//! 高频 pose 更新优先重用一个已缓存的 mesh/material 句柄并只刷新 transform，仅在半径/画幅
//! 档变化时重建实体。gizmo 不拥有镜头事实，且不出现在 preview/capture 输出中
//! （view mask 由宿主排除 editor layer）。

use std::collections::HashMap;

use bevy::{prelude::*, camera::visibility::RenderLayers};

use super::components::{ShotCameraDerived, ShotCameraEditable, ShotCameraLens};
use super::{GizmoLayout, GizmoPart, GizmoPartKind};

/// 编辑辅助使用的渲染层；主画布相机可见，preview/capture view mask 必须排除它。
pub const SHOT_GIZMO_LAYER: usize = 1;

/// 竖直仰角半圆的采样段数（change: add-shot-camera-elevation-control）。
///
/// 半圆按固定段数拆成线段实体，数量恒定、不随 pose 变化重建。
pub const SHOT_ELEVATION_ARC_SEGMENTS: u32 = 32;

const ORBIT_COLOR: Color = Color::srgb(0.30, 0.78, 0.95);
const SIGHT_COLOR: Color = Color::srgb(0.96, 0.72, 0.16);
const FRUSTUM_COLOR: Color = Color::srgb(0.96, 0.62, 0.16);
/// 竖直仰角半圆颜色（与方位环区分；change: add-shot-camera-elevation-control）。
const ELEVATION_COLOR: Color = Color::srgb(0.55, 0.86, 0.55);

/// 复用的 gizmo mesh/material 句柄缓存，避免高频更新时资源无界增长。
#[derive(Resource, Default)]
pub struct ShotGizmoAssets {
    meshes: HashMap<String, Handle<Mesh>>,
    materials: HashMap<u32, Handle<StandardMaterial>>,
}

impl ShotGizmoAssets {
    fn ring_mesh(&mut self, meshes: &mut Assets<Mesh>, radius_bucket: u32) -> Handle<Mesh> {
        let key = format!("ring:{radius_bucket}");
        let radius = radius_bucket as f32 / 1000.0;
        self.meshes
            .entry(key)
            .or_insert_with(|| {
                let tube = (radius * 0.012).max(0.01);
                meshes.add(Torus::new(radius, radius + tube * 2.0).mesh().build())
            })
            .clone()
    }

    fn sphere_mesh(&mut self, meshes: &mut Assets<Mesh>, radius_bucket: u32) -> Handle<Mesh> {
        let key = format!("sphere:{radius_bucket}");
        let radius = radius_bucket as f32 / 1000.0;
        self.meshes
            .entry(key)
            .or_insert_with(|| meshes.add(Sphere::new(radius).mesh().build()))
            .clone()
    }

    fn rod_mesh(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.meshes
            .entry("rod".to_owned())
            .or_insert_with(|| meshes.add(Cylinder::new(1.0, 1.0).mesh().resolution(10)))
            .clone()
    }

    fn material(&mut self, materials: &mut Assets<StandardMaterial>, color: Color) -> Handle<StandardMaterial> {
        let key = color.to_srgba().to_u8_array().iter().fold(0u32, |acc, byte| {
            (acc << 8) | u32::from(*byte)
        });
        self.materials
            .entry(key)
            .or_insert_with(|| {
                materials.add(StandardMaterial {
                    base_color: color,
                    unlit: true,
                    alpha_mode: AlphaMode::Blend,
                    ..default()
                })
            })
            .clone()
    }
}

/// 同步所有可编辑 rig 的 gizmo；只有被选中的 rig 显示 gizmo。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_shot_gizmos(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut assets: ResMut<ShotGizmoAssets>,
    selected: Res<ShotGizmoSelection>,
    mut rigs: Query<(
        Entity,
        &ShotCameraDerived,
        &ShotCameraLens,
        &ShotCameraEditable,
        &mut super::ShotCameraInner,
    )>,
) {
    for (entity, derived, lens, editable, mut inner) in &mut rigs {
        let visible = editable.enabled && selected.entities.contains(&entity);
        if !visible {
            if !inner.gizmo.entities.is_empty() {
                despawn_gizmo(&mut commands, &mut inner.gizmo.entities);
            }
            continue;
        }
        if !inner.gizmo.entities.is_empty() {
            refresh_gizmo(&mut commands, &inner.gizmo, derived, lens);
            continue;
        }
        inner.gizmo.base_radius = (view_half_height(derived) * 0.5).max(0.1);
        spawn_gizmo(
            &mut commands,
            &mut meshes,
            &mut materials,
            &mut assets,
            &mut inner.gizmo.entities,
            entity,
            derived,
            lens,
        );
    }
}

/// 拖动只更新已有部件的 transform，距离/方位/画幅变化均不重建实体或 mesh。
fn refresh_gizmo(commands: &mut Commands, gizmo: &GizmoLayout, derived: &ShotCameraDerived, lens: &ShotCameraLens) {
    let safe_radius = (view_half_height(derived) * 0.5).max(0.1);
    // 球笼半径 = 相机到焦点的完整距离，拖动仰角/方位时保持不变。
    let cage_radius = (derived.position - derived.focus).length();
    let cage_radius = if cage_radius > 1e-3 { cage_radius } else { safe_radius * 1.15 };
    let width = (safe_radius * 0.012).max(0.01);
    let lines = gizmo_lines(derived, lens);
    let mut line_index = 0;
    for part in &gizmo.entities {
        let (translation, rotation, scale) = match &part.kind {
            GizmoPartKind::Ring { radius, .. } => (
                derived.focus, Quat::IDENTITY, Vec3::splat(cage_radius / radius),
            ),
            GizmoPartKind::ElevationArc { radius, index, segments } => {
                let (start, end) = elevation_arc_segment(derived, cage_radius, *index, *segments);
                let _ = radius;
                line_transform(start, end, width)
            }
            GizmoPartKind::Origin { .. } => (
                derived.position, Quat::IDENTITY, Vec3::splat(safe_radius / gizmo.base_radius),
            ),
            GizmoPartKind::Line { .. } => {
                let (start, end) = lines[line_index];
                line_index += 1;
                line_transform(start, end, width)
            }
        };
        if let Ok(mut entity) = commands.get_entity(part.entity) {
            entity.insert(Transform { translation, rotation, scale });
        }
    }
}

/// 竖直半圆第 `index` 段的端点（change: add-shot-camera-elevation-control）。
///
/// 位于过 focus、包含世界 Y 轴与当前方位径向的竖直平面内，从 `-90°` 到 `+90°`。
pub(crate) fn elevation_arc_segment(
    derived: &ShotCameraDerived,
    radius: f32,
    index: u32,
    segments: u32,
) -> (Vec3, Vec3) {
    let delta = derived.position - derived.focus;
    let horizontal = (delta.x * delta.x + delta.z * delta.z).sqrt();
    let radial = if horizontal > 1e-3 {
        Vec3::new(delta.x / horizontal, 0.0, delta.z / horizontal)
    } else {
        Vec3::Z
    };
    let point_at = |i: u32| -> Vec3 {
        let angle =
            -std::f32::consts::FRAC_PI_2 + (i as f32 / segments.max(1) as f32) * std::f32::consts::PI;
        derived.focus + radial * (angle.cos() * radius) + Vec3::Y * (angle.sin() * radius)
    };
    (point_at(index), point_at(index + 1))
}

/// 当前取景半高（焦点平面）：透视下由相机距离与 FOV 派生
/// （change: switch-shot-camera-to-perspective）。替代正交的 `ortho_size` 作为 gizmo 尺寸基准。
fn view_half_height(derived: &ShotCameraDerived) -> f32 {
    let distance = (derived.position - derived.focus).length();
    crate::shot_camera::framing::shot_view_half_height(distance, derived.fov)
}

/// 视线 + 四条视锥射线 + 四条边框；创建与拖动更新共用几何计算。
fn gizmo_lines(derived: &ShotCameraDerived, lens: &ShotCameraLens) -> [(Vec3, Vec3); 9] {
    let position = derived.position;
    let focus = derived.focus;
    let safe_radius = (view_half_height(derived) * 0.5).max(0.1);
    let tube = (safe_radius * 0.012).max(0.01);
    let frame = Transform::from_translation(position).looking_at(focus, Vec3::Y);
    let forward = frame.rotation * Vec3::NEG_Z;
    let right = frame.rotation * Vec3::X;
    let up = frame.rotation * Vec3::Y;
    let depth = (safe_radius * 0.9).max(tube * 12.0);
    let half_height = (view_half_height(derived) * 0.28).clamp(safe_radius * 0.22, safe_radius * 0.55);
    let half_width = half_height * lens.aspect;
    let center = position + forward * depth;
    let corners = [
        center - right * half_width - up * half_height,
        center + right * half_width - up * half_height,
        center + right * half_width + up * half_height,
        center - right * half_width + up * half_height,
    ];
    let mut lines = [(position, focus); 9];
    for index in 0..4 {
        lines[1 + index] = (position, corners[index]);
        lines[5 + index] = (corners[index], corners[(index + 1) % 4]);
    }
    lines
}

fn despawn_gizmo(commands: &mut Commands, parts: &mut Vec<GizmoPart>) {
    for part in parts.drain(..) {
        commands.entity(part.entity).try_despawn();
    }
}

/// rig 被销毁后，清掉仍留在场景里的 gizmo 和窗口预览相机。
///
/// 二者都不是 rig 的子实体。只 despawn rig 时，轨道环会留在主相机上，预览相机也会继续
/// 以旧姿态铺满窗口。每次重新进入聚焦就会再叠一台。
pub(crate) fn cleanup_orphan_shot_gizmos(
    mut commands: Commands,
    gizmos: Query<(Entity, &super::ShotGizmo)>,
    previews: Query<(Entity, &super::ShotPreviewCamera)>,
) {
    for (entity, gizmo) in &gizmos {
        if commands.get_entity(gizmo.rig).is_err() {
            commands.entity(entity).try_despawn();
        }
    }
    for (entity, preview) in &previews {
        if commands.get_entity(preview.rig).is_err() {
            commands.entity(entity).try_despawn();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_gizmo(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    assets: &mut ShotGizmoAssets,
    out: &mut Vec<GizmoPart>,
    rig: Entity,
    derived: &ShotCameraDerived,
    lens: &ShotCameraLens,
) {
    let focus = derived.focus;
    let position = derived.position;
    let safe_radius = (view_half_height(derived) * 0.5).max(0.1);
    // 球笼半径 = 相机到焦点的完整距离，拖动仰角/方位时保持不变。
    let full_distance = (position - focus).length();
    let ring_radius = if full_distance > 1e-3 {
        full_distance
    } else {
        safe_radius * 1.15
    };
    let tube = (safe_radius * 0.012).max(0.01);
    let radius_bucket = (safe_radius * 1000.0).round().max(1.0) as u32;
    let ring_bucket = (ring_radius * 1000.0).round().max(1.0) as u32;

    // 方位环（水平，以 focus 为中心）。
    let ring_mesh = assets.ring_mesh(meshes, ring_bucket);
    let orbit_material = assets.material(materials, ORBIT_COLOR);
    out.push(GizmoPart {
        entity: commands
            .spawn((
                super::ShotGizmo { rig },
                Mesh3d(ring_mesh),
                MeshMaterial3d(orbit_material),
                Transform::from_translation(focus),
                Visibility::Inherited,
                RenderLayers::layer(SHOT_GIZMO_LAYER),
            ))
            .id(),
        kind: GizmoPartKind::Ring {
            focus,
            radius: ring_radius,
        },
    });

    // 镜头原点。
    let origin_mesh = assets.sphere_mesh(meshes, radius_bucket);
    let frustum_material = assets.material(materials, FRUSTUM_COLOR);
    out.push(GizmoPart {
        entity: commands
            .spawn((
                super::ShotGizmo { rig },
                Mesh3d(origin_mesh),
                MeshMaterial3d(frustum_material.clone()),
                Transform::from_translation(position),
                Visibility::Inherited,
                RenderLayers::layer(SHOT_GIZMO_LAYER),
            ))
            .id(),
        kind: GizmoPartKind::Origin { position },
    });

    // 视线与 frustum。
    let dir = focus - position;
    if dir.length() <= 1e-3 {
        return;
    }
    let rod = assets.rod_mesh(meshes);
    let sight_material = assets.material(materials, SIGHT_COLOR);
    for (index, (start, end)) in gizmo_lines(derived, lens).into_iter().enumerate() {
        let material = if index == 0 { sight_material.clone() } else { frustum_material.clone() };
        spawn_line(commands, materials, out, rig, &rod, start, end, tube, material);
    }

    // 竖直半圆仰角轨道（change: add-shot-camera-elevation-control）：复用 rod mesh，
    // 每段一个实体，数量固定，不随 pose 变化重建。
    let elevation_material = assets.material(materials, ELEVATION_COLOR);
    for index in 0..SHOT_ELEVATION_ARC_SEGMENTS {
        let (start, end) = elevation_arc_segment(derived, ring_radius, index, SHOT_ELEVATION_ARC_SEGMENTS);
        let before = out.len();
        spawn_line(commands, materials, out, rig, &rod, start, end, tube, elevation_material.clone());
        if out.len() > before
            && let Some(part) = out.last_mut()
        {
            part.kind = GizmoPartKind::ElevationArc {
                radius: ring_radius,
                index,
                segments: SHOT_ELEVATION_ARC_SEGMENTS,
            };
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_line(
    commands: &mut Commands,
    _materials: &mut Assets<StandardMaterial>,
    out: &mut Vec<GizmoPart>,
    rig: Entity,
    rod: &Handle<Mesh>,
    start: Vec3,
    end: Vec3,
    width: f32,
    material: Handle<StandardMaterial>,
) {
    let delta = end - start;
    let length = delta.length();
    if length <= 1e-3 {
        return;
    }
    let (translation, rotation, scale) = line_transform(start, end, width);
    out.push(GizmoPart {
        entity: commands
            .spawn((
                super::ShotGizmo { rig },
                Mesh3d(rod.clone()),
                MeshMaterial3d(material),
                Transform {
                    translation,
                    rotation,
                    scale,
                },
                Visibility::Inherited,
                RenderLayers::layer(SHOT_GIZMO_LAYER),
            ))
            .id(),
        kind: GizmoPartKind::Line { start, end, width },
    });
}

fn line_transform(start: Vec3, end: Vec3, width: f32) -> (Vec3, Quat, Vec3) {
    let delta = end - start;
    let length = delta.length().max(1e-6);
    (
        (start + end) * 0.5,
        Quat::from_rotation_arc(Vec3::Y, delta / length),
        Vec3::new(width, length, width),
    )
}

/// 当前可显示/命中的 rig 集合（session-only，不拥有镜头事实）。
#[derive(Resource, Default, Debug)]
pub struct ShotGizmoSelection {
    pub entities: Vec<Entity>,
}
