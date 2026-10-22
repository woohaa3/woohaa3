//! Shot camera 异步 capture 队列。并发或像素预算满时返回 `Busy`。
//! 统一从 rig 的**临时离屏相机**回读（原生 wgpu 与浏览器 WebGPU 都支持纹理回读），
//! 成片保留请求尺寸；不读窗口、不做裁剪，也不依赖额外帧隐藏 chrome。
//!
//! change: 2026-10-15-add-film-set-shooting-shot-previews —— 浏览器后端从 WebGL2 切到
//! WebGPU 后，离屏 `Screenshot::image` 回读可用，窗口裁剪回退整条路径移除。

use std::collections::HashMap;

use bevy::{
    prelude::*,
    camera::RenderTarget,
    render::view::window::screenshot::{Screenshot, ScreenshotCaptured},
};

use super::capture_types::{
    ShotCaptureEnqueue, ShotCaptureErrorCode, ShotCaptureFailure, ShotCaptureQueue,
    ShotCaptureRequest, ShotCaptureResult, ShotCaptureResults,
};
use super::components::{ShotCameraDerived, ShotCameraLens, ShotCameraViewMask};

/// capture 等待帧数上限（超时后释放并失败）。
const CAPTURE_TIMEOUT_FRAMES: u32 = 240;

/// capture 运行时状态：已提交、等待 observer 回读的作业。
#[derive(Resource, Default)]
pub struct ShotCaptureState {
    /// (camera, request_id) -> 已等待帧数。
    in_flight: HashMap<(Entity, u64), u32>,
    /// (camera, request_id) -> 临时离屏 Image（回读后释放）。
    capture_images: HashMap<(Entity, u64), Handle<Image>>,
}

impl ShotCaptureState {
    pub fn in_flight_len(&self) -> usize {
        self.in_flight.len()
    }
}

/// 取消已销毁 rig 的请求并发布稳定失败；保持队列有界。
pub(crate) fn reconcile_capture_queue(
    mut commands: Commands,
    ready: Res<super::preview_readiness::ShotPreviewReady>,
    cameras: Query<(Entity, &CaptureCamera)>,
    mut queue: ResMut<ShotCaptureQueue>,
    mut results: ResMut<ShotCaptureResults>,
    mut state: ResMut<ShotCaptureState>,
    mut images: ResMut<Assets<Image>>,
    rigs: Query<Entity>,
) {
    let mut dropped: Vec<ShotCaptureRequest> = Vec::new();
    queue
        .active
        .retain(|request| if rigs.get(request.camera).is_ok() { true } else { dropped.push(*request); false });
    let mut kept = std::collections::VecDeque::new();
    while let Some(request) = queue.pending.pop_front() {
        if rigs.get(request.camera).is_ok() {
            kept.push_back(request);
        } else {
            dropped.push(request);
        }
    }
    queue.pending = kept;
    for request in dropped {
        for (entity, camera) in &cameras {
            if camera.camera == request.camera && camera.request_id == request.request_id {
                ready.cancel(entity);
                commands.entity(entity).try_despawn();
            }
        }
        state.in_flight.remove(&(request.camera, request.request_id));
        // rig 已销毁，没有 observer 会再来消费这张离屏 Image，直接释放。
        if let Some(image) = state
            .capture_images
            .remove(&(request.camera, request.request_id))
        {
            images.remove(&image);
        }
        results.push_failure(ShotCaptureFailure {
            camera: request.camera,
            request_id: request.request_id,
            code: ShotCaptureErrorCode::CameraGone,
        });
    }
    promote_pending(&mut queue);
}

/// 把等待项提升到并发槽位。
fn promote_pending(queue: &mut ShotCaptureQueue) {
    while queue.active.len() < queue.max_concurrent {
        let Some(next) = queue.pending.pop_front() else {
            break;
        };
        queue.active.push(next);
    }
}

/// 为 active 且尚未提交的请求提交抓取；generation 不匹配立即稳定失败。
///
/// capture 使用 rig 当前派生 pose 与 view mask 建立**临时**离屏目标与相机（同一帧内建立、
/// readback 后释放），因此 window-target preview 的 rig 也能被捕获，且不长期占用离屏 Image。
/// 成片尺寸就是请求尺寸，不依赖窗口或卡片在屏幕上的大小。
pub(crate) fn submit_pending_captures(
    mut commands: Commands,
    mut images: Option<ResMut<Assets<Image>>>,
    mut queue: ResMut<ShotCaptureQueue>,
    mut state: ResMut<ShotCaptureState>,
    mut results: ResMut<ShotCaptureResults>,
    rigs: Query<(&ShotCameraDerived, &ShotCameraLens, &ShotCameraViewMask, Option<&super::preview_readiness::ShotPreviewReadiness>)>,
    ready: Res<super::preview_readiness::ShotPreviewReady>,
    waiting: Query<(Entity, &CaptureCamera, &AwaitCaptureReadback)>,
    clear: Res<super::ShotPreviewClearColor>,
) {
    // 临时相机先完成自身视图的资产/管线准备与连续两帧绘制，再提交回读。
    // 不能用源 rig 的 preview 就绪代数代替新建 capture 相机的就绪。
    for (entity, camera, pending) in &waiting {
        if ready.matches(entity, pending.0.generation)
            && queue.active.iter().any(|request| request == &pending.0)
        {
            if let Some(image) = state.capture_images.get(&(camera.camera, camera.request_id)) {
                spawn_capture_observer(&mut commands, &pending.0, image.clone());
                commands.entity(entity).remove::<AwaitCaptureReadback>();
                ready.cancel(entity);
            }
        }
    }
    let mut fail: Vec<(ShotCaptureRequest, ShotCaptureErrorCode)> = Vec::new();
    let mut submit: Vec<(ShotCaptureRequest, Handle<Image>)> = Vec::new();
    for request in queue.active.clone() {
        let key = (request.camera, request.request_id);
        if state.in_flight.contains_key(&key) {
            continue;
        }
        let Ok((derived, lens, mask, readiness)) = rigs.get(request.camera) else {
            fail.push((request, ShotCaptureErrorCode::CameraGone));
            continue;
        };
        if request.generation != derived.generation {
            fail.push((request, ShotCaptureErrorCode::StaleGeneration));
            continue;
        }
        let Some(images) = images.as_deref_mut() else {
            fail.push((request, ShotCaptureErrorCode::ReadbackFailed));
            continue;
        };
        let target = create_capture_image(images, request.width, request.height);
        spawn_offscreen_capture_camera(
            &mut commands,
            &request,
            derived,
            lens,
            mask,
            target.clone(),
            clear.0,
            readiness,
        );
        submit.push((request, target));
    }
    for (request, image) in submit {
        state
            .capture_images
            .insert((request.camera, request.request_id), image.clone());
        state.in_flight.insert((request.camera, request.request_id), 0);
    }
    for (request, code) in fail {
        state.in_flight.remove(&(request.camera, request.request_id));
        queue.complete(&request);
        results.push_failure(ShotCaptureFailure {
            camera: request.camera,
            request_id: request.request_id,
            code,
        });
    }
    promote_pending(&mut queue);
}

/// 建立一次性的 capture 相机与离屏 Image（readback 后由 observer 释放）。
fn spawn_offscreen_capture_camera(
    commands: &mut Commands,
    request: &ShotCaptureRequest,
    derived: &ShotCameraDerived,
    lens: &ShotCameraLens,
    mask: &ShotCameraViewMask,
    target: Handle<Image>,
    clear: Color,
    readiness: Option<&super::preview_readiness::ShotPreviewReadiness>,
) {
    let mut clear = clear;
    clear.set_alpha(1.0);
    let entity = commands.spawn((
        Camera3d::default(),
        // Bevy's multidraw instance counts are private. The readiness gate
        // checks every visible mesh against CPU-readable phase bins, so keep
        // this short-lived readback view on direct drawing. Readiness-gated
        // previews use the same policy; other views retain indirect drawing.
        bevy::render::view::NoIndirectDrawing,
        Camera {
            clear_color: ClearColorConfig::Custom(clear),
            order: 10,
            ..default()
        },
        RenderTarget::Image(target.into()),
        mask.0.clone().without(super::SHOT_GIZMO_LAYER),
        Transform::from_translation(derived.position).looking_at(derived.focus, Vec3::Y),
        lens.projection(),
        bevy::render::view::Tonemapping::None,
        CaptureCamera {
            camera: request.camera,
            request_id: request.request_id,
        },
        AwaitCaptureReadback(*request),
    )).id();
    commands.entity(entity).insert(super::preview_readiness::ShotPreviewView {
        key: entity,
        generation: request.generation,
        meshes: readiness.map(|value| value.meshes.clone()).unwrap_or_default(),
        materials: readiness.map(|value| value.materials.clone()).unwrap_or_default(),
    });
}

#[derive(Component)]
pub(crate) struct AwaitCaptureReadback(ShotCaptureRequest);

/// 标记一次 capture 作业建立的临时相机（observer 完成后释放）。
#[derive(Component, Clone, Copy)]
pub(crate) struct CaptureCamera {
    pub(crate) camera: Entity,
    pub(crate) request_id: u64,
}

/// 建立离屏 capture Image。
fn create_capture_image(images: &mut Assets<Image>, width: u32, height: u32) -> Handle<Image> {
    super::capture_image::create_capture_image(images, width, height)
}

/// 处理超时：释放资源并发布失败，不发布迟到成功。
pub(crate) fn tick_capture_timeouts(
    ready: Res<super::preview_readiness::ShotPreviewReady>,
    mut commands: Commands,
    mut images: ResMut<Assets<Image>>,
    mut queue: ResMut<ShotCaptureQueue>,
    mut state: ResMut<ShotCaptureState>,
    mut results: ResMut<ShotCaptureResults>,
    cameras: Query<(Entity, &CaptureCamera, Option<&AwaitCaptureReadback>)>,
) {
    let expired: Vec<(Entity, u64)> = state
        .in_flight
        .iter_mut()
        .filter_map(|(key, frames)| {
            *frames += 1;
            (*frames > CAPTURE_TIMEOUT_FRAMES).then_some(*key)
        })
        .collect();
    for (camera, request_id) in expired {
        state.in_flight.remove(&(camera, request_id));
        if let Some(image) = state.capture_images.remove(&(camera, request_id)) {
            images.remove(&image);
        }
        let mut code = ShotCaptureErrorCode::ReadbackTimeout;
        for (entity, capture, waiting) in &cameras {
            if capture.camera == camera && capture.request_id == request_id {
                if waiting.is_some() {
                    code = ShotCaptureErrorCode::ReadinessTimeout;
                }
                ready.cancel(entity);
                commands.entity(entity).try_despawn();
            }
        }
        queue
            .active
            .retain(|entry| entry.camera != camera || entry.request_id != request_id);
        results.push_failure(ShotCaptureFailure {
            camera,
            request_id,
            code,
        });
        promote_pending(&mut queue);
    }
}

/// 提交一次抓取 observer（完成后写入结果或失败，并释放临时相机）。
///
/// 统一回读离屏 Image：原生 wgpu 与浏览器 WebGPU 都支持 `copy_texture_to_buffer`，
/// 成片保留请求尺寸，因此不再需要窗口抓取与 CSS 矩形裁剪。
fn spawn_capture_observer(
    commands: &mut Commands,
    request: &ShotCaptureRequest,
    image: Handle<Image>,
) {
    let request = *request;
    commands.spawn(Screenshot::image(image)).observe(
        move |trigger: On<ScreenshotCaptured>,
              mut commands: Commands,
              mut images: ResMut<Assets<Image>>,
              mut queue: ResMut<ShotCaptureQueue>,
              mut results: ResMut<ShotCaptureResults>,
              mut state: ResMut<ShotCaptureState>,
              cameras: Query<(Entity, &CaptureCamera)>,
              ready: Res<super::preview_readiness::ShotPreviewReady>| {
            for (entity, camera) in &cameras {
                if camera.camera == request.camera && camera.request_id == request.request_id {
                    ready.cancel(entity);
                    commands.entity(entity).try_despawn();
                }
            }
            finish_capture(&request, trigger, &mut queue, &mut results, &mut state, &mut images);
        },
    );
}

/// 抓取完成：校验尺寸/格式，发布成功或失败；释放 staging 引用。
fn finish_capture(
    request: &ShotCaptureRequest,
    trigger: On<ScreenshotCaptured>,
    queue: &mut ShotCaptureQueue,
    results: &mut ShotCaptureResults,
    state: &mut ShotCaptureState,
    images: &mut Assets<Image>,
) {
    state.in_flight.remove(&(request.camera, request.request_id));
    if let Some(image) = state
        .capture_images
        .remove(&(request.camera, request.request_id))
    {
        images.remove(&image);
    }
    queue.complete(request);
    promote_pending(queue);
    let image = &trigger.image;
    let width = image.texture_descriptor.size.width;
    let height = image.texture_descriptor.size.height;
    let Some(rgba) = rgba_from_image(image, width, height) else {
        results.push_failure(ShotCaptureFailure {
            camera: request.camera,
            request_id: request.request_id,
            code: ShotCaptureErrorCode::EmptyImage,
        });
        return;
    };
    results.push_result(ShotCaptureResult {
        camera: request.camera,
        request_id: request.request_id,
        generation: request.generation,
        width,
        height,
        rgba,
    });
}

/// 从 `ScreenshotCaptured` 的 Image 提取 RGBA；处理 BGRA 交换与行填充。
pub use super::capture_image::rgba_from_image;

/// 排队一次 capture 请求，返回 request id 与排队结果。
pub fn request_capture(
    queue: &mut ShotCaptureQueue,
    results: &mut ShotCaptureResults,
    camera: Entity,
    width: u32,
    height: u32,
    generation: u64,
) -> (u64, ShotCaptureEnqueue) {
    let request_id = results.next_request_id();
    let request = ShotCaptureRequest {
        camera,
        request_id,
        width,
        height,
        generation,
    };
    let outcome = queue.enqueue(request);
    (request_id, outcome)
}
