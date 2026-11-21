//! 页面内共享世界镜头捕获：同一 Bevy App 内的一次性离屏渲染。
//!
//! 页面触发取景时把「镜头身份 + 输出尺寸 + 稳定 identity」交给本模块（`world_capture::wire`）。
//! 模块在**既有 App** 里按冻结请求解析 `CurrentScene` 里的镜头姿态/投影，在镜头内容层
//! （未绑定为 layer 11，绑定为目标实例租约层）建一次性离屏相机（`RenderTarget::Image`），
//! 稳定若干帧后用 `Screenshot::image` 回读 RGBA，随即拆相机、删图像。
//!
//! 与镜头卡片预览一样直接复用页面世界实体，不重建模型、不新建 App/context、不写规范状态。
//! 捕获是生成输入，**不含等距网格**，使用相机专属环境光 + 一盏无阴影主光，忽略全局方向光，
//! 不改变主画布照明或网格。作业严格串行（一个在飞），迟到的结果按
//! `(requestId, generation, 发起时冻结的画布访问)` 丢弃。旧截图闭包不得只凭
//! request id / generation 消费同号新 Job。

pub(crate) mod wire;

use std::collections::HashMap;

use bevy::{
    asset::{AssetId, RenderAssetUsages},
    camera::{RenderTarget, visibility::RenderLayers},
    prelude::*,
    render::{
        render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
        view::window::screenshot::{Screenshot, ScreenshotCaptured},
    },
};

use crate::{
    app::{CurrentScene, PreviewLayerPool},
    bridge::{self, CanvasVisit, WorldCaptureOutcome, WorldCaptureRequest, WorldCaptureResult},
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
/// 在途回读上限。active 最多一个，且仅在 active 为 None 时检查，故退休数与 active 总数不超过 2。
const MAX_IN_FLIGHT_READBACKS: usize = 2;

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
    /// 已提交、因切画布让出槽位的 image。按提交时的 AssetId 保留 Handle，等原截图回调删除。
    retired_images: HashMap<AssetId<Image>, Handle<Image>>,
}

impl ActiveWorldCapture {
    /// 是否有在飞的捕获作业（静止降频据此判定需要连续帧）。
    pub(crate) fn has_pending(&self) -> bool {
        self.job.is_some() || !self.retired_images.is_empty()
    }

    /// 在飞作业绑定的实例（若有）；`world_camera_preview::sync` 据此保留绑定层。
    pub(crate) fn pending_binding(&self) -> Option<&str> {
        self.job.as_ref().and_then(|job| job.instance_id.as_deref())
    }
}

struct Job {
    request_id: u64,
    generation: u64,
    /// 发起时冻结的画布访问，不是截图回调执行时的当前画布。
    canvas_visit: CanvasVisit,
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

    // 访问已切换的在途作业先让出槽，同一 tick 才能取到新画布的请求。
    // 不发布结果，也不改写冻结访问。未提交的 image 直接删除；已提交的转入 retired 表。
    // 已提交的 Screenshot 实体没有记在 Job 上，这里拆不掉，也不证明在途 GPU 回读已取消。
    if state
        .job
        .as_ref()
        .is_some_and(|job| !bridge::world_capture_visit_is_current(&job.canvas_visit))
    {
        let job = state.job.take().expect("job checked above");
        release_abandoned_job(&mut commands, &mut images, &mut state.retired_images, job);
    }

    // 1. 超时结算（迟到成功不得覆盖失败，作业已经拆掉）。
    if let Some(job) = &state.job {
        let expired = job.submitted
            && state.frames.saturating_sub(job.submitted_at) > READBACK_TIMEOUT_FRAMES;
        if expired {
            let job = state.job.take().expect("job checked above");
            bridge::set_world_capture_result(WorldCaptureResult {
                request_id: job.request_id,
                generation: job.generation,
                canvas_visit: job.canvas_visit.clone(),
                outcome: WorldCaptureOutcome::Failed {
                    code: "capture-readback-timeout".to_owned(),
                },
            });
            release_abandoned_job(&mut commands, &mut images, &mut state.retired_images, job);
        }
    }

    // 2. 空闲时取一个请求（bridge 是 latest-wins 单槽，JS 侧串行发送）。
    if state.job.is_none() {
        let Some(request) = bridge::take_world_capture_request() else {
            return;
        };
        if state.retired_images.len() >= MAX_IN_FLIGHT_READBACKS {
            bridge::set_world_capture_result(WorldCaptureResult {
                request_id: request.request_id,
                generation: request.generation,
                canvas_visit: request.canvas_visit,
                outcome: WorldCaptureOutcome::Failed {
                    code: "capture-readback-busy".to_owned(),
                },
            });
            return;
        }
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
    let image_id = image.id();
    let request_id = job.request_id;
    let generation = job.generation;
    let canvas_visit = job.canvas_visit.clone();
    commands.spawn(Screenshot::image(image)).observe(
        move |trigger: On<ScreenshotCaptured>,
              mut commands: Commands,
              mut images: ResMut<Assets<Image>>,
              mut state: ResMut<ActiveWorldCapture>| {
            // 切画布后旧回调只按提交时的 AssetId 回收 retired image，不得消费新 Job。
            if state.retired_images.remove(&image_id).is_some() {
                images.remove(image_id);
                return;
            }
            // 身份比较在转换之前。闭包只把图像交给这条路径，不自己先拷像素。
            apply_screenshot_if_current(
                &mut commands,
                &mut images,
                &mut state,
                request_id,
                generation,
                &canvas_visit,
                &trigger.image,
                convert_captured_image,
            );
        },
    );
}

/// 先核对 request id / generation / 冻结访问，匹配才转换图像。
///
/// 转换由调用方传入，测试可以计数。不匹配时不得调用 `convert`。
fn apply_screenshot_if_current(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    state: &mut ActiveWorldCapture,
    request_id: u64,
    generation: u64,
    canvas_visit: &CanvasVisit,
    image: &Image,
    convert: impl FnOnce(&Image) -> Result<(Vec<u8>, u32, u32), &'static str>,
) -> bool {
    let matches = state
        .job
        .as_ref()
        .is_some_and(|job| screenshot_callback_matches(job, request_id, generation, canvas_visit));
    if !matches {
        return false;
    }
    let outcome = convert(image);
    consume_matching_screenshot(
        commands,
        images,
        state,
        request_id,
        generation,
        canvas_visit,
        outcome,
    )
}

fn convert_captured_image(image: &Image) -> Result<(Vec<u8>, u32, u32), &'static str> {
    let width = image.texture_descriptor.size.width;
    let height = image.texture_descriptor.size.height;
    crate::shot_camera::rgba_from_image(image, width, height)
        .map(|pixels| (pixels, width, height))
        .ok_or("capture-empty-image")
}

/// 截图到达后的消费决策。身份来自提交时冻住的访问，不匹配则不拆 Job、不发布结果。
///
/// 返回是否消费了当前 Job。模拟 Job 的系统测试走同一函数；这不是 GPU 回读。
fn consume_matching_screenshot(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    state: &mut ActiveWorldCapture,
    request_id: u64,
    generation: u64,
    canvas_visit: &CanvasVisit,
    outcome: Result<(Vec<u8>, u32, u32), &'static str>,
) -> bool {
    let current = state
        .job
        .as_ref()
        .is_some_and(|job| screenshot_callback_matches(job, request_id, generation, canvas_visit));
    if !current {
        return false;
    }
    let Some(job) = state.job.take() else {
        return false;
    };
    finish(commands, images, job, outcome);
    true
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
            canvas_visit: request.canvas_visit.clone(),
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
                canvas_visit: request.canvas_visit.clone(),
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
    let world_camera_layers = world_layers.with(crate::preview_layers::SHOOTING_KEY_LAYER);
    let camera = commands
        .spawn((
            Camera3d::default(),
            crate::model3d::shadows::world_camera_lighting(),
            bevy::render::view::NoIndirectDrawing,
            Camera {
                // 固定浅色底：捕获是生成输入，不跟随页面主题。
                clear_color: ClearColorConfig::Custom(theme.token_color("webBackdrop")),
                order: 10,
                ..default()
            },
            RenderTarget::Image(image.clone().into()),
            // 视图层加上拍摄主光层：主光只对这个视图生效，几何仍只在 world_layers 上。
            world_camera_layers.clone(),
            world_camera_view::pose(&camera_data),
            world_camera_view::projection(&camera_data, UVec2::new(width, height)),
            bevy::render::view::Tonemapping::None,
            bevy::render::view::DebandDither::Disabled,
        ))
        .id();
    commands.spawn((
        crate::model3d::shadows::shooting_key_light(world_camera_layers.clone()),
        Transform::default(),
        ChildOf(camera),
    ));
    state.job = Some(Job {
        request_id: request.request_id,
        generation: request.generation,
        canvas_visit: request.canvas_visit,
        camera,
        image,
        started_at: state.frames,
        submitted: false,
        submitted_at: 0,
        instance_id,
    });
}

/// 访问已不是当前画布时拆掉占槽的旧作业。不发布结果，不把当前访问贴到旧作业上。
///
/// 未提交任务移除 image。已提交任务把 image 按 AssetId 转入 retired 表并拆相机，不释放 image。
/// 已提交回读的 Screenshot 实体不在 Job 上，不能靠这里取消 GPU 回读。
fn release_abandoned_job(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    retired_images: &mut HashMap<AssetId<Image>, Handle<Image>>,
    job: Job,
) {
    commands.entity(job.camera).try_despawn();
    if job.submitted {
        let id = job.image.id();
        retired_images.insert(id, job.image);
    } else {
        images.remove(&job.image);
    }
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
        canvas_visit: job.canvas_visit,
        outcome: result,
    });
    commands.entity(job.camera).try_despawn();
    images.remove(&job.image);
}

/// 截图回调是否仍属于提交时的 Job。同号新 Job 若访问身份不同，旧闭包必须放弃。
fn screenshot_callback_matches(
    job: &Job,
    request_id: u64,
    generation: u64,
    canvas_visit: &CanvasVisit,
) -> bool {
    job.request_id == request_id
        && job.generation == generation
        && job.canvas_visit == *canvas_visit
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
    use std::cell::Cell;

    use super::*;

    thread_local! {
        static SCREENSHOT_CONVERSIONS: Cell<u32> = const { Cell::new(0) };
    }

    #[test]
    fn idle_capture_reports_no_pending_work() {
        assert!(!ActiveWorldCapture::default().has_pending());
        let mut state = ActiveWorldCapture::default();
        let image = Handle::<Image>::default();
        state.retired_images.insert(image.id(), image);
        assert!(state.has_pending());
    }

    fn job(request_id: u64, generation: u64, canvas_id: &str, seq: u64) -> Job {
        Job {
            request_id,
            generation,
            canvas_visit: CanvasVisit {
                canvas_id: canvas_id.to_owned(),
                seq,
            },
            camera: Entity::from_bits(1),
            image: Handle::default(),
            started_at: 0,
            submitted: true,
            submitted_at: 0,
            instance_id: None,
        }
    }

    #[test]
    fn screenshot_callback_rejects_same_ids_from_another_canvas_visit() {
        let current = job(7, 3, "canvas-b", 2);
        let stale = CanvasVisit {
            canvas_id: "canvas-a".to_owned(),
            seq: 1,
        };
        assert!(
            !screenshot_callback_matches(&current, 7, 3, &stale),
            "同号新 Job 不得被旧画布访问的截图闭包消费"
        );
        assert!(screenshot_callback_matches(
            &current,
            7,
            3,
            &current.canvas_visit
        ));
    }

    fn capture_app() -> App {
        let mut app = App::new();
        app.init_resource::<ActiveWorldCapture>()
            .init_resource::<CurrentScene>()
            .init_resource::<ThemeResource>()
            .init_resource::<ModelVisuals>()
            .init_resource::<WorldCameraBinding>()
            .init_resource::<PreviewLayerPool>()
            .insert_resource(Assets::<Image>::default());
        app
    }

    /// 模拟 Job 跑与截图闭包相同的消费函数。没有渲染世界，不能当作 GPU 回读验收。
    #[test]
    fn simulated_job_system_rejects_stale_screenshot_and_publishes_matching_visit() {
        bridge::reset_world_capture_identity_for_test();
        bridge::queue_scene(crate::protocol::Scene {
            canvas_id: "canvas-a".to_owned(),
            ..crate::protocol::Scene::default()
        });
        bridge::queue_world_capture_request(bridge::WorldCaptureRequest {
            request_id: 71,
            generation: 1,
            camera_id: "cam-a".to_owned(),
            width: 8,
            height: 8,
            canvas_visit: CanvasVisit::unbound(),
        });
        let visit_a = bridge::take_world_capture_request()
            .expect("A visit")
            .canvas_visit;
        bridge::queue_scene(crate::protocol::Scene {
            canvas_id: "canvas-b".to_owned(),
            ..crate::protocol::Scene::default()
        });
        bridge::queue_world_capture_request(bridge::WorldCaptureRequest {
            request_id: 72,
            generation: 2,
            camera_id: "cam-b".to_owned(),
            width: 8,
            height: 8,
            canvas_visit: CanvasVisit::unbound(),
        });
        let visit_b = bridge::take_world_capture_request()
            .expect("B visit")
            .canvas_visit;

        let mut app = capture_app();
        {
            let mut state = app.world_mut().resource_mut::<ActiveWorldCapture>();
            state.job = Some(Job {
                request_id: 72,
                generation: 2,
                canvas_visit: visit_b.clone(),
                camera: Entity::from_bits(1),
                image: Handle::default(),
                started_at: 0,
                submitted: true,
                submitted_at: 0,
                instance_id: None,
            });
        }
        let stale_pixels = vec![1u8; 16];
        let fresh_pixels = vec![2u8; 16];
        app.add_systems(
            Update,
            move |mut commands: Commands,
                  mut images: ResMut<Assets<Image>>,
                  mut state: ResMut<ActiveWorldCapture>| {
                let stale = consume_matching_screenshot(
                    &mut commands,
                    &mut images,
                    &mut state,
                    72,
                    2,
                    &visit_a,
                    Ok((stale_pixels.clone(), 1, 1)),
                );
                assert!(!stale, "旧访问的模拟截图不得消费当前 Job");
                assert!(state.job.is_some(), "不匹配的闭包不得拆掉 B 的 Job");
                let fresh = consume_matching_screenshot(
                    &mut commands,
                    &mut images,
                    &mut state,
                    72,
                    2,
                    &visit_b,
                    Ok((fresh_pixels.clone(), 1, 1)),
                );
                assert!(fresh, "匹配访问的模拟截图应消费当前 Job");
                assert!(state.job.is_none());
            },
        );
        app.update();
        let observed = bridge::take_world_capture_result(72, 2).expect("B result published");
        assert_eq!(observed.canvas_visit.canvas_id, "canvas-b");
        match observed.outcome {
            WorldCaptureOutcome::Ok { rgba, .. } => assert_eq!(rgba, vec![2u8; 16]),
            WorldCaptureOutcome::Failed { .. } => {
                panic!("simulated matching callback should publish pixels")
            }
        }
    }

    /// `sync` 取请求的系统路径。无镜头时失败码来自场景，不是 GPU 回读。
    #[test]
    fn sync_discards_unconsumed_request_and_runs_the_new_canvas_request() {
        bridge::reset_world_capture_identity_for_test();
        bridge::queue_scene(crate::protocol::Scene {
            canvas_id: "canvas-a".to_owned(),
            ..crate::protocol::Scene::default()
        });
        bridge::queue_world_capture_request(bridge::WorldCaptureRequest {
            request_id: 81,
            generation: 1,
            camera_id: "cam-a".to_owned(),
            width: 8,
            height: 8,
            canvas_visit: CanvasVisit::unbound(),
        });
        bridge::queue_scene(crate::protocol::Scene {
            canvas_id: "canvas-b".to_owned(),
            ..crate::protocol::Scene::default()
        });

        let mut app = capture_app();
        app.add_systems(Update, sync);
        app.update();
        assert!(
            app.world().resource::<ActiveWorldCapture>().job.is_none(),
            "A 的未消费请求不得在 B 的场景里启动作业"
        );
        assert!(bridge::take_world_capture_result(81, 1).is_none());

        bridge::queue_world_capture_request(bridge::WorldCaptureRequest {
            request_id: 82,
            generation: 2,
            camera_id: "cam-b".to_owned(),
            width: 8,
            height: 8,
            canvas_visit: CanvasVisit::unbound(),
        });
        app.update();
        assert!(app.world().resource::<ActiveWorldCapture>().job.is_none());
        let observed = bridge::take_world_capture_result(82, 2).expect("B 的新请求不得被误丢");
        assert_eq!(observed.canvas_visit.canvas_id, "canvas-b");
        match observed.outcome {
            WorldCaptureOutcome::Failed { code } => assert_eq!(code, "capture-camera-not-found"),
            WorldCaptureOutcome::Ok { .. } => {
                panic!("空场景没有镜头，也不该出现 GPU 像素")
            }
        }
    }

    #[test]
    fn capture_target_keeps_requested_size() {
        let mut images = Assets::<Image>::default();
        let handle = create_target(&mut images, 0, 640);
        let image = images.get(&handle).expect("target");
        assert_eq!(image.texture_descriptor.size.width, 1);
        assert_eq!(image.texture_descriptor.size.height, 640);
    }

    fn scene(canvas_id: &str) -> crate::protocol::Scene {
        crate::protocol::Scene {
            canvas_id: canvas_id.to_owned(),
            ..crate::protocol::Scene::default()
        }
    }

    fn request(request_id: u64, generation: u64, camera_id: &str) -> bridge::WorldCaptureRequest {
        bridge::WorldCaptureRequest {
            request_id,
            generation,
            camera_id: camera_id.to_owned(),
            width: 8,
            height: 8,
            canvas_visit: CanvasVisit::unbound(),
        }
    }

    fn solid_image() -> Image {
        Image::new(
            Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            TextureDimension::D2,
            vec![0, 0, 0, 255],
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::MAIN_WORLD,
        )
    }

    fn count_conversion(image: &Image) -> Result<(Vec<u8>, u32, u32), &'static str> {
        let _ = image;
        SCREENSHOT_CONVERSIONS.with(|calls| calls.set(calls.get() + 1));
        Ok((vec![4, 4, 4, 4], 1, 1))
    }

    /// 与截图闭包同一条路径：先比较身份，匹配才转换。没有渲染世界，不是 GPU 回读。
    #[test]
    fn screenshot_callback_converts_only_the_matching_visit() {
        bridge::reset_world_capture_identity_for_test();
        bridge::queue_scene(scene("canvas-a"));
        bridge::queue_world_capture_request(request(91, 3, "cam-a"));
        let visit_a = bridge::take_world_capture_request()
            .expect("A visit")
            .canvas_visit;
        bridge::queue_scene(scene("canvas-b"));
        bridge::queue_world_capture_request(request(91, 3, "cam-b"));
        let visit_b = bridge::take_world_capture_request()
            .expect("B visit")
            .canvas_visit;

        let mut app = capture_app();
        {
            let mut state = app.world_mut().resource_mut::<ActiveWorldCapture>();
            state.job = Some(Job {
                request_id: 91,
                generation: 3,
                canvas_visit: visit_b.clone(),
                camera: Entity::from_bits(1),
                image: Handle::default(),
                started_at: 0,
                submitted: true,
                submitted_at: 0,
                instance_id: None,
            });
        }
        SCREENSHOT_CONVERSIONS.with(|calls| calls.set(0));
        app.add_systems(
            Update,
            move |mut commands: Commands,
                  mut images: ResMut<Assets<Image>>,
                  mut state: ResMut<ActiveWorldCapture>| {
                let shot = solid_image();
                let stale = apply_screenshot_if_current(
                    &mut commands,
                    &mut images,
                    &mut state,
                    91,
                    3,
                    &visit_a,
                    &shot,
                    count_conversion,
                );
                assert!(!stale, "旧访问不得消费当前 Job");
                assert_eq!(
                    SCREENSHOT_CONVERSIONS.with(Cell::get),
                    0,
                    "旧回调不得转换图像"
                );
                assert!(state.job.is_some());
                let fresh = apply_screenshot_if_current(
                    &mut commands,
                    &mut images,
                    &mut state,
                    91,
                    3,
                    &visit_b,
                    &shot,
                    count_conversion,
                );
                assert!(fresh, "匹配访问应消费当前 Job");
                assert_eq!(
                    SCREENSHOT_CONVERSIONS.with(Cell::get),
                    1,
                    "匹配回调应转换一次"
                );
            },
        );
        app.update();
        let observed = bridge::take_world_capture_result(91, 3).expect("matching visit publishes");
        match observed.outcome {
            WorldCaptureOutcome::Ok { rgba, .. } => assert_eq!(rgba, vec![4, 4, 4, 4]),
            WorldCaptureOutcome::Failed { .. } => panic!("matching callback should publish pixels"),
        }
    }

    /// A 的在途作业切到 B 后不得占槽。无镜头时 B 返回自己的失败码，不是 GPU 回读。
    #[test]
    fn inflight_job_is_released_on_canvas_switch_without_clearing_the_new_job() {
        bridge::reset_world_capture_identity_for_test();
        bridge::queue_scene(scene("canvas-a"));
        bridge::queue_world_capture_request(request(94, 1, "cam-a"));
        let visit_a = bridge::take_world_capture_request()
            .expect("A visit")
            .canvas_visit;

        let mut app = capture_app();
        let stale_camera = app.world_mut().spawn(Transform::default()).id();
        let stale_image = {
            let mut images = app.world_mut().resource_mut::<Assets<Image>>();
            create_target(&mut images, 8, 8)
        };
        {
            let mut state = app.world_mut().resource_mut::<ActiveWorldCapture>();
            state.job = Some(Job {
                request_id: 94,
                generation: 1,
                canvas_visit: visit_a.clone(),
                camera: stale_camera,
                image: stale_image.clone(),
                started_at: 0,
                submitted: true,
                submitted_at: 0,
                instance_id: None,
            });
        }
        bridge::queue_scene(scene("canvas-b"));
        bridge::queue_world_capture_request(request(95, 2, "cam-b"));
        app.add_systems(Update, sync);
        app.update();

        assert!(
            app.world().get_entity(stale_camera).is_err(),
            "切到 B 后应拆掉 A 的捕获相机"
        );
        assert!(
            app.world()
                .resource::<Assets<Image>>()
                .get(&stale_image)
                .is_some(),
            "已提交的旧截图纹理必须保留到回调"
        );
        assert!(
            app.world().resource::<ActiveWorldCapture>().job.is_none(),
            "旧作业不得继续占槽"
        );
        assert!(bridge::take_world_capture_result(94, 1).is_none());
        let observed =
            bridge::take_world_capture_result(95, 2).expect("B 的请求应在同一 tick 推进");
        assert_eq!(observed.request_id, 95);
        assert_eq!(observed.generation, 2);
        assert_eq!(observed.canvas_visit.canvas_id, "canvas-b");
        let visit_b = observed.canvas_visit.clone();
        match observed.outcome {
            WorldCaptureOutcome::Failed { code } => assert_eq!(code, "capture-camera-not-found"),
            WorldCaptureOutcome::Ok { .. } => panic!("空场景没有镜头，也不该出现 GPU 像素"),
        }

        let current_camera = app.world_mut().spawn(Transform::default()).id();
        let current_image = {
            let mut images = app.world_mut().resource_mut::<Assets<Image>>();
            create_target(&mut images, 8, 8)
        };
        {
            let frames = app.world().resource::<ActiveWorldCapture>().frames;
            let mut state = app.world_mut().resource_mut::<ActiveWorldCapture>();
            state.job = Some(Job {
                request_id: 95,
                generation: 2,
                canvas_visit: visit_b,
                camera: current_camera,
                image: current_image.clone(),
                started_at: frames,
                submitted: false,
                submitted_at: 0,
                instance_id: None,
            });
        }
        bridge::queue_scene(scene("canvas-b"));
        SCREENSHOT_CONVERSIONS.with(|calls| calls.set(0));
        app.add_systems(
            Update,
            move |mut commands: Commands,
                  mut images: ResMut<Assets<Image>>,
                  mut state: ResMut<ActiveWorldCapture>| {
                assert!(
                    state
                        .job
                        .as_ref()
                        .is_some_and(|job| job.canvas_visit.canvas_id == "canvas-b"),
                    "与当前访问匹配的 B 作业不得被清掉"
                );
                let shot = solid_image();
                let stale = apply_screenshot_if_current(
                    &mut commands,
                    &mut images,
                    &mut state,
                    95,
                    2,
                    &visit_a,
                    &shot,
                    count_conversion,
                );
                assert!(!stale, "旧闭包不得消费 B 的作业");
                assert_eq!(SCREENSHOT_CONVERSIONS.with(Cell::get), 0);
                assert_eq!(state.job.as_ref().map(|job| job.request_id), Some(95));
            },
        );
        app.update();
        assert!(app.world().get_entity(current_camera).is_ok());
        assert!(
            app.world()
                .resource::<Assets<Image>>()
                .get(&current_image)
                .is_some()
        );
        assert_eq!(
            app.world()
                .resource::<ActiveWorldCapture>()
                .job
                .as_ref()
                .map(|job| job.request_id),
            Some(95)
        );
    }

    #[test]
    fn timeout_keeps_submitted_texture() {
        bridge::reset_world_capture_identity_for_test();
        bridge::queue_scene(scene("canvas-a"));
        bridge::queue_world_capture_request(request(107, 3, "cam"));
        let visit = bridge::take_world_capture_request().unwrap().canvas_visit;
        let mut app = capture_app();
        let camera = app.world_mut().spawn(Transform::default()).id();
        let image = create_target(&mut app.world_mut().resource_mut::<Assets<Image>>(), 8, 8);
        {
            let mut state = app.world_mut().resource_mut::<ActiveWorldCapture>();
            state.frames = READBACK_TIMEOUT_FRAMES + 2;
            state.job = Some(Job {
                request_id: 107,
                generation: 3,
                canvas_visit: visit,
                camera,
                image: image.clone(),
                started_at: 0,
                submitted: true,
                submitted_at: 0,
                instance_id: None,
            });
        }
        app.add_systems(Update, sync);
        app.update();
        let state = app.world().resource::<ActiveWorldCapture>();
        assert!(state.job.is_none());
        assert!(state.retired_images.contains_key(&image.id()));
        assert!(
            app.world()
                .resource::<Assets<Image>>()
                .get(&image)
                .is_some()
        );
        assert!(app.world().get_entity(camera).is_err());
        let result = bridge::take_world_capture_result(107, 3).expect("timeout result");
        assert!(
            matches!(result.outcome, WorldCaptureOutcome::Failed { code } if code == "capture-readback-timeout")
        );
    }

    #[test]
    fn full_retired_capacity_returns_busy() {
        bridge::reset_world_capture_identity_for_test();
        bridge::queue_scene(scene("canvas-b"));
        bridge::queue_world_capture_request(request(108, 4, "cam"));
        let mut app = capture_app();
        for _ in 0..MAX_IN_FLIGHT_READBACKS {
            let image = create_target(&mut app.world_mut().resource_mut::<Assets<Image>>(), 8, 8);
            app.world_mut()
                .resource_mut::<ActiveWorldCapture>()
                .retired_images
                .insert(image.id(), image);
        }
        let images_before = app.world().resource::<Assets<Image>>().len();
        app.add_systems(Update, sync);
        app.update();
        let state = app.world().resource::<ActiveWorldCapture>();
        assert!(state.job.is_none());
        assert_eq!(state.retired_images.len(), MAX_IN_FLIGHT_READBACKS);
        assert_eq!(app.world().resource::<Assets<Image>>().len(), images_before);
        let result = bridge::take_world_capture_result(108, 4).expect("busy result");
        assert!(
            matches!(result.outcome, WorldCaptureOutcome::Failed { code } if code == "capture-readback-busy")
        );
    }

    #[test]
    fn late_screenshot_releases_only_its_own_image() {
        bridge::reset_world_capture_identity_for_test();
        bridge::queue_scene(scene("canvas-a"));
        bridge::queue_world_capture_request(request(109, 5, "cam"));
        let old_visit = bridge::take_world_capture_request().unwrap().canvas_visit;
        let mut app = capture_app();
        let old_camera = app.world_mut().spawn(Transform::default()).id();
        let old_image = create_target(&mut app.world_mut().resource_mut::<Assets<Image>>(), 8, 8);
        {
            let mut state = app.world_mut().resource_mut::<ActiveWorldCapture>();
            state.frames = SETTLE_FRAMES;
            state.job = Some(Job {
                request_id: 109,
                generation: 5,
                canvas_visit: old_visit,
                camera: old_camera,
                image: old_image.clone(),
                started_at: 0,
                submitted: false,
                submitted_at: 0,
                instance_id: None,
            });
        }
        app.add_systems(Update, sync);
        app.update();
        let screenshot = app
            .world_mut()
            .query_filtered::<Entity, With<Screenshot>>()
            .single(app.world())
            .expect("submitted screenshot");
        bridge::queue_scene(scene("canvas-b"));
        app.update();
        assert!(
            app.world()
                .resource::<ActiveWorldCapture>()
                .retired_images
                .contains_key(&old_image.id())
        );
        bridge::queue_world_capture_request(request(109, 5, "cam"));
        let new_visit = bridge::take_world_capture_request().unwrap().canvas_visit;
        let new_camera = app.world_mut().spawn(Transform::default()).id();
        let new_image = create_target(&mut app.world_mut().resource_mut::<Assets<Image>>(), 8, 8);
        app.world_mut().resource_mut::<ActiveWorldCapture>().job = Some(Job {
            request_id: 109,
            generation: 5,
            canvas_visit: new_visit,
            camera: new_camera,
            image: new_image.clone(),
            started_at: 0,
            submitted: false,
            submitted_at: 0,
            instance_id: None,
        });
        app.world_mut().trigger(ScreenshotCaptured {
            entity: screenshot,
            image: solid_image(),
        });
        app.world_mut().flush();
        let state = app.world().resource::<ActiveWorldCapture>();
        assert!(!state.retired_images.contains_key(&old_image.id()));
        assert!(
            state
                .job
                .as_ref()
                .is_some_and(|job| job.image.id() == new_image.id())
        );
        let images = app.world().resource::<Assets<Image>>();
        assert!(images.get(&old_image).is_none());
        assert!(images.get(&new_image).is_some());
        assert!(bridge::take_world_capture_result(109, 5).is_none());
    }

    #[test]
    fn late_timed_out_screenshot_preserves_same_visit_job() {
        bridge::reset_world_capture_identity_for_test();
        bridge::queue_scene(scene("canvas-a"));
        bridge::queue_world_capture_request(request(109, 5, "cam"));
        let old_visit = bridge::take_world_capture_request().unwrap().canvas_visit;
        let mut app = capture_app();
        let old_camera = app.world_mut().spawn(Transform::default()).id();
        let old_image = create_target(&mut app.world_mut().resource_mut::<Assets<Image>>(), 8, 8);
        {
            let mut state = app.world_mut().resource_mut::<ActiveWorldCapture>();
            state.frames = SETTLE_FRAMES;
            state.job = Some(Job {
                request_id: 109,
                generation: 5,
                canvas_visit: old_visit,
                camera: old_camera,
                image: old_image.clone(),
                started_at: 0,
                submitted: false,
                submitted_at: 0,
                instance_id: None,
            });
        }
        app.add_systems(Update, sync);
        app.update();
        let screenshot = app
            .world_mut()
            .query_filtered::<Entity, With<Screenshot>>()
            .single(app.world())
            .expect("submitted screenshot");
        app.world_mut().resource_mut::<ActiveWorldCapture>().frames =
            READBACK_TIMEOUT_FRAMES + SETTLE_FRAMES + 2;
        app.update();
        let timeout = bridge::take_world_capture_result(109, 5).expect("timeout");
        assert!(
            matches!(timeout.outcome, WorldCaptureOutcome::Failed { code } if code == "capture-readback-timeout")
        );
        assert!(
            app.world()
                .resource::<ActiveWorldCapture>()
                .retired_images
                .contains_key(&old_image.id())
        );
        bridge::queue_world_capture_request(request(109, 5, "cam"));
        let new_visit = bridge::take_world_capture_request().unwrap().canvas_visit;
        let new_camera = app.world_mut().spawn(Transform::default()).id();
        let new_image = create_target(&mut app.world_mut().resource_mut::<Assets<Image>>(), 8, 8);
        app.world_mut().resource_mut::<ActiveWorldCapture>().job = Some(Job {
            request_id: 109,
            generation: 5,
            canvas_visit: new_visit,
            camera: new_camera,
            image: new_image.clone(),
            started_at: 0,
            submitted: false,
            submitted_at: 0,
            instance_id: None,
        });
        app.world_mut().trigger(ScreenshotCaptured {
            entity: screenshot,
            image: solid_image(),
        });
        app.world_mut().flush();
        let state = app.world().resource::<ActiveWorldCapture>();
        assert!(!state.retired_images.contains_key(&old_image.id()));
        assert!(
            state
                .job
                .as_ref()
                .is_some_and(|job| job.image.id() == new_image.id())
        );
        let images = app.world().resource::<Assets<Image>>();
        assert!(images.get(&old_image).is_none());
        assert!(images.get(&new_image).is_some());
        assert!(bridge::take_world_capture_result(109, 5).is_none());
    }
}
