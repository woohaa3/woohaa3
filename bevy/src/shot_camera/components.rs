//! Shot camera 公共组件与运行时类型
//! （change: add-reusable-bevy-shot-camera，任务 1.1 / design D1）。
//!
//! 调用方通过 [`super::ShotCameraCommands::spawn_shot_camera`] 创建一个 rig entity，并持有
//! 其 `Entity` 作为稳定运行时身份。实际 `Camera3d`、render target、gizmo 与 capture 作业是
//! 由 rig identity 索引的**内部**子实体/资源；调用方不得依赖其布局。
//!
//! 本模块不依赖 canvas protocol、wasm bridge、DOM、Y.Doc 或 CanvasCommand。

use bevy::{
    prelude::*,
    camera::visibility::RenderLayers,
};

use super::framing::{Aabb, FramedShotCamera};
use super::constants::MAX_PREVIEW_DIMENSION;
use super::preview_types::ShotCameraPreview;

/// 默认透视相机 near（极小，见 change: switch-shot-camera-to-perspective）。
pub const SHOT_CAMERA_NEAR: f32 = 0.001;
/// 默认透视相机 far。
pub const SHOT_CAMERA_FAR: f32 = 100_000.0;
/// rig 的离散编辑轴（与输入设备无关）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShotCameraAxis {
    /// 方位环拖动：修改 azimuth。
    Orbit,
    /// 竖直半圆拖动：修改 elevation（change: add-shot-camera-elevation-control）。
    Elevation,
    /// 距离段拖动：修改 distance。
    Distance,
    /// 焦点三轴拖动：修改 focus_offset。
    Focus,
}

/// 焦点轴分量（世界坐标）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FocusComponent {
    X,
    Y,
    Z,
}

/// preview 更新策略。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PreviewUpdatePolicy {
    /// 每帧都渲染（受预算约束）。
    Continuous,
    /// 仅在 pose/lens/target/size 变化时渲染一次（默认）。
    #[default]
    OnDirty,
    /// 只有显式请求才渲染。
    Manual,
}

/// 镜头姿态（持久化/可变字段）。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct ShotCameraPose {
    pub azimuth: f32,
    pub elevation: f32,
    pub distance: f32,
    /// 相对目标 AABB 中心的注视点偏移。
    pub focus_offset: Vec3,
}

impl Default for ShotCameraPose {
    fn default() -> Self {
        Self {
            azimuth: 0.0,
            elevation: super::framing::SHOT_CAMERA_ELEVATION,
            distance: 1.0,
            focus_offset: Vec3::ZERO,
        }
    }
}

impl ShotCameraPose {
    /// 构造合法 pose；非有限值回退默认。仰角跟随画布全局 pitch。
    pub fn new(azimuth: f32, distance: f32) -> Self {
        Self {
            azimuth: if azimuth.is_finite() { azimuth } else { 0.0 },
            elevation: super::framing::SHOT_CAMERA_ELEVATION,
            distance: if distance.is_finite() && distance > 0.0 {
                distance
            } else {
                1.0
            },
            focus_offset: Vec3::ZERO,
        }
    }

    /// 构造带显式仰角的合法 pose；非有限值回退默认。
    pub fn with_elevation(azimuth: f32, elevation: f32, distance: f32) -> Self {
        let mut pose = Self::new(azimuth, distance);
        pose.elevation = super::framing::clamp_shot_elevation(elevation);
        pose
    }

    pub fn with_focus_offset(mut self, offset: Vec3) -> Self {
        self.focus_offset = offset;
        self
    }
}

/// 镜头光学参数（透视投影；change: switch-shot-camera-to-perspective）。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct ShotCameraLens {
    /// 宽高比（宽 / 高）。
    pub aspect: f32,
    /// 垂直 FOV（弧度）。
    pub fov: f32,
    pub near: f32,
    pub far: f32,
}

impl Default for ShotCameraLens {
    fn default() -> Self {
        Self {
            aspect: 16.0 / 9.0,
            fov: super::framing::SHOT_CAMERA_FOV,
            near: SHOT_CAMERA_NEAR,
            far: SHOT_CAMERA_FAR,
        }
    }
}

impl ShotCameraLens {
    pub fn from_aspect(aspect: f32) -> Self {
        let aspect = if aspect > 0.0 && aspect.is_finite() {
            aspect
        } else {
            16.0 / 9.0
        };
        Self {
            aspect,
            ..Default::default()
        }
    }

    /// 透视投影（与聚焦观察相机一致；change: switch-shot-camera-to-perspective）。
    pub fn projection(&self) -> Projection {
        Projection::Perspective(PerspectiveProjection {
            fov: if self.fov.is_finite() && self.fov > 0.0 && self.fov < std::f32::consts::PI {
                self.fov
            } else {
                super::framing::SHOT_CAMERA_FOV
            },
            near: self.near,
            far: self.far,
            ..default()
        })
    }
}

/// 镜头目标：subject 根实体与显式取景 AABB。
///
/// `subject_roots` 用于聚合 AABB 与校验目标生命周期；`bounds` 为宿主投影的当前有效世界
/// AABB（含 placement/动画结果）。`bounds` 缺失时回退为 subject 根平移的退化 AABB。
///
/// 宿主也可直接给出 `center`/`radius` 覆盖值（例如事件驱动地在模型内容变化时预计算包围球），
/// 此时不依赖逐帧遍历 mesh 顶点。`center`/`radius` 优先于 `bounds`。
#[derive(Component, Clone, Debug, Default)]
pub struct ShotCameraTarget {
    pub subject_roots: Vec<Entity>,
    pub bounds: Option<Aabb>,
    pub center: Option<Vec3>,
    pub radius: Option<f32>,
}

impl ShotCameraTarget {
    pub fn from_bounds(bounds: Aabb) -> Self {
        Self {
            subject_roots: Vec::new(),
            bounds: Some(bounds),
            center: None,
            radius: None,
        }
    }

    /// 更新宿主预计算的中心/包围球半径（不触发 mesh 遍历）。
    pub fn set_center_radius(&mut self, center: Vec3, radius: f32) {
        self.center = Some(center);
        self.radius = Some(radius);
    }

    pub fn with_subject(mut self, root: Entity) -> Self {
        self.subject_roots.push(root);
        self
    }
}

/// 镜头可见性 mask：显式 render layer 分组，由宿主提供。
///
/// 模块不隐式重写全场景 layer；多个镜头拍摄同一模型集合时共享同一 mask。
#[derive(Component, Clone, Debug)]
pub struct ShotCameraViewMask(pub RenderLayers);

impl Default for ShotCameraViewMask {
    fn default() -> Self {
        Self(RenderLayers::layer(0))
    }
}

/// 镜头可编辑开关；禁用时编辑命令被拒绝。
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct ShotCameraEditable {
    pub enabled: bool,
}

/// rig 派生的运行时姿态（由 framing 数学写入）。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub struct ShotCameraDerived {
    pub position: Vec3,
    pub focus: Vec3,
    /// 派生透视垂直 FOV（弧度）；change: switch-shot-camera-to-perspective。
    pub fov: f32,
    /// 本帧是否需要重新派生（避免静止帧重复计算/分配）。
    pub dirty: bool,
    /// preview generation；pose/lens/target/size 变化时推进。
    pub generation: u64,
    /// 上一次派生的输入签名（用于跳过静止帧）。
    pub signature: u64,
}

impl Default for ShotCameraDerived {
    fn default() -> Self {
        Self {
            position: Vec3::ZERO,
            focus: Vec3::ZERO,
            fov: super::framing::SHOT_CAMERA_FOV,
            dirty: true,
            generation: 0,
            signature: 0,
        }
    }
}

/// rig 的稳定标识（诊断用，不参与布局）。
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ShotCameraId(pub u64);

/// 运行时诊断快照（供宿主/Showcase 观察公开资源计数）。
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ShotCameraDiagnostics {
    /// 活动 rig 数。
    pub rigs: u32,
    /// render-target preview Image 数。
    pub preview_images: u32,
    /// gizmo 子实体数。
    pub gizmo_entities: u32,
    /// capture 进行中作业数。
    pub captures_in_flight: u32,
    /// capture 队列长度（active + pending）。
    pub captures_queued: u32,
}

/// 诊断快照 outbox（由系统写入，宿主/Showcase 读取；不进入 canonical 状态）。
#[derive(Resource, Default)]
pub struct ShotCameraDiagnosticsOutbox(pub ShotCameraDiagnostics);

/// 每帧汇总诊断计数。
#[allow(clippy::type_complexity)]
pub(crate) fn update_shot_camera_diagnostics(
    registry: Res<super::ShotCameraRegistry>,
    rigs: Query<&super::ShotCameraInner>,
    queue: Res<super::ShotCaptureQueue>,
    capture_state: Res<super::capture::ShotCaptureState>,
    mut outbox: ResMut<ShotCameraDiagnosticsOutbox>,
) {
    let mut preview_images = 0;
    let mut gizmo_entities = 0;
    for inner in &rigs {
        if inner.preview_image.is_some() {
            preview_images += 1;
        }
        gizmo_entities += inner.gizmo.entities.len() as u32;
    }
    outbox.0 = ShotCameraDiagnostics {
        rigs: registry.rigs.len() as u32,
        preview_images,
        gizmo_entities,
        captures_in_flight: capture_state.in_flight_len() as u32,
        captures_queued: queue.len() as u32,
    };
}

/// rig 配置失败时的稳定禁用/错误状态（避免留下部分资源）。
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub enum ShotCameraError {
    /// target bounds 非法（非有限）。
    InvalidBounds,
    /// preview/capture 尺寸越界。
    InvalidSize,
    /// pose/distance 非法。
    InvalidPose,
    /// 缺少 target 组件。
    MissingTarget,
}

impl ShotCameraError {
    /// 稳定错误码。
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidBounds => "invalid-bounds",
            Self::InvalidSize => "invalid-size",
            Self::InvalidPose => "invalid-pose",
            Self::MissingTarget => "missing-target",
        }
    }
}

/// 创建 rig 的配置（供 `spawn_shot_camera` 使用）。
#[derive(Clone, Debug)]
pub struct ShotCameraConfig {
    pub pose: ShotCameraPose,
    pub lens: ShotCameraLens,
    pub target: ShotCameraTarget,
    pub view_mask: ShotCameraViewMask,
    pub preview: Option<ShotCameraPreview>,
    pub editable: bool,
}

impl Default for ShotCameraConfig {
    fn default() -> Self {
        Self {
            pose: ShotCameraPose::default(),
            lens: ShotCameraLens::default(),
            target: ShotCameraTarget::default(),
            view_mask: ShotCameraViewMask::default(),
            preview: Some(ShotCameraPreview::default()),
            editable: true,
        }
    }
}

impl ShotCameraConfig {
    pub fn from_bounds(bounds: Aabb) -> Self {
        Self {
            target: ShotCameraTarget::from_bounds(bounds),
            ..Default::default()
        }
    }

    /// 校验配置；返回稳定错误（创建失败时应完整拒绝，不留部分实体）。
    pub fn validate(&self) -> Result<(), ShotCameraError> {
        if let Some(bounds) = &self.target.bounds
            && !bounds.is_finite()
        {
            return Err(ShotCameraError::InvalidBounds);
        }
        if !self.pose.azimuth.is_finite()
            || !self.pose.distance.is_finite()
            || self.pose.distance <= 0.0
        {
            return Err(ShotCameraError::InvalidPose);
        }
        if !self.lens.aspect.is_finite() || self.lens.aspect <= 0.0 {
            return Err(ShotCameraError::InvalidSize);
        }
        if let Some(preview) = &self.preview
            && (preview.size.x == 0
                || preview.size.y == 0
                || preview.size.x > MAX_PREVIEW_DIMENSION
                || preview.size.y > MAX_PREVIEW_DIMENSION)
        {
            return Err(ShotCameraError::InvalidSize);
        }
        Ok(())
    }
}

/// 由 pose/target/aspect 计算完整派生姿态。
pub fn resolve_derived(
    pose: &ShotCameraPose,
    target: &ShotCameraTarget,
    aspect: f32,
    fallback_translation: Option<Vec3>,
) -> Option<FramedShotCamera> {
    if let (Some(center), Some(radius)) = (target.center, target.radius) {
        return Some(super::framing::resolve_from_center_radius(
            center,
            radius,
            pose.azimuth,
            pose.elevation,
            pose.distance,
            aspect,
            pose.focus_offset,
        ));
    }
    let bounds = target.bounds.or_else(|| {
        fallback_translation.map(|translation| Aabb::new(translation, translation))
    })?;
    super::framing::resolve_shot_camera(
        &bounds,
        pose.azimuth,
        pose.elevation,
        pose.distance,
        aspect,
        pose.focus_offset,
    )
}

/// 面向调用方的 rig 创建/更新/销毁扩展。
pub trait ShotCameraCommands {
    /// 创建一个 shot camera rig；返回稳定 rig Entity。
    fn spawn_shot_camera(&mut self, config: ShotCameraConfig) -> Entity;
}

impl ShotCameraCommands for Commands<'_, '_> {
    fn spawn_shot_camera(&mut self, config: ShotCameraConfig) -> Entity {
        let error = config.validate().err();
        let pose = config.pose;
        let entity = self
            .spawn((
                Name::new("shot-camera"),
                pose,
                config.lens,
                config.target,
                config.view_mask,
                ShotCameraEditable {
                    enabled: config.editable,
                },
                ShotCameraDerived::default(),
            ))
            .id();
        if let Some(error) = error {
            self.entity(entity).insert(error);
            return entity;
        }
        if let Some(preview) = config.preview {
            self.entity(entity).insert(preview);
        }
        entity
    }
}

