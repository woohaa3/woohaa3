//! 页面内共享世界镜头捕获：同一 Bevy App 内的一次性离屏渲染。
//!
//! 页面触发取景时把「镜头身份 + 输出尺寸 + 稳定 identity」交给本模块（`world_capture::wire`）。
//! 模块在**既有 App** 里按冻结请求解析 `CurrentScene` 里的镜头姿态/投影，在页面世界层
//! （layer 0，即镜头卡片现在渲染的那一层）建一次性离屏相机（`RenderTarget::Image`），
//! 稳定若干帧后用 `Screenshot::image` 回读 RGBA，随即拆相机、删图像。
//!
//! 与镜头卡片预览一样直接复用页面世界实体，不重建模型、不新建 App/context、不写规范状态。
//! 捕获是生成输入，**不含等距网格**：作业期间把网格挪到停放层，结束由
//! `world_camera_preview::sync` 复位。作业严格串行（一个在飞），迟到的结果按
//! `(requestId, generation)` 丢弃。

pub(crate) mod wire;

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
    app::{CurrentScene, PreviewLayerPool},
    bridge::{self, WorldCaptureOutcome, WorldCaptureRequest, WorldCaptureResult},
    model3d::ModelVisuals,
    theme::ThemeResource,
    world_camera_binding::{BindingResolution, WorldCameraBinding},
    world_camera_view,
};

/// 提交回读前等待的稳定帧数（世界实体已由主画布渲染，仍给管线/目标注册留余量）。
const SETTLE_FRAMES: u32 = 2;
/// 等待回读的帧上限。
const READBACK_TIMEOUT_FRAMES: u32 = 120;
/// 输出边长的安全上界（canonical 输出长边为 2048）。
const MAX_EDGE: u32 = 4096;

pub(crate) struct WorldCapturePlugin;

impl Plugin for WorldCapturePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ActiveWorldCapture>();
    }
}

/// 当前在飞的捕获作业。
#[derive(Resource, Default)]
pub(crate) struct ActiveWorldCapture {
    job: Option<Job>,
    frames: u32,
}

impl ActiveWorldCapture {
    /// 是否有在飞的捕获作业（静止降频据此判定需要连续帧）。
    pub(crate) fn has_pending(&self) -> bool {
        self.job.is_some()
    }

    /// 在飞作业绑定的实例（若有）；`world_camera_preview::sync` 据此保留绑定层。
    pub(crate) fn pending_binding(&self) -> Option<&str> {
        self.job.as_ref().and_then(|job| job.instance_id.as_deref())
    }
}

struct Job {
    request_id: u64,
    generation: u64,
    camera: Entity,
    image: Handle<Image>,
    started_at: u32,
    submitted: bool,
    submitted_at: u32,
    /// 需要保持隔离的实例（绑定镜头）；未绑定为 `None`。
    instance_id: Option<String>,
}

/// 每个 Update 推进一次：启动新作业、停放网格、稳定后提交回读、超时结算。
///
/// 必须排在 `world_camera_preview::sync` 之后（同一渲染链）：网格停放才能覆盖其每帧复位。
pub(crate) fn sync(
    mut commands: Commands,
    mut state: ResMut<ActiveWorldCapture>,
    mut images: ResMut<Assets<Image>>,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    models: Res<ModelVisuals>,
    mut bindings: ResMut<WorldCameraBinding>,
    mut pool: ResMut<PreviewLayerPool>,
) {
    state.frames = state.frames.wrapping_add(1);

    // 1. 超时结算（迟到成功不得覆盖失败，作业已经拆掉）。
    if let Some(job) = &state.job {
        let expired = job.submitted
            && state.frames.saturating_sub(job.submitted_at) > READBACK_TIMEOUT_FRAMES;
        if expired {
            let job = state.job.take().expect("job checked above");
            finish(&mut commands, &mut images, job, Err("capture-readback-timeout"));
        }
    }

    // 2. 空闲时取一个请求（bridge 是 latest-wins 单槽，JS 侧串行发送）。
    if state.job.is_none() {
        let Some(request) = bridge::take_world_capture_request() else {
            return;
        };
        start(
            &mut commands,
            &mut images,
            &scene,
            &theme,
            &models,
            &mut bindings,
            &mut pool,
            request,
            &mut state,
        );
        return;
    }

    // 3. 网格在独立渲染层（`preview_layers::GRID_LAYER`），捕获相机天然看不到；
    //    不再逐帧挪动图层，连续录制不会让画布网格闪烁。

    // 4. 稳定后提交一次回读。
    let frames = state.frames;
    let Some(job) = &mut state.job else {
        return;
    };
    if job.submitted || frames.saturating_sub(job.started_at) < SETTLE_FRAMES {
        return;
    }
    job.submitted = true;
    job.submitted_at = frames;
    let image = job.image.clone();
    let request_id = job.request_id;
    let generation = job.generation;
    commands.spawn(Screenshot::image(image)).observe(
        move |trigger: On<ScreenshotCaptured>,
              mut commands: Commands,
              mut images: ResMut<Assets<Image>>,
              mut state: ResMut<ActiveWorldCapture>| {
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
                job,
                rgba
                    .map(|pixels| (pixels, width, height))
                    .ok_or("capture-empty-image"),
            );
        },
    );
}

fn start(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    scene: &CurrentScene,
    theme: &ThemeResource,
    models: &ModelVisuals,
    bindings: &mut WorldCameraBinding,
    pool: &mut PreviewLayerPool,
    request: WorldCaptureRequest,
    state: &mut ActiveWorldCapture,
) {
    let camera_data = scene.0.nodes.iter().find_map(|node| {
        node.world_camera
            .as_ref()
            .filter(|camera| camera.camera_id == request.camera_id)
            .cloned()
    });
    let Some(camera_data) = camera_data else {
        bridge::set_world_capture_result(WorldCaptureResult {
            request_id: request.request_id,
            generation: request.generation,
            outcome: WorldCaptureOutcome::Failed {
                code: "capture-camera-not-found".to_owned(),
            },
        });
        return;
    };
    // 绑定规则与卡片/编辑预览完全一致：绑定镜头只渲染目标实例层，未绑定渲染整层世界。
    // 目标缺失或尚未就绪明确失败，绝不退回全世界。
    let resolution = bindings.resolve(&scene.0, pool, camera_data.bound_instance_id.as_deref());
    let (world_layers, instance_id) = match crate::world_camera_binding::capture_layers(
        &resolution,
        models,
        camera_data.bound_instance_id.as_deref(),
    ) {
        Ok(decision) => decision,
        Err(code) => {
            bridge::set_world_capture_result(WorldCaptureResult {
                request_id: request.request_id,
                generation: request.generation,
                outcome: WorldCaptureOutcome::Failed {
                    code: code.to_owned(),
                },
            });
            return;
        }
    };
    // 幂等：卡片预览通常已写入同一层；这里保证离屏卡片时目标也带着该层。
    if let BindingResolution::Instance { node_id, layer } = &resolution {
        crate::model3d::set_bound_instance_layer(models, commands, node_id, Some(*layer));
    }
    let width = request.width.clamp(32, MAX_EDGE);
    let height = request.height.clamp(32, MAX_EDGE);
    let image = create_target(images, width, height);
    let camera = commands
        .spawn((
            Camera3d::default(),
            bevy::render::view::NoIndirectDrawing,
            Camera {
                // 固定浅色底：捕获是生成输入，不跟随页面主题。
                clear_color: ClearColorConfig::Custom(theme.token_color("webBackdrop")),
                order: 10,
                ..default()
            },
            RenderTarget::Image(image.clone().into()),
            world_layers,
            world_camera_view::pose(&camera_data),
            world_camera_view::projection(&camera_data, UVec2::new(width, height)),
            bevy::render::view::Tonemapping::None,
            bevy::render::view::DebandDither::Disabled,
        ))
        .id();
    state.job = Some(Job {
        request_id: request.request_id,
        generation: request.generation,
        camera,
        image,
        started_at: state.frames,
        submitted: false,
        submitted_at: 0,
        instance_id,
    });
}

/// 发布结果并拆除本次作业的资源。
fn finish(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    job: Job,
    outcome: Result<(Vec<u8>, u32, u32), &'static str>,
) {
    let result = match outcome {
        Ok((rgba, width, height)) => WorldCaptureOutcome::Ok {
            rgba,
            width,
            height,
        },
        Err(code) => WorldCaptureOutcome::Failed {
            code: code.to_owned(),
        },
    };
    bridge::set_world_capture_result(WorldCaptureResult {
        request_id: job.request_id,
        generation: job.generation,
        outcome: result,
    });
    commands.entity(job.camera).try_despawn();
    images.remove(&job.image);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_capture_reports_no_pending_work() {
        assert!(!ActiveWorldCapture::default().has_pending());
    }

    #[test]
    fn capture_target_keeps_requested_size() {
        let mut images = Assets::<Image>::default();
        let handle = create_target(&mut images, 0, 640);
        let image = images.get(&handle).expect("target");
        assert_eq!(image.texture_descriptor.size.width, 1);
        assert_eq!(image.texture_descriptor.size.height, 640);
    }
}
