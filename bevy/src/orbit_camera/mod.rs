//! 独立的目标轨道相机（Orbit Camera）
//! （change: refactor-bevy-reusable-components，任务 3.1 / design D1）。
//!
//! 提供围绕目标点的自由旋转（yaw/pitch）、平移（pan）和缩放（distance）的 ECS 相机 rig，
//! 支持透视/正交投影、可选 Bevy pointer adapter 与输入无关命令。它与受限的
//! [`crate::shot_camera`]（全局默认 pitch、正交拍摄镜头）**互不接管**彼此的相机、输入或
//! preview/capture 资源。
//!
//! 边界：本模块只依赖 Bevy 与标准库，不依赖 canvas `protocol`、`bridge`、DOM 或 Y.Doc。

use bevy::prelude::*;

#[cfg(feature = "canvas-core")]
mod interaction;
#[cfg(feature = "canvas-core")]
pub use interaction::{OrbitCameraInteractionPlugin, OrbitCameraPointerAdapter};

/// 默认 near/far。
pub const ORBIT_DEFAULT_NEAR: f32 = 0.05;
pub const ORBIT_DEFAULT_FAR: f32 = 200_000.0;
/// 默认 FOV（弧度）。
pub const ORBIT_DEFAULT_FOV: f32 = 50.0 * std::f32::consts::PI / 180.0;

/// 把透视在给定相机距离处的可见高度换算为正交固定视口高度，使二者在过目标点的平面上
/// 等效取景（change: 2026-10-09-fix-model-preview-layering-and-projection）。
///
/// 透视相机距目标 `d` 时，中心平面可见高度为 `2·d·tan(fov/2)`；正交相机把该值作为
/// `ScalingMode::Fixed` 的高度即可得到一致的画面尺寸。
pub fn orthographic_viewport_height(distance: f32, fov: f32) -> f32 {
    let distance = if distance.is_finite() && distance > 0.0 {
        distance
    } else {
        1.0
    };
    2.0 * distance * (fov * 0.5).tan()
}

/// 投影模式。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OrbitProjection {
    Perspective { fov: f32 },
    Orthographic { viewport_height: f32 },
}

impl Default for OrbitProjection {
    fn default() -> Self {
        Self::Perspective {
            fov: ORBIT_DEFAULT_FOV,
        }
    }
}

/// 相机围绕的目标点。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct OrbitCameraTarget {
    pub point: Vec3,
}

impl Default for OrbitCameraTarget {
    fn default() -> Self {
        Self { point: Vec3::ZERO }
    }
}

/// 轨道姿态：yaw/pitch 弧度（pitch 以水平面为 0，向上为正）、distance、pan。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct OrbitCameraPose {
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
    pub pan: Vec3,
}

impl Default for OrbitCameraPose {
    fn default() -> Self {
        Self {
            yaw: 0.0,
            pitch: 0.0,
            distance: 10.0,
            pan: Vec3::ZERO,
        }
    }
}

/// 光学参数。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct OrbitCameraLens {
    pub projection: OrbitProjection,
    pub near: f32,
    pub far: f32,
}

impl Default for OrbitCameraLens {
    fn default() -> Self {
        Self {
            projection: OrbitProjection::default(),
            near: ORBIT_DEFAULT_NEAR,
            far: ORBIT_DEFAULT_FAR,
        }
    }
}

/// 姿态边界：非法输入必须稳定回退，不产生 NaN。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct OrbitCameraLimits {
    pub min_distance: f32,
    pub max_distance: f32,
    /// pitch 下限（弧度，允许向下看）。
    pub min_pitch: f32,
    /// pitch 上限（弧度，允许向上看）。
    pub max_pitch: f32,
}

impl Default for OrbitCameraLimits {
    fn default() -> Self {
        // 接近奇点的 limit（与产品聚焦相机一致）。
        let limit = 89.0_f32.to_radians();
        Self {
            min_distance: 0.1,
            max_distance: 100_000.0,
            min_pitch: -limit,
            max_pitch: limit,
        }
    }
}

/// 由 rig 派生的相机世界姿态（只由派生系统写入）。
#[derive(Component, Clone, Copy, Debug, PartialEq, Default)]
pub struct OrbitCameraDerived {
    pub position: Vec3,
    pub rotation: Quat,
}

/// 标记：该实体是本插件管理的 orbit 相机（宿主可据此区分其它 Camera3d）。
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct OrbitCameraRig;

/// 标记：临时挂起该 rig 的相机写入。
///
/// 宿主 adapter 在过渡或非 orbit 模式（例如聚焦相机退出时的正交 home）期间挂起 rig，自行
/// 写 `Transform`/`Projection`；挂起期间插件仍保留 pose/target/derived，但不覆盖相机。
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct OrbitCameraSuspended;

/// 内部：rig 拥有的实际 `Camera3d` 子实体。
#[derive(Component, Clone, Copy, Debug)]
pub struct OrbitCameraLink(pub Entity);

/// rig 的内部子资源句柄（调用方不得依赖其布局）。
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct OrbitCameraInner {
    pub camera: Option<Entity>,
}

/// 在给定目标/姿态下派生相机世界位置与朝向（纯函数）。
pub fn derive_orbit_transform(target: &OrbitCameraTarget, pose: &OrbitCameraPose) -> (Vec3, Quat) {
    let center = target.point + pose.pan;
    let cp = pose.pitch.cos();
    let dir = Vec3::new(pose.yaw.sin() * cp, pose.pitch.sin(), pose.yaw.cos() * cp);
    let position = center + dir * pose.distance;
    let forward = (center - position).normalize_or_zero();
    let rotation = if forward == Vec3::ZERO {
        Quat::IDENTITY
    } else {
        Transform::from_translation(position)
            .looking_at(center, Vec3::Y)
            .rotation
    };
    (position, rotation)
}

/// 把 pose 钳制进 limits（非有限值稳定回退）。
pub fn clamp_orbit_pose(pose: &OrbitCameraPose, limits: &OrbitCameraLimits) -> OrbitCameraPose {
    let yaw = if pose.yaw.is_finite() { pose.yaw } else { 0.0 };
    let pitch = if pose.pitch.is_finite() {
        pose.pitch
    } else {
        0.0
    };
    let distance = if pose.distance.is_finite() && pose.distance > 0.0 {
        pose.distance
    } else {
        limits.min_distance
    };
    let pan = if pose.pan.is_finite() {
        pose.pan
    } else {
        Vec3::ZERO
    };
    OrbitCameraPose {
        yaw,
        pitch: pitch.clamp(limits.min_pitch, limits.max_pitch),
        distance: distance.clamp(limits.min_distance, limits.max_distance),
        pan,
    }
}

/// 世界无关的导航命令。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OrbitCameraCommand {
    /// 增加 yaw/pitch（弧度增量）。
    Orbit { delta_yaw: f32, delta_pitch: f32 },
    /// 视平面平移（世界增量）。
    Pan { delta: Vec3 },
    /// 缩放：按乘数调整 distance（<1 推近）。
    Zoom { factor: f32 },
    /// 重置到给定姿态。
    Reset { pose: OrbitCameraPose, target: Vec3 },
}

/// 待应用命令队列（宿主/adapter 投递）。
#[derive(Resource, Default)]
pub struct OrbitCameraCommands {
    pub queue: Vec<(Entity, OrbitCameraCommand)>,
}

impl OrbitCameraCommands {
    pub fn push(&mut self, rig: Entity, command: OrbitCameraCommand) {
        self.queue.push((rig, command));
    }
}

/// 应用命令并钳制姿态。
pub(crate) fn apply_orbit_commands(
    mut commands: ResMut<OrbitCameraCommands>,
    mut rigs: Query<(
        &mut OrbitCameraPose,
        &mut OrbitCameraTarget,
        &OrbitCameraLimits,
        &mut OrbitCameraDerived,
    )>,
) {
    for (rig, command) in std::mem::take(&mut commands.queue) {
        let Ok((mut pose, mut target, limits, mut derived)) = rigs.get_mut(rig) else {
            continue;
        };
        let mut next = *pose;
        match command {
            OrbitCameraCommand::Orbit {
                delta_yaw,
                delta_pitch,
            } => {
                next.yaw += if delta_yaw.is_finite() {
                    delta_yaw
                } else {
                    0.0
                };
                next.pitch += if delta_pitch.is_finite() {
                    delta_pitch
                } else {
                    0.0
                };
            }
            OrbitCameraCommand::Pan { delta } => {
                if delta.is_finite() {
                    next.pan += delta;
                }
            }
            OrbitCameraCommand::Zoom { factor } => {
                let factor = if factor.is_finite() && factor > 0.0 {
                    factor
                } else {
                    1.0
                };
                next.distance *= factor;
            }
            OrbitCameraCommand::Reset {
                pose: reset,
                target: point,
            } => {
                if point.is_finite() {
                    target.point = point;
                }
                next = reset;
            }
        }
        next = clamp_orbit_pose(&next, limits);
        *pose = next;
        let (position, rotation) = derive_orbit_transform(&target, &next);
        derived.position = position;
        derived.rotation = rotation;
    }
}

/// 可安装的 orbit camera 模块。
pub struct OrbitCameraPlugin;

impl Plugin for OrbitCameraPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<OrbitCameraCommands>()
            .add_systems(PostUpdate, (apply_orbit_commands, sync_orbit_rigs).chain());
    }
}

/// 确保每个 orbit rig 拥有实际相机子实体，并把派生姿态写入相机 Transform/Projection。
#[allow(clippy::type_complexity)]
pub(crate) fn sync_orbit_rigs(
    mut commands: Commands,
    mut rigs: Query<(
        Entity,
        &OrbitCameraPose,
        &OrbitCameraTarget,
        &OrbitCameraLens,
        &OrbitCameraLimits,
        Option<&OrbitCameraSuspended>,
        &mut OrbitCameraDerived,
        &mut OrbitCameraInner,
    )>,
) {
    for (entity, pose, target, lens, limits, suspended, mut derived, mut inner) in &mut rigs {
        let clamped = clamp_orbit_pose(pose, limits);
        let (position, rotation) = derive_orbit_transform(target, &clamped);
        derived.position = position;
        derived.rotation = rotation;
        let camera = match inner.camera {
            Some(camera) => camera,
            None => {
                let camera = commands
                    .spawn((
                        Camera3d::default(),
                        Camera::default(),
                        Transform::from_translation(position).with_rotation(rotation),
                        projection_for(lens),
                        OrbitCameraLink(entity),
                    ))
                    .id();
                inner.camera = Some(camera);
                camera
            }
        };
        // 挂起期间宿主自行写相机（过渡 / 正交 home）；插件只保留派生状态。
        if suspended.is_some() {
            continue;
        }
        commands.entity(camera).insert((
            Transform::from_translation(position).with_rotation(rotation),
            projection_for(lens),
        ));
    }
}

fn projection_for(lens: &OrbitCameraLens) -> Projection {
    match lens.projection {
        OrbitProjection::Perspective { fov } => Projection::Perspective(PerspectiveProjection {
            fov: if fov.is_finite() && fov > 0.0 {
                fov
            } else {
                ORBIT_DEFAULT_FOV
            },
            near: lens.near,
            far: lens.far,
            ..default()
        }),
        OrbitProjection::Orthographic { viewport_height } => {
            Projection::Orthographic(OrthographicProjection {
                scaling_mode: bevy::camera::ScalingMode::FixedVertical {
                    viewport_height: if viewport_height.is_finite() && viewport_height > 0.0 {
                        viewport_height
                    } else {
                        1.0
                    },
                },
                near: lens.near,
                far: lens.far,
                ..OrthographicProjection::default_3d()
            })
        }
    }
}

/// 面向调用方的 orbit rig 创建扩展。
pub trait OrbitCameraCommandsExt {
    /// 创建一个 orbit 相机 rig；返回稳定 rig Entity。
    fn spawn_orbit_camera(
        &mut self,
        target: OrbitCameraTarget,
        pose: OrbitCameraPose,
        lens: OrbitCameraLens,
        limits: OrbitCameraLimits,
    ) -> Entity;

    /// 创建一个已绑定既有相机实体的 orbit rig（适配器接管宿主相机时使用）。
    fn spawn_orbit_camera_with_camera(
        &mut self,
        camera: Entity,
        target: OrbitCameraTarget,
        pose: OrbitCameraPose,
        lens: OrbitCameraLens,
        limits: OrbitCameraLimits,
    ) -> Entity;
}

impl OrbitCameraCommandsExt for Commands<'_, '_> {
    fn spawn_orbit_camera(
        &mut self,
        target: OrbitCameraTarget,
        pose: OrbitCameraPose,
        lens: OrbitCameraLens,
        limits: OrbitCameraLimits,
    ) -> Entity {
        let clamped = clamp_orbit_pose(&pose, &limits);
        self.spawn((
            Name::new("orbit-camera"),
            OrbitCameraRig,
            target,
            clamped,
            lens,
            limits,
            OrbitCameraDerived::default(),
            OrbitCameraInner::default(),
        ))
        .id()
    }

    fn spawn_orbit_camera_with_camera(
        &mut self,
        camera: Entity,
        target: OrbitCameraTarget,
        pose: OrbitCameraPose,
        lens: OrbitCameraLens,
        limits: OrbitCameraLimits,
    ) -> Entity {
        let clamped = clamp_orbit_pose(&pose, &limits);
        let rig = self
            .spawn((
                Name::new("orbit-camera"),
                OrbitCameraRig,
                target,
                clamped,
                lens,
                limits,
                OrbitCameraDerived::default(),
                OrbitCameraInner {
                    camera: Some(camera),
                },
            ))
            .id();
        self.entity(camera).insert(OrbitCameraLink(rig));
        rig
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orthographic_height_matches_perspective_center_plane() {
        // 透视在距离 d 处的中心平面可见高度为 2·d·tan(fov/2)，正交视口高度应与之相等，
        // 使卡片预览与聚焦观察镜头在目标平面取景连续。
        let d = 300.0;
        let expected = 2.0 * d * (ORBIT_DEFAULT_FOV * 0.5).tan();
        assert!((orthographic_viewport_height(d, ORBIT_DEFAULT_FOV) - expected).abs() < 1e-3);
    }

    #[test]
    fn orthographic_height_is_monotonic_and_guards_invalid_distance() {
        let fov = ORBIT_DEFAULT_FOV;
        assert!(
            orthographic_viewport_height(400.0, fov) > orthographic_viewport_height(200.0, fov)
        );
        // 非法/非正距离回退为 1.0，不产生 NaN/负值。
        assert!(orthographic_viewport_height(0.0, fov).is_finite());
        assert!(orthographic_viewport_height(f32::NAN, fov) > 0.0);
    }

    #[test]
    fn derive_places_camera_on_orbit_and_looks_at_target() {
        let target = OrbitCameraTarget {
            point: Vec3::new(0.0, 1.0, 0.0),
        };
        let pose = OrbitCameraPose {
            yaw: 0.0,
            pitch: 0.0,
            distance: 10.0,
            pan: Vec3::ZERO,
        };
        let (position, rotation) = derive_orbit_transform(&target, &pose);
        assert!(position.abs_diff_eq(Vec3::new(0.0, 1.0, 10.0), 1e-5));
        let forward = rotation * Vec3::NEG_Z;
        assert!(forward.abs_diff_eq(Vec3::new(0.0, 0.0, -1.0), 1e-5));
    }

    #[test]
    fn clamp_rejects_non_finite_and_bounds() {
        let limits = OrbitCameraLimits::default();
        let pose = OrbitCameraPose {
            yaw: f32::NAN,
            pitch: 10.0,
            distance: -5.0,
            pan: Vec3::new(f32::NAN, 0.0, 0.0),
        };
        let clamped = clamp_orbit_pose(&pose, &limits);
        assert!(
            clamped.yaw.is_finite() && clamped.pitch.is_finite() && clamped.distance.is_finite()
        );
        assert!(clamped.pan.is_finite());
        assert!(clamped.pitch <= limits.max_pitch + 1e-6);
        assert!((clamped.distance - limits.min_distance).abs() < 1e-6);
        assert_eq!(clamped.pan, Vec3::ZERO);
    }

    #[test]
    fn pan_offsets_rotation_center() {
        let target = OrbitCameraTarget { point: Vec3::ZERO };
        let pose = OrbitCameraPose {
            distance: 5.0,
            pan: Vec3::new(2.0, 0.0, 0.0),
            ..default()
        };
        let (position, _) = derive_orbit_transform(&target, &pose);
        assert!((position.x - 2.0).abs() < 1e-5);
    }
}
