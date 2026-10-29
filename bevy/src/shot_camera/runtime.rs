//! Shot camera rig 派生与 preview 输出推进
//! （change: add-reusable-bevy-shot-camera，任务 2.1–2.5 / design D2/D3/D5）。
//!
//! 本模块拥有 rig 的运行时输出推进：由 pose/target/aspect 派生 `Camera3d` 与世界 transform、
//! 为启用 preview 的 rig 维护持久 render-target `Image`。子资源创建/释放与就绪转发在
//! [`super::lifecycle`]。静止帧不重复遍历 mesh 顶点、不重建相机、不重新分配 Image。

use bevy::{camera::RenderTarget, prelude::*};

use super::components::{
    PreviewUpdatePolicy, ShotCameraDerived, ShotCameraEditable, ShotCameraId, ShotCameraLens,
    ShotCameraPose, ShotCameraTarget, ShotCameraViewMask, resolve_derived,
};
use super::lifecycle::{
    cleanup_shot_camera_inner, collapse_window_preview_cameras, create_preview_image,
    publish_preview_readiness, release_preview,
};
use super::preview_types::{
    CallerViewport, PreviewTarget, ShotCameraPreview, ShotPreviewBudget, ShotPreviewClearColor,
    ShotPreviewOutput, ShotPreviewViewport, plan_preview_updates, preview_viewport_rect,
    resolve_caller_viewport, viewport_from_css,
};
use super::{ShotCameraInner, ShotPreviewCamera, TriggerShotPreview};

/// 系统集：隐藏的转换与生命周期顺序。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ShotCameraSet {
    /// 应用 pose/target 变化并推进 dirty/generation。
    Derive,
    /// 创建/更新/释放 preview 相机与 Image。
    Preview,
    /// 提交/推进 capture 作业（在 Preview 之后，保证读取最新 generation）。
    Capture,
    /// 派生/刷新 gizmo 视图。
    Gizmo,
    /// 应用编辑命令。
    Edit,
    /// 清理失效 rig 的子资源。
    Cleanup,
    /// 汇总诊断计数（必须最后运行）。
    Diagnostics,
}

/// 可安装的 shot camera 模块。
pub struct ShotCameraPlugin;

impl Plugin for ShotCameraPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ShotCameraRegistry>()
            .init_resource::<ShotPreviewBudget>()
            .init_resource::<super::ShotPreviewViewport>()
            .init_resource::<super::ShotPreviewClearColor>()
            .init_resource::<super::ShotGizmoSelection>()
            .init_resource::<super::ShotGizmoAssets>()
            .init_resource::<super::edit_types::ShotEditSessions>()
            .init_resource::<super::ShotCaptureQueue>()
            .init_resource::<super::ShotCaptureResults>()
            .init_resource::<super::ShotCameraDiagnosticsOutbox>()
            .init_resource::<super::capture::ShotCaptureState>()
            .init_resource::<super::edit::ShotEditCommands>()
            .add_message::<TriggerShotPreview>()
            .add_message::<super::ShotCameraEditCommitted>()
            .add_message::<super::ShotCameraPreviewChanged>()
            .add_systems(
                PostUpdate,
                (
                    derive_shot_camera_rigs.in_set(ShotCameraSet::Derive),
                    sync_preview_targets.in_set(ShotCameraSet::Preview),
                    publish_preview_readiness
                        .in_set(ShotCameraSet::Preview)
                        .after(sync_preview_targets),
                    collapse_window_preview_cameras.in_set(ShotCameraSet::Preview),
                    super::gizmo::sync_shot_gizmos.in_set(ShotCameraSet::Gizmo),
                    super::edit::apply_edit_commands.in_set(ShotCameraSet::Edit),
                    (
                        super::capture::reconcile_capture_queue,
                        super::capture::submit_pending_captures,
                        super::capture::tick_capture_timeouts,
                    )
                        .chain()
                        .in_set(ShotCameraSet::Capture),
                    cleanup_shot_camera_inner.in_set(ShotCameraSet::Cleanup),
                    super::gizmo::cleanup_orphan_shot_gizmos.in_set(ShotCameraSet::Cleanup),
                    super::components::update_shot_camera_diagnostics
                        .in_set(ShotCameraSet::Diagnostics),
                )
                    .chain(),
            );
        super::preview_readiness::install(app);
    }
}

/// 已分配 rig id 的单调计数器与活动 rig 列表。
#[derive(Resource, Default)]
pub struct ShotCameraRegistry {
    pub next_id: u64,
    pub rigs: Vec<Entity>,
}

impl ShotCameraRegistry {
    pub fn allocate_id(&mut self) -> u64 {
        self.next_id = self.next_id.wrapping_add(1);
        self.next_id
    }
}

/// 确保 rig 拥有稳定 `ShotCameraId` 与内部子资源容器。
fn ensure_rig_identity(commands: &mut Commands, registry: &mut ShotCameraRegistry, entity: Entity) {
    if !registry.rigs.contains(&entity) {
        let id = registry.allocate_id();
        registry.rigs.push(entity);
        commands
            .entity(entity)
            .insert((ShotCameraId(id), ShotCameraInner::default()));
    }
}

/// 应用 pose/target/lens/preview 变化并推进 dirty/generation。
///
/// 只在签名变化时重新派生；静止帧不重复计算。目标根平移变化也会触发重新派生。
#[allow(clippy::type_complexity)]
pub(crate) fn derive_shot_camera_rigs(
    mut commands: Commands,
    mut registry: ResMut<ShotCameraRegistry>,
    mut frames: Query<(
        Entity,
        &ShotCameraPose,
        &ShotCameraLens,
        &ShotCameraTarget,
        &ShotCameraViewMask,
        &ShotCameraEditable,
        Option<&ShotCameraPreview>,
        &mut ShotCameraDerived,
    )>,
    transforms: Query<&GlobalTransform>,
    mut preview_changed: MessageWriter<super::ShotCameraPreviewChanged>,
) {
    for (entity, pose, lens, target, _mask, _editable, preview, mut derived) in &mut frames {
        ensure_rig_identity(&mut commands, &mut registry, entity);
        let fallback = target
            .subject_roots
            .first()
            .and_then(|root| transforms.get(*root).ok())
            .map(|transform| transform.translation());
        let signature = pose_signature(pose, lens, target, preview, fallback);
        if !derived.dirty && derived.signature == signature {
            continue;
        }
        let Some(frame) = resolve_derived(pose, target, lens.aspect, fallback) else {
            continue;
        };
        let changed = derived.signature != signature;
        derived.signature = signature;
        derived.dirty = false;
        derived.position = frame.position;
        derived.focus = frame.focus;
        derived.fov = frame.fov;
        if changed {
            derived.generation = derived.generation.wrapping_add(1);
            preview_changed.write(super::ShotCameraPreviewChanged {
                camera: entity,
                generation: derived.generation,
            });
        }
    }
}

/// 派生签名：pose/lens/target bounds/根平移/preview size 的稳定摘要。
fn pose_signature(
    pose: &ShotCameraPose,
    lens: &ShotCameraLens,
    target: &ShotCameraTarget,
    preview: Option<&ShotCameraPreview>,
    fallback: Option<Vec3>,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    pose.azimuth.to_bits().hash(&mut hasher);
    pose.elevation.to_bits().hash(&mut hasher);
    pose.distance.to_bits().hash(&mut hasher);
    for value in pose.focus_offset.to_array() {
        value.to_bits().hash(&mut hasher);
    }
    lens.aspect.to_bits().hash(&mut hasher);
    match &target.bounds {
        Some(bounds) => {
            for value in bounds
                .min
                .to_array()
                .into_iter()
                .chain(bounds.max.to_array())
            {
                value.to_bits().hash(&mut hasher);
            }
        }
        None => 0u8.hash(&mut hasher),
    }
    if let Some(center) = target.center {
        for value in center.to_array() {
            value.to_bits().hash(&mut hasher);
        }
    }
    if let Some(radius) = target.radius {
        radius.to_bits().hash(&mut hasher);
    }
    if let Some(fallback) = fallback {
        for value in fallback.to_array() {
            value.to_bits().hash(&mut hasher);
        }
    }
    if let Some(preview) = preview {
        preview.size.hash(&mut hasher);
        preview.active.hash(&mut hasher);
    }
    hasher.finish()
}

/// 为启用 preview 的 rig 创建/更新 preview 相机（离屏 Image 或主窗口 viewport）。
///
/// 预算内才推进 render pass；超额保持 dirty 到后续帧（有界，不无界创建资源）。
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
pub(crate) fn sync_preview_targets(
    mut commands: Commands,
    mut images: Option<ResMut<Assets<Image>>>,
    budget: Res<ShotPreviewBudget>,
    viewport: Res<ShotPreviewViewport>,
    clear: Res<ShotPreviewClearColor>,
    mut trigger: MessageReader<TriggerShotPreview>,
    windows: Query<(&Window, &bevy::window::PrimaryWindow)>,
    mut camera_query: Query<(&mut Camera, &mut bevy::camera::visibility::RenderLayers)>,
    mut rigs: Query<(
        Entity,
        &ShotCameraDerived,
        &ShotCameraLens,
        &ShotCameraViewMask,
        &ShotCameraPreview,
        &mut ShotCameraInner,
        Option<&ShotPreviewOutput>,
    )>,
) {
    let forced: Vec<Entity> = trigger.read().map(|event| event.camera).collect();
    let surface = if viewport.surface.x > 0.0 {
        viewport.surface
    } else {
        windows
            .iter()
            .next()
            .map(|(window, _)| Vec2::new(window.width(), window.height()))
            .unwrap_or(Vec2::new(1.0, 1.0))
    };
    let physical = windows
        .iter()
        .next()
        .map(|(window, _)| UVec2::new(window.physical_width(), window.physical_height()))
        .unwrap_or(UVec2::ONE);
    // 先收集本轮需要渲染的 dirty rig，按预算排序；超额保持 dirty 到后续帧。
    let mut dirty: Vec<(Entity, u32, u32)> = Vec::new();
    for (entity, derived, _lens, _mask, preview, inner, output) in &rigs {
        if !preview.active {
            continue;
        }
        let rendered = output.map(|output| output.generation).unwrap_or(u64::MAX);
        let has_camera = inner.preview_camera.is_some();
        let needs = match preview.policy {
            PreviewUpdatePolicy::Continuous => true,
            PreviewUpdatePolicy::OnDirty => {
                rendered != derived.generation
                    || !has_camera
                    || (preview.target == PreviewTarget::Offscreen && inner.preview_image.is_none())
            }
            PreviewUpdatePolicy::Manual => forced.contains(&entity),
        };
        if needs {
            dirty.push((entity, preview.size.x, preview.size.y));
        }
    }
    let selected = plan_preview_updates(&dirty, &budget);

    for (entity, derived, lens, mask, preview, mut inner, output) in &mut rigs {
        if !preview.active {
            if let Some(images) = images.as_deref_mut() {
                release_preview(&mut commands, images, &mut inner);
            } else {
                if let Some(camera) = inner.preview_camera.take() {
                    commands.entity(camera).try_despawn();
                }
            }
            commands.entity(entity).remove::<ShotPreviewOutput>();
            continue;
        }
        let offscreen = preview.target == PreviewTarget::Offscreen;
        let needs_realloc = inner.preview_camera.is_none()
            || (offscreen
                && (inner.preview_image.is_none()
                    || output.is_none_or(|output| output.size != preview.size)));
        if needs_realloc {
            if let Some(images) = images.as_deref_mut() {
                release_preview(&mut commands, images, &mut inner);
            } else if let Some(camera) = inner.preview_camera.take() {
                commands.entity(camera).try_despawn();
            }
            let (target, image) = if offscreen {
                let Some(images) = images.as_deref_mut() else {
                    continue;
                };
                let image = create_preview_image(images, preview.size);
                (RenderTarget::Image(image.clone().into()), Some(image))
            } else {
                (RenderTarget::Window(bevy::window::WindowRef::Primary), None)
            };
            let camera = commands
                .spawn((
                    Camera3d::default(),
                    Camera {
                        clear_color: ClearColorConfig::Custom(
                            preview.clear_color.unwrap_or(clear.0),
                        ),
                        order: 5,
                        is_active: false,
                        ..default()
                    },
                    target,
                    mask.0.clone().without(super::SHOT_GIZMO_LAYER),
                    Transform::from_translation(derived.position)
                        .looking_at(derived.focus, Vec3::Y),
                    lens.projection(),
                    bevy::render::view::Tonemapping::None,
                    bevy::render::view::DebandDither::Disabled,
                    ShotPreviewCamera { rig: entity },
                ))
                .id();
            inner.preview_camera = Some(camera);
            inner.preview_image = image.clone();
            if let Some(image) = image {
                commands.entity(entity).insert(ShotPreviewOutput {
                    image,
                    size: preview.size,
                    generation: derived.generation,
                });
            } else {
                commands.entity(entity).remove::<ShotPreviewOutput>();
            }
            continue;
        }
        let Some(camera) = inner.preview_camera else {
            continue;
        };
        let should_render =
            selected.contains(&entity) || preview.policy == PreviewUpdatePolicy::Continuous;
        let caller = resolve_caller_viewport(viewport.rect);
        let suspended = viewport.hold || matches!(caller, CallerViewport::Invalid);
        // 只改必要的字段（is_active / viewport / transform / projection）；不得整体覆盖 `Camera`，
        // 否则会重置 clear_color、order 与 target，导致窗口 viewfinder 变透明或被主相机覆盖。
        if let Ok((mut camera_component, mut layers)) = camera_query.get_mut(camera) {
            camera_component.is_active = should_render && !suspended;
            camera_component.clear_color =
                ClearColorConfig::Custom(preview.clear_color.unwrap_or(clear.0));
            // Existing offscreen rigs can move to another card layer without reallocating Image.
            *layers = mask.0.clone().without(super::SHOT_GIZMO_LAYER);
            if !offscreen {
                if suspended {
                    camera_component.is_active = false;
                    camera_component.viewport = None;
                } else {
                    let rect = match caller {
                        CallerViewport::Valid(rect) => rect,
                        _ => preview_viewport_rect(surface, lens.aspect),
                    };
                    let (position, size) = viewport_from_css(rect, viewport.pixel_ratio);
                    let mut camera_viewport = bevy::camera::Viewport {
                        physical_position: position,
                        physical_size: size,
                        ..default()
                    };
                    camera_viewport.clamp_to_size(physical);
                    camera_component.viewport = Some(camera_viewport);
                    // 左下角是 rig 自己的视角：不透明清屏，避免观察相机从预览框透出来。
                    let mut color = preview.clear_color.unwrap_or(clear.0);
                    color.set_alpha(1.0);
                    camera_component.clear_color = ClearColorConfig::Custom(color);
                }
            }
        }
        commands.entity(camera).insert((
            Transform::from_translation(derived.position).looking_at(derived.focus, Vec3::Y),
            lens.projection(),
        ));
        // 更新公开的 generation（无需重建 Image/camera）。
        if let Some(output) = output
            && output.generation != derived.generation
        {
            commands.entity(entity).insert(ShotPreviewOutput {
                image: output.image.clone(),
                size: output.size,
                generation: derived.generation,
            });
        }
        // Continuous 每帧推进；选中帧推进；其余保持（不重复渲染）。
        if should_render {
            inner.rendered_generation = derived.generation;
        }
    }
}
