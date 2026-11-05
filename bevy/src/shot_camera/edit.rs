//! 输入设备无关的编辑命令面与可选 Bevy pointer adapter
//! （change: add-reusable-bevy-shot-camera，任务 3.1/3.3 / design D4）。
//!
//! 核心只接受统一的 `Begin/Update/Commit/Cancel/Reset` 命令；生产 Web adapter 与内置 pointer
//! adapter 共用同一状态机与取景数学。adapter 未启用时**不抢占**宿主输入。
//!
//! 命令状态机在原生/无窗口构建下同样可用（供宿主 adapter 投递）；内置 pointer adapter 只在
//! 有真实窗口输入（`wasm`）时编译。

use bevy::prelude::*;

use super::components::{
    FocusComponent, ShotCameraAxis, ShotCameraDerived, ShotCameraEditable, ShotCameraLens,
    ShotCameraPose, ShotCameraTarget,
};
use super::edit_types::{
    ShotEditEvent, ShotEditSessions, begin_edit, cancel_edit, commit_edit, reset_pose,
    update_distance, update_elevation, update_focus, update_orbit,
};
use super::{ShotCameraEditCommitted, ShotCameraPreviewChanged};

/// 一次编辑命令（与 DOM/PointerEvent/CanvasCommand 无关）。
#[derive(Clone, Copy, Debug)]
pub enum ShotEditCommand {
    /// 开始一次 orbit 编辑。
    BeginOrbit,
    /// 开始一次 elevation 编辑（change: add-shot-camera-elevation-control）。
    BeginElevation,
    /// 开始一次 distance 编辑。
    BeginDistance,
    /// 开始一次 focus 轴编辑。
    BeginFocus(FocusComponent),
    /// 更新：屏幕横向位移（orbit）。
    UpdateOrbit { delta_x: f32, surface_width: f32 },
    /// 更新：屏幕纵向位移（elevation）。
    UpdateElevation {
        delta_pixels: f32,
        surface_height: f32,
    },
    /// 更新：屏幕纵向位移（distance）。
    UpdateDistance {
        delta_pixels: f32,
        surface_height: f32,
    },
    /// 更新：世界位移（focus）。
    UpdateFocus { world_delta: f32 },
    /// 提交。
    Commit,
    /// 取消并恢复起始 pose。
    Cancel,
    /// 重置到给定默认 pose。
    Reset { azimuth: f32, distance: f32 },
}

/// 宿主/适配器投递的编辑命令队列。
#[derive(Resource, Default)]
pub struct ShotEditCommands {
    pub queue: Vec<(Entity, ShotEditCommand)>,
}

impl ShotEditCommands {
    pub fn push(&mut self, camera: Entity, command: ShotEditCommand) {
        self.queue.push((camera, command));
    }
}

/// 应用编辑命令：更新运行时 pose 并发出稳定事件。
///
/// 无净变化的 commit 不发布完成事件；cancel 恢复起始 pose。
pub(crate) fn apply_edit_commands(
    mut commands: ResMut<ShotEditCommands>,
    mut sessions: ResMut<ShotEditSessions>,
    mut rigs: Query<(
        &mut ShotCameraPose,
        &ShotCameraTarget,
        &ShotCameraLens,
        &ShotCameraEditable,
        &mut ShotCameraDerived,
    )>,
    mut committed: MessageWriter<ShotCameraEditCommitted>,
    mut preview_changed: MessageWriter<ShotCameraPreviewChanged>,
) {
    for (entity, command) in std::mem::take(&mut commands.queue) {
        let Ok((mut pose, target, lens, editable, mut derived)) = rigs.get_mut(entity) else {
            continue;
        };
        if !editable.enabled {
            continue;
        }
        match command {
            ShotEditCommand::BeginOrbit
            | ShotEditCommand::BeginElevation
            | ShotEditCommand::BeginDistance
            | ShotEditCommand::BeginFocus(_) => {
                let (axis, focus_component) = match command {
                    ShotEditCommand::BeginOrbit => (ShotCameraAxis::Orbit, None),
                    ShotEditCommand::BeginElevation => (ShotCameraAxis::Elevation, None),
                    ShotEditCommand::BeginDistance => (ShotCameraAxis::Distance, None),
                    ShotEditCommand::BeginFocus(component) => {
                        (ShotCameraAxis::Focus, Some(component))
                    }
                    _ => unreachable!(),
                };
                let span = target
                    .bounds
                    .map(|bounds| bounds.radius().max(1e-4))
                    .unwrap_or(1.0);
                let fit = super::framing::shot_fit_distance(span, lens.aspect);
                sessions.upsert(begin_edit(entity, axis, focus_component, *pose, fit));
            }
            ShotEditCommand::UpdateOrbit {
                delta_x,
                surface_width,
            } => {
                if let Some(mut session) = sessions.find(entity).copied() {
                    let event = update_orbit(&mut session, delta_x, surface_width);
                    sessions.upsert(session);
                    apply_event(event, &mut pose, &mut derived, &mut preview_changed);
                }
            }
            ShotEditCommand::UpdateElevation {
                delta_pixels,
                surface_height,
            } => {
                if let Some(mut session) = sessions.find(entity).copied() {
                    let event = update_elevation(&mut session, delta_pixels, surface_height);
                    sessions.upsert(session);
                    apply_event(event, &mut pose, &mut derived, &mut preview_changed);
                }
            }
            ShotEditCommand::UpdateDistance {
                delta_pixels,
                surface_height,
            } => {
                if let Some(mut session) = sessions.find(entity).copied() {
                    let event = update_distance(&mut session, delta_pixels, surface_height);
                    sessions.upsert(session);
                    apply_event(event, &mut pose, &mut derived, &mut preview_changed);
                }
            }
            ShotEditCommand::UpdateFocus { world_delta } => {
                if let Some(mut session) = sessions.find(entity).copied() {
                    let event = update_focus(&mut session, world_delta);
                    sessions.upsert(session);
                    apply_event(event, &mut pose, &mut derived, &mut preview_changed);
                }
            }
            ShotEditCommand::Commit => {
                let Some(session) = sessions.remove(entity) else {
                    continue;
                };
                if let Some(ShotEditEvent::Committed { camera, pose: next }) = commit_edit(&session)
                {
                    *pose = next;
                    mark_dirty(&mut derived, &mut preview_changed, camera);
                    committed.write(ShotCameraEditCommitted { camera, pose: next });
                }
            }
            ShotEditCommand::Cancel => {
                let Some(session) = sessions.remove(entity) else {
                    continue;
                };
                apply_event(
                    cancel_edit(&session),
                    &mut pose,
                    &mut derived,
                    &mut preview_changed,
                );
            }
            ShotEditCommand::Reset { azimuth, distance } => {
                *pose = reset_pose(azimuth, distance);
                mark_dirty(&mut derived, &mut preview_changed, entity);
                sessions.remove(entity);
            }
        }
    }
}

fn apply_event(
    event: ShotEditEvent,
    pose: &mut ShotCameraPose,
    derived: &mut ShotCameraDerived,
    preview_changed: &mut MessageWriter<ShotCameraPreviewChanged>,
) {
    let (camera, next) = match event {
        ShotEditEvent::Updated { camera, pose, .. } => (camera, pose),
        ShotEditEvent::Cancelled { camera, pose } => (camera, pose),
        ShotEditEvent::Committed { camera, pose } => (camera, pose),
        ShotEditEvent::Reset { camera, pose } => (camera, pose),
        ShotEditEvent::Begun(_) => return,
    };
    *pose = next;
    mark_dirty(derived, preview_changed, camera);
}

fn mark_dirty(
    derived: &mut ShotCameraDerived,
    preview_changed: &mut MessageWriter<ShotCameraPreviewChanged>,
    entity: Entity,
) {
    derived.dirty = true;
    derived.generation = derived.generation.wrapping_add(1);
    preview_changed.write(ShotCameraPreviewChanged {
        camera: entity,
        generation: derived.generation,
    });
}

/// 可选即插即用的 pointer adapter；未启用时不读取全局输入。
///
/// `enabled` 由宿主显式设置：生产 Web 由 DOM 输入路由决定优先级并投递命令，因此应保持禁用，
/// 避免与 DOM adapter 争用。
#[cfg(feature = "canvas-core")]
#[derive(Resource, Default)]
pub struct ShotPointerAdapter {
    pub enabled: bool,
    active: Option<(Entity, ShotCameraAxis, Option<FocusComponent>)>,
}

/// 注册可选 pointer adapter；核心命令状态机由 `ShotCameraPlugin` 提供。
#[cfg(feature = "canvas-core")]
pub struct ShotCameraInteractionPlugin;

#[cfg(feature = "canvas-core")]
impl Plugin for ShotCameraInteractionPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ShotPointerAdapter>().add_systems(
            PostUpdate,
            (pointer_begin_edit, pointer_apply_motion, pointer_end_edit)
                .chain()
                .before(super::ShotCameraSet::Edit).run_if(crate::canvas_activity::running),
        );
    }
}

/// 按下主键时对选中的 rig 做 gizmo 命中并开始编辑。
#[cfg(feature = "canvas-core")]
#[allow(clippy::too_many_arguments)]
fn pointer_begin_edit(
    mut adapter: ResMut<ShotPointerAdapter>,
    selection: Res<super::gizmo::ShotGizmoSelection>,
    buttons: Res<ButtonInput<MouseButton>>,
    windows: Query<&Window, With<bevy::window::PrimaryWindow>>,
    cameras: Query<(&Camera, &GlobalTransform), With<Camera3d>>,
    rigs: Query<(&ShotCameraDerived, &ShotCameraEditable)>,
    mut commands: ResMut<ShotEditCommands>,
) {
    if !adapter.enabled || !buttons.just_pressed(MouseButton::Left) {
        return;
    }
    let Ok(window) = windows.single() else {
        return;
    };
    let Some(pointer) = window.cursor_position() else {
        return;
    };
    let Some((camera, camera_transform)) = cameras.iter().next() else {
        return;
    };
    for rig in &selection.entities {
        let Ok((derived, editable)) = rigs.get(*rig) else {
            continue;
        };
        if !editable.enabled {
            continue;
        }
        let project = |world: Vec3| camera.world_to_viewport(camera_transform, world).ok();
        let origin = project(derived.position);
        let focus = project(derived.focus);
        let axis = if origin.is_some_and(|origin| origin.distance(pointer) <= 36.0) {
            ShotCameraAxis::Distance
        } else if let (Some(a), Some(b)) = (origin, focus) {
            if distance_to_segment(pointer, a, b) <= SHOT_DISTANCE_SEGMENT_HIT_CSS {
                ShotCameraAxis::Distance
            } else if hit_elevation_semicircle(pointer, derived, &project) {
                ShotCameraAxis::Elevation
            } else {
                ShotCameraAxis::Orbit
            }
        } else {
            ShotCameraAxis::Orbit
        };
        let command = match axis {
            ShotCameraAxis::Orbit => ShotEditCommand::BeginOrbit,
            ShotCameraAxis::Elevation => ShotEditCommand::BeginElevation,
            ShotCameraAxis::Distance => ShotEditCommand::BeginDistance,
            ShotCameraAxis::Focus => ShotEditCommand::BeginFocus(FocusComponent::Y),
        };
        commands.push(*rig, command);
        adapter.active = Some((*rig, axis, None));
        return;
    }
}

/// 拖动时把累计位移换算为当前编辑轴的更新。
#[cfg(feature = "canvas-core")]
fn pointer_apply_motion(
    adapter: Res<ShotPointerAdapter>,
    motion: Res<bevy::input::mouse::AccumulatedMouseMotion>,
    windows: Query<&Window, With<bevy::window::PrimaryWindow>>,
    mut commands: ResMut<ShotEditCommands>,
) {
    if !adapter.enabled {
        return;
    }
    let Some((rig, axis, focus_component)) = adapter.active else {
        return;
    };
    let delta = motion.delta;
    if delta.length_squared() <= 0.0 {
        return;
    }
    let Ok(window) = windows.single() else {
        return;
    };
    let command = match axis {
        ShotCameraAxis::Orbit => ShotEditCommand::UpdateOrbit {
            delta_x: delta.x,
            surface_width: window.width(),
        },
        ShotCameraAxis::Elevation => ShotEditCommand::UpdateElevation {
            delta_pixels: delta.y,
            surface_height: window.height(),
        },
        ShotCameraAxis::Distance => ShotEditCommand::UpdateDistance {
            delta_pixels: delta.y,
            surface_height: window.height(),
        },
        ShotCameraAxis::Focus => ShotEditCommand::UpdateFocus {
            world_delta: delta.y,
        },
    };
    let _ = focus_component;
    commands.push(rig, command);
}

/// 松开主键时提交当前编辑。
#[cfg(feature = "canvas-core")]
fn pointer_end_edit(
    mut adapter: ResMut<ShotPointerAdapter>,
    buttons: Res<ButtonInput<MouseButton>>,
    mut commands: ResMut<ShotEditCommands>,
) {
    if !adapter.enabled || !buttons.just_released(MouseButton::Left) {
        return;
    }
    if let Some((rig, ..)) = adapter.active.take() {
        commands.push(rig, ShotEditCommand::Commit);
    }
}

/// 与 Web `SHOT_DISTANCE_SEGMENT_HIT_CSS` 一致的命中宽度。
#[cfg(feature = "canvas-core")]
const SHOT_DISTANCE_SEGMENT_HIT_CSS: f32 = 14.0;

/// 与 Web `SHOT_ELEVATION_RING_HIT_CSS` 一致的竖直半圆命中宽度。
#[cfg(feature = "canvas-core")]
const SHOT_ELEVATION_RING_HIT_CSS: f32 = 24.0;

/// 命中竖直半圆仰角轨道：屏幕空间与采样段的最短距离。
#[cfg(feature = "canvas-core")]
fn hit_elevation_semicircle(
    pointer: Vec2,
    derived: &ShotCameraDerived,
    project: &impl Fn(Vec3) -> Option<Vec2>,
) -> bool {
    let delta = derived.position - derived.focus;
    let horizontal = (delta.x * delta.x + delta.z * delta.z).sqrt();
    let radius = if horizontal > 1e-3 {
        horizontal
    } else {
        let distance = (derived.position - derived.focus).length();
        (crate::shot_camera::framing::shot_view_half_height(distance, derived.fov) * 0.5).max(0.1)
            * 1.15
    };
    let radial = if horizontal > 1e-3 {
        Vec3::new(delta.x / horizontal, 0.0, delta.z / horizontal)
    } else {
        Vec3::Z
    };
    let segments = 32;
    let mut previous: Option<Vec2> = None;
    for index in 0..=segments {
        let angle =
            -std::f32::consts::FRAC_PI_2 + (index as f32 / segments as f32) * std::f32::consts::PI;
        let point =
            derived.focus + radial * (angle.cos() * radius) + Vec3::Y * (angle.sin() * radius);
        let Some(screen) = project(point) else {
            previous = None;
            continue;
        };
        if let Some(previous) = previous
            && distance_to_segment(pointer, previous, screen) <= SHOT_ELEVATION_RING_HIT_CSS
        {
            return true;
        }
        previous = Some(screen);
    }
    false
}

#[cfg(feature = "canvas-core")]
fn distance_to_segment(point: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let length_sq = ab.length_squared();
    if length_sq <= 1e-9 {
        return point.distance(a);
    }
    let t = ((point - a).dot(ab) / length_sq).clamp(0.0, 1.0);
    point.distance(a + ab * t)
}
