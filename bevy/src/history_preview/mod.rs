//! 页面内模型历史缩略图：同一 Bevy App 内的一次性离屏渲染
//! （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
//!
//! 历史卡片不再下载服务端 PNG：调用方把服务端权威脚本派生出的 Scene IR（V2）连同稳定
//! `requestId` / `generation` 交给本模块。模块在**既有 App** 里：
//!
//! 1. 从共享预览层池租一个层（不与模型卡片/镜头卡片撞层）；
//! 2. 在该层上建一次性模型根 + 一次性离屏相机（`RenderTarget::Image`）；
//! 3. 复用模型预览卡片的就绪门禁（`model_preview::PreviewView`）等到真实绘制完成；
//! 4. 用 `Screenshot::image` 回读 RGBA，立即拆实体、释放图像与层租约。
//!
//! 不新建 Bevy App、WebGL/WebGPU context、第二个 canvas 或模型副本，也不写规范状态。
//! 作业严格串行（一个在飞），迟到的结果按 `(requestId, generation)` 丢弃。

pub(crate) mod wire;

use std::sync::Arc;

use bevy::{
    asset::RenderAssetUsages,
    camera::{RenderTarget, visibility::RenderLayers},
    prelude::*,
    render::{
        render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
        view::window::screenshot::{Screenshot, ScreenshotCaptured},
    },
};

use crate::{
    app::PreviewLayerPool,
    bridge::{self, HistoryThumbnailOutcome, HistoryThumbnailRequest, HistoryThumbnailResult},
    model3d::{self, PreviewRoot},
    model_preview::{PreviewView, Ready},
    protocol::ModelSnapshot,
    theme::ThemeResource,
};

/// 预览层租约 owner（同一时刻只有一个缩略图作业持有它）。
const OWNER: &str = "model-history-thumbnail";
/// 等待就绪的帧上限（首次编译管线可能较慢）。
const READINESS_TIMEOUT_FRAMES: u32 = 240;
/// 提交回读后的等待上限。
const READBACK_TIMEOUT_FRAMES: u32 = 120;
/// 稳定的三分之四视角，与模型卡片/原生预览的观察方向一致。
const VIEW_DIRECTION: [f32; 3] = [0.55, 0.5, 0.67];

pub(crate) struct HistoryThumbnailPlugin;

impl Plugin for HistoryThumbnailPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ActiveThumbnail>();
    }
}

/// 当前在飞的缩略图作业。
#[derive(Resource, Default)]
pub(crate) struct ActiveThumbnail {
    job: Option<Job>,
    frames: u32,
}

struct Job {
    request_id: u64,
    generation: u64,
    camera: Entity,
    root: PreviewRoot,
    image: Handle<Image>,
    started_at: u32,
    submitted: bool,
    submitted_at: u32,
}

/// 每个 Update 推进一次：启动新作业、等待就绪、超时结算。
///
/// 必须排在场景模型同步之后（同一帧的 `Assets<Mesh>`/`StandardMaterial` 竞争由链式顺序裁定），
/// 因此注册在 `configure_canvas` 的渲染链里。
pub(crate) fn sync(
    mut commands: Commands,
    mut state: ResMut<ActiveThumbnail>,
    mut images: ResMut<Assets<Image>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut pool: ResMut<PreviewLayerPool>,
    ready: Res<Ready>,
    theme: Res<ThemeResource>,
    mut lights: Query<&mut RenderLayers, With<DirectionalLight>>,
) {
    state.frames = state.frames.wrapping_add(1);

    // 1. 超时结算（迟到成功不得覆盖失败，作业已经拆掉）。
    if let Some(job) = &state.job {
        let expired = if job.submitted {
            state.frames.saturating_sub(job.submitted_at) > READBACK_TIMEOUT_FRAMES
        } else {
            state.frames.saturating_sub(job.started_at) > READINESS_TIMEOUT_FRAMES
        };
        if expired {
            let code = if job.submitted {
                "thumbnail-readback-timeout"
            } else {
                "thumbnail-readiness-timeout"
            };
            let job = state.job.take().expect("job checked above");
            finish(&mut commands, &mut images, &mut pool, &ready, job, Err(code));
        }
    }

    // 2. 空闲时取一个请求（bridge 是 latest-wins 单槽，JS 侧串行发送）。
    if state.job.is_none() {
        let Some(request) = bridge::take_history_thumbnail_request() else {
            return;
        };
        start(
            &mut commands,
            &mut images,
            &mut meshes,
            &mut materials,
            &mut pool,
            &theme,
            &mut lights,
            request,
            &mut state,
        );
        return;
    }

    // 3. 就绪后提交一次回读。
    let frames = state.frames;
    let Some(job) = &mut state.job else {
        return;
    };
    if job.submitted || !ready.matches(job.camera, job.generation) {
        return;
    }
    job.submitted = true;
    job.submitted_at = frames;
    let image = job.image.clone();
    // 迟到截图必须按作业身份判定：超时结算后新作业已经接手，旧观察者不得抢走它的结果。
    let request_id = job.request_id;
    let generation = job.generation;
    commands.spawn(Screenshot::image(image)).observe(
        move |trigger: On<ScreenshotCaptured>,
              mut commands: Commands,
              mut images: ResMut<Assets<Image>>,
              mut pool: ResMut<PreviewLayerPool>,
              ready: Res<Ready>,
              mut state: ResMut<ActiveThumbnail>| {
            let current = state
                .job
                .as_ref()
                .is_some_and(|job| job.request_id == request_id && job.generation == generation);
            if !current {
                return;
            }
            let Some(job) = state.job.take() else {
                return;
            };
            let image = &trigger.image;
            let width = image.texture_descriptor.size.width;
            let height = image.texture_descriptor.size.height;
            let rgba = crate::shot_camera::rgba_from_image(image, width, height);
            finish(
                &mut commands,
                &mut images,
                &mut pool,
                &ready,
                job,
                rgba.map(|pixels| (pixels, width, height)).ok_or("thumbnail-empty-image"),
            );
        },
    );
}

#[allow(clippy::too_many_arguments)]
fn start(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    pool: &mut PreviewLayerPool,
    theme: &ThemeResource,
    lights: &mut Query<&mut RenderLayers, With<DirectionalLight>>,
    request: HistoryThumbnailRequest,
    state: &mut ActiveThumbnail,
) {
    let Some(slot) = pool.0.acquire(OWNER) else {
        // 预览层池被模型卡片/镜头卡片占满：明确失败，让卡片可重试，而不是无界加层。
        bridge::set_history_thumbnail_result(HistoryThumbnailResult {
            request_id: request.request_id,
            generation: request.generation,
            outcome: HistoryThumbnailOutcome::Failed {
                code: "thumbnail-busy".to_owned(),
            },
        });
        return;
    };
    let layer = slot.layer;
    // 方向光必须看到该层，否则离屏画面只有环境光/全黑。
    for mut layers in lights.iter_mut() {
        let merged = layers.clone().with(layer);
        *layers = merged;
    }

    let image = create_target(images, request.width, request.height);
    let root = model3d::spawn_preview_root(commands, meshes, materials, &request.snapshot, layer);
    let (center, radius) = fit_bounds(&request.snapshot);
    let aspect = request.width as f32 / request.height as f32;
    let distance = model3d::quality::preview_fit_distance(radius, aspect);
    let direction = Vec3::from_array(VIEW_DIRECTION).normalize();
    let eye = center + direction * distance;
    let camera = commands.spawn_empty().id();
    commands.entity(camera).insert((
        Camera3d::default(),
        // 就绪门禁只统计可逐项计数的直接绘制队列（与 capture/卡片同一策略）。
        bevy::render::view::NoIndirectDrawing,
        Camera {
            // 不透明背景：PNG 在卡片里直接显示，不做透明叠加。
            clear_color: ClearColorConfig::Custom(theme.token_color("canvasNodeContent")),
            order: 10,
            ..default()
        },
        RenderTarget::Image(image.clone().into()),
        RenderLayers::from_layers(&[layer]),
        Transform::from_translation(eye).looking_at(center, Vec3::Y),
        Projection::Perspective(PerspectiveProjection {
            fov: crate::orbit_camera::ORBIT_DEFAULT_FOV,
            near: 0.01,
            far: 100_000.0,
            ..default()
        }),
        bevy::render::view::Tonemapping::None,
        bevy::render::view::DebandDither::Disabled,
        PreviewView {
            camera,
            generation: request.generation,
            meshes: root.meshes.clone(),
            materials: root.materials.clone(),
            rooted: true,
        },
    ));
    state.job = Some(Job {
        request_id: request.request_id,
        generation: request.generation,
        camera,
        root,
        image,
        started_at: state.frames,
        submitted: false,
        submitted_at: 0,
    });
}

/// 发布结果并拆除本次作业的全部资源。
fn finish(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    pool: &mut PreviewLayerPool,
    ready: &Ready,
    job: Job,
    outcome: Result<(Vec<u8>, u32, u32), &'static str>,
) {
    let result = match outcome {
        Ok((rgba, width, height)) => HistoryThumbnailOutcome::Ok {
            rgba,
            width,
            height,
        },
        Err(code) => HistoryThumbnailOutcome::Failed {
            code: code.to_owned(),
        },
    };
    bridge::set_history_thumbnail_result(HistoryThumbnailResult {
        request_id: job.request_id,
        generation: job.generation,
        outcome: result,
    });
    commands.entity(job.camera).try_despawn();
    for entity in job.root.entities {
        commands.entity(entity).try_despawn();
    }
    images.remove(&job.image);
    // 一次性视图没有卡片生命周期：就绪记录必须随相机一起回收，否则每次滚动都会留条目。
    ready.forget(job.camera);
    pool.0.release(OWNER);
}

/// 离屏目标：RGBA8 + 回读用途。
fn create_target(images: &mut Assets<Image>, width: u32, height: u32) -> Handle<Image> {
    let mut image = Image::new_uninit(
        Extent3d {
            width: width.max(1),
            height: height.max(1),
            ..default()
        },
        TextureDimension::D2,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD,
    );
    image.texture_descriptor.usage |= TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT;
    images.add(image)
}

/// 取景中心与包围球半径；无有效 bounds 时退化为单位球。
fn fit_bounds(snapshot: &Arc<ModelSnapshot>) -> (Vec3, f32) {
    let Some(bounds) = model3d::derive_aabb(snapshot) else {
        return (Vec3::ZERO, 1.0);
    };
    let center = Vec3::new(
        (bounds.min[0] + bounds.max[0]) * 0.5,
        (bounds.min[1] + bounds.max[1]) * 0.5,
        (bounds.min[2] + bounds.max[2]) * 0.5,
    );
    let extent = Vec3::new(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
    );
    (center, (extent.length() * 0.5).max(0.01))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_bounds_centers_and_scales_from_aabb() {
        let snapshot = Arc::new(ModelSnapshot::new(
            Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            Vec::new(),
            String::new(),
            1.0,
            Default::default(),
        ));
        let (center, radius) = fit_bounds(&snapshot);
        assert!(center.is_finite());
        assert!(radius > 0.0);
    }
}
