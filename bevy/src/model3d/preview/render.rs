//! 离屏渲染、读回与 PNG 编码
//! （change: refactor-bevy-rust-file-size，任务 3.4 / design D2）。

use std::sync::{Arc, Mutex};

use bevy::{
    app::ScheduleRunnerPlugin,
    asset::RenderAssetUsages,
    camera::RenderTarget,
    prelude::*,
    render::{
        RenderPlugin,
        render_resource::TextureUsages,
        view::{DebandDither, Tonemapping},
    },
};

use crate::model3d::compose_delta;
use crate::model3d::scene::{self, ModelEntitySpec, ModelGeometry};
use crate::protocol::ModelSnapshot;
use crate::renderer_protocol::{CaptureOptions, RenderErrorCode, RenderRequest};

#[cfg(feature = "recording-gpu")]
static ADAPTER_INFO: Mutex<Option<crate::recording_prepare::GpuAdapterInfo>> = Mutex::new(None);
#[cfg(feature = "recording-gpu")]
pub fn detected_adapter() -> Option<crate::recording_prepare::GpuAdapterInfo> {
    ADAPTER_INFO.lock().unwrap().clone()
}

const PREVIEW_DEPTH: f32 = 40.0;

/// 离屏预览相机到模型包围球中心的距离系数。
///
/// 旧公式 `distance = extent × 2.2`；对居中模型 `extent = 2 × max|coord|`，而包围球半径是
/// AABB 半对角线（`半径 = max|coord| × √3`），故等价于 `半径 × 4.4/√3 ≈ 2.54`。改用真实包围球
/// 后保留同一系数，卡片构图不变（change: 2026-10-31-render-models-at-absolute-metric-scale）。
const PREVIEW_FRAME_DISTANCE_FACTOR: f32 = 4.4 / 1.732_050_8;

/// 正交预览视口边长相对包围球半径的系数。
///
/// 旧公式视口边长 `extent × 1.6 = 半径 × 3.2/√3 ≈ 1.85 半径`，同样按真实包围球等价换算。
const PREVIEW_ORTHO_ASPECT: f32 = 1.6 / 1.732_050_8;

/// 固定预览灯光：一个环境光 + 一个方向光，脚本不可修改。
fn setup_lights(commands: &mut Commands) {
    commands.insert_resource(GlobalAmbientLight {
        color: Color::WHITE,
        brightness: 600.0,
        ..default()
    });
    commands.spawn((
        DirectionalLight {
            color: Color::srgb_u8(255, 245, 223),
            illuminance: 4_000.0,
            shadow_maps_enabled: false,
            ..default()
        },
        Transform::from_xyz(180.0, 260.0, 300.0),
    ));
}

/// 背景色：透明（alpha 0）或 `#rrggbb`。
pub(super) fn background_color(background: &str) -> Color {
    if background == "transparent" {
        Color::NONE
    } else {
        scene::parse_hex(background)
    }
}

/// Native output uses the same immutable original/high profile as capture/export.
pub(super) fn high_mesh(
    resources: &mut super::super::resources::SharedResources,
    meshes: &mut Assets<Mesh>,
    geometry: &ModelGeometry,
) -> Option<Handle<Mesh>> {
    let quality = super::super::quality::ViewPurpose::Export
        .select(0.0, super::super::quality::Quality::High);
    resources
        .mesh(
            meshes,
            &super::super::mesh::mesh_key(geometry),
            geometry,
            quality,
        )
        .map(|(handle, _)| handle)
}

/// 构建模型 entity tree：真实层级 + material/persistent mesh 缓存。
///
/// 返回稳定部件 id → entity、base transform 与共享材质，供动画采样应用增量与透明度。
#[allow(clippy::type_complexity)]
fn spawn_model(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    model: &ModelSnapshot,
    root_transform: Transform,
) -> (
    std::collections::HashMap<String, Entity>,
    std::collections::HashMap<String, Transform>,
    std::collections::HashMap<String, Handle<StandardMaterial>>,
) {
    let specs = scene::build_entity_specs(model);
    let material_specs = scene::collect_materials(model);
    let root = commands.spawn((root_transform, Visibility::default())).id();
    let mut entities = std::collections::HashMap::new();
    let mut bases = std::collections::HashMap::new();
    let mut part_materials = std::collections::HashMap::new();
    let mut resources = super::super::resources::SharedResources::default();

    for spec in &specs {
        let transform = local_transform(spec);
        let entity = match &spec.geometry {
            None => commands.spawn((transform, Visibility::default())).id(),
            Some(geometry) => {
                let Some(mesh) = high_mesh(&mut resources, meshes, geometry) else {
                    continue;
                };
                let material = resources.material(
                    materials,
                    scene::standard_material_for(&spec.material_key, &material_specs),
                );
                part_materials.insert(spec.id.clone(), material.clone());
                commands
                    .spawn((Mesh3d(mesh), MeshMaterial3d(material), transform))
                    .id()
            }
        };
        entities.insert(spec.id.clone(), entity);
        bases.insert(spec.id.clone(), transform);
    }
    for spec in &specs {
        if let Some(entity) = entities.get(&spec.id).copied() {
            let parent = spec
                .parent
                .as_ref()
                .and_then(|id| entities.get(id).copied())
                .unwrap_or(root);
            commands.entity(entity).insert(ChildOf(parent));
        }
    }
    (entities, bases, part_materials)
}

fn local_transform(spec: &ModelEntitySpec) -> Transform {
    Transform {
        translation: Vec3::from_array(spec.position),
        rotation: scene::quat_from_xyz_radians(spec.rotation_radians),
        scale: Vec3::from_array(spec.scale),
    }
}

/// 离屏预览/录制帧的透明度应用：与可见播放同一条规则
/// （change: 2026-10-19-extend-film-set-for-motion-graphics，D2）。
///
/// 离屏帧只渲染一次，不需要事后回收：`=1` 保持原材质；`<1` 克隆一份 Blend 实例写入 alpha；
/// `=0` 直接隐藏，不参与绘制。
fn apply_preview_opacity(
    commands: &mut Commands,
    materials: &mut Assets<StandardMaterial>,
    entity: Entity,
    shared: &Handle<StandardMaterial>,
    opacity: f32,
) {
    if !opacity.is_finite() || opacity >= 1.0 {
        return;
    }
    let opacity = opacity.max(0.0);
    if opacity <= 0.0 {
        commands.entity(entity).insert(Visibility::Hidden);
        return;
    }
    let source = materials.get(shared).cloned().unwrap_or_default();
    let static_alpha = if source.alpha_mode == bevy::material::AlphaMode::Blend {
        source.base_color.alpha()
    } else {
        1.0
    };
    let mut instance = source;
    instance.alpha_mode = bevy::material::AlphaMode::Blend;
    instance
        .base_color
        .set_alpha((static_alpha * opacity).clamp(0.0, 1.0));
    let handle = materials.add(instance);
    commands.entity(entity).insert(MeshMaterial3d(handle));
}

/// 受控 dimetric 相机 + 按模型真实包围球自动取景，渲染到离屏 image。
///
/// 取景只依赖模型自身的世界包围球（场景单位 × `CANVAS_UNITS_PER_METER`），不再按 `extent`
/// 估算（change: 2026-10-31-render-models-at-absolute-metric-scale）：模型真实多大，离屏预览的
/// 相机就退多远，与它在画布其他节点里的相对大小一致。
fn setup_camera(
    commands: &mut Commands,
    image: Handle<Image>,
    radius: f32,
    depth: f32,
    background: Color,
) {
    let radius = if radius.is_finite() && radius > 1e-4 {
        radius
    } else {
        1.0
    };
    // 与既有构图保持同一比例：旧公式 `distance = extent × 2.2`，而对居中模型
    // `extent ≈ 2 × radius / √3`，等价于 `radius × 2.54`。
    let distance = radius * PREVIEW_FRAME_DISTANCE_FACTOR;
    let rotation = Quat::from_euler(
        EulerRot::YXZ,
        -45.0_f32.to_radians(),
        -crate::isometric_grid::CANVAS_CAMERA_PITCH,
        0.0,
    );
    let translation = rotation * Vec3::new(0.0, 0.0, distance);
    commands.spawn((
        Camera3d::default(),
        Camera {
            clear_color: ClearColorConfig::Custom(background),
            ..default()
        },
        RenderTarget::Image(image.into()),
        Projection::Orthographic(OrthographicProjection {
            scaling_mode: bevy::camera::ScalingMode::Fixed {
                width: radius * 2.0 * PREVIEW_ORTHO_ASPECT,
                height: radius * 2.0 * PREVIEW_ORTHO_ASPECT,
            },
            near: 0.1,
            far: depth * 4.0,
            ..OrthographicProjection::default_3d()
        }),
        Transform {
            translation,
            rotation,
            ..default()
        },
        Tonemapping::None,
        DebandDither::Disabled,
    ));
}

/// 动画 `initial` 模式：按保存的初始镜头（经 Motion IR 在采样时刻求值）派生透视相机。
///
/// 复用 `shot_camera::framing` 的透视取景数学，与 WASM 同一语义（任务 4.2）。`extent` 决定
/// 目标包围球半径的近似，focus 为模型世界中心（placement 后）。
fn setup_animation_camera(
    commands: &mut Commands,
    image: Handle<Image>,
    camera: &crate::renderer_protocol::InitialCameraRequest,
    focus: Vec3,
    radius: f32,
    scene_scale: f32,
    background: Color,
) {
    let radius = if radius.is_finite() && radius > 1e-4 {
        radius
    } else {
        1.0
    };
    // 用解析出的场景镜头状态求相机位置：distance 是场景单位，必须乘同一自然倍率后才与
    // 内容的世界位置同尺度（change: 2026-10-23-isolate-film-set-camera-space，design D4）。
    let state = camera.state();
    let scale = if scene_scale.is_finite() && scene_scale > 0.0 {
        scene_scale
    } else {
        1.0
    };
    let distance = state.distance * scale;
    let position =
        crate::shot_camera::shot_camera_position(focus, state.azimuth, distance, state.elevation);
    let rotation = Transform::from_translation(position)
        .looking_at(focus, Vec3::Y)
        .rotation;
    let fov = crate::shot_camera::SHOT_CAMERA_FOV;
    let distance = (focus - position).length();
    // 近/远裁剪按同一场景尺度派生，避免极端倍率下近裁剪随呈现变化（design D2）。
    let near = (distance * 1e-3).max(1e-4);
    commands.spawn((
        Camera3d::default(),
        Camera {
            clear_color: ClearColorConfig::Custom(background),
            ..default()
        },
        RenderTarget::Image(image.into()),
        Projection::Perspective(PerspectiveProjection {
            fov,
            near,
            far: distance * 4.0 + radius * 4.0 + 100.0 * scale,
            ..default()
        }),
        Transform {
            translation: position,
            rotation,
            ..default()
        },
        Tonemapping::None,
        DebandDither::Disabled,
    ));
}

/// 渲染一次请求并返回 PNG 字节。启动一个短命 Bevy App；读回后退出。
pub fn render_preview(request: &RenderRequest) -> Result<Vec<u8>, (RenderErrorCode, String)> {
    let capture = request.capture.clone();
    let image =
        run_render(request, &capture).map_err(|error| (RenderErrorCode::RenderFailed, error))?;
    encode_png(&image, capture.width, capture.height)
        .map_err(|error| (RenderErrorCode::RenderFailed, error))
}

/// 渲染一帧并返回 RGBA8 像素（自顶向下）。
///
/// 公开给原生录制 worker 复用：它需要**同一份**场景/相机/就绪判定，但不落 PNG、不经过页面
/// （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.2）。
/// 每个采样时刻调用一次；worker 负责常驻复用与编码。
pub fn render_rgba(request: &RenderRequest, capture: &CaptureOptions) -> Result<Vec<u8>, String> {
    run_render(request, capture)
}

/// 返回 RGBA8 像素（自顶向下）。
fn run_render(request: &RenderRequest, capture: &CaptureOptions) -> Result<Vec<u8>, String> {
    let width = capture.width;
    let height = capture.height;
    let pixels: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(std::sync::Mutex::new(None));

    let mut app = App::new();
    #[cfg(feature = "recording-gpu")]
    app.add_systems(
        Startup,
        |info: Res<bevy::render::renderer::RenderAdapterInfo>| {
            *ADAPTER_INFO.lock().unwrap() = Some(crate::recording_prepare::GpuAdapterInfo {
                name: info.name.clone(),
                backend: format!("{:?}", info.backend),
                software: format!("{:?}", info.device_type) == "Cpu",
            });
        },
    );
    // 无窗口：native-renderer feature 不启用 bevy_winit（DefaultPlugins 不含 WinitPlugin）。
    // `primary_window: None` 不创建窗口，但保留 `bevy_window` 事件（render 的 camera_system
    // 依赖 WindowResized 事件）。ScheduleRunnerPlugin 提供替代 AppRunner，按固定节拍运行。
    app.add_plugins(
        DefaultPlugins
            .set(WindowPlugin {
                primary_window: None,
                // 不因“没有窗口”退出：本进程靠 AppExit（读到像素后）结束。
                exit_condition: bevy::window::ExitCondition::DontExit,
                ..default()
            })
            .set(RenderPlugin {
                render_creation: bevy::render::settings::RenderCreation::Automatic(
                    Default::default(),
                ),
                ..default()
            }),
    );
    app.add_plugins(ScheduleRunnerPlugin::run_loop(
        std::time::Duration::from_millis(8),
    ));
    let capture_ready = super::readiness::install(&mut app);

    // 原生 renderer 从同一共享 `model_core` 派生 AABB/extent，不信任调用方计算的 extent
    // （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 6.5）。
    let placement = request
        .placement
        .map(|placement| placement.to_model_placement())
        .unwrap_or_default();
    let model = crate::model3d::prepare_snapshot(ModelSnapshot {
        scene_version: Some(request.scene_version.clone()),
        ops: request.ops.clone(),
        signature: request.signature.clone(),
        extent: request.extent,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement,
    });
    let (root_transform, reference_center, reference_radius) =
        super::framing::reference_frame(&model, request.composite_asset_frame.as_ref());
    // 动画采样：在同一时刻求值模型部件增量与镜头状态（任务 4.2）。
    let sampled = request
        .motion
        .as_ref()
        .and_then(super::animation_sample::sample);
    let animation_camera = match &request.capture.camera_preset[..] {
        "initial" => request.motion.as_ref().map(|motion| {
            let mut camera = motion.initial_camera.clone();
            if let Some((state, _)) = &sampled {
                camera.azimuth = state.azimuth;
                camera.elevation = state.elevation;
                camera.distance = state.distance;
                camera.focus_offset = state.focus_offset.to_array();
            }
            camera
        }),
        _ => None,
    };
    let native_media = request
        .composite_asset_frame
        .as_ref()
        .map(|frame| frame.media.clone())
        .unwrap_or_default();
    let background = background_color(&capture.background);
    let pixels_setup = pixels.clone();
    let capture_setup = capture.clone();

    app.insert_resource(ClearColor(background));
    app.add_systems(
        Startup,
        move |mut commands: Commands,
              mut images: ResMut<Assets<Image>>,
              mut meshes: ResMut<Assets<Mesh>>,
              mut materials: ResMut<Assets<StandardMaterial>>| {
            let size = UVec2::new(capture_setup.width, capture_setup.height);
            let mut image = Image::new_uninit(
                bevy::render::render_resource::Extent3d {
                    width: size.x,
                    height: size.y,
                    ..default()
                },
                bevy::render::render_resource::TextureDimension::D2,
                bevy::render::render_resource::TextureFormat::Rgba8UnormSrgb,
                RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD,
            );
            image.texture_descriptor.usage |=
                TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT;
            let image = images.add(image);

            setup_lights(&mut commands);
            let (entities, bases, part_materials) = spawn_model(
                &mut commands,
                &mut meshes,
                &mut materials,
                &model,
                root_transform,
            );
            let media_planes = super::media::spawn_media(
                &mut commands,
                &mut meshes,
                &mut materials,
                &mut images,
                &native_media,
                &root_transform,
            );
            // 应用部件增量（旋转乘基础旋转，平移/缩放叠加）与透明度。
            // 透明度规则与可见播放同源：1 = 原透明模式、<1 = 专属材质 Blend、0 = 隐藏。
            if let Some((_, deltas)) = &sampled {
                let mut opacities: std::collections::HashMap<Entity, f32> =
                    std::collections::HashMap::new();
                for (part_id, delta) in deltas {
                    let (Some(entity), Some(base)) = (entities.get(part_id), bases.get(part_id))
                    else {
                        continue;
                    };
                    let transform = compose_delta(*base, delta);
                    commands.entity(*entity).insert(transform);
                    if !delta.opacity.is_finite() || delta.opacity >= 1.0 {
                        continue;
                    }
                    let opacity = delta.opacity.max(0.0);
                    if let Some(item_root) = super::super::part_id::decode_part_id(part_id)
                        .filter(|decoded| decoded.part_id.is_empty())
                    {
                        // 对象根：该对象名下全部块一起变透明（不拆块）。
                        for (candidate, _) in &part_materials {
                            if !super::super::part_id::belongs_to_item(candidate, item_root.item_id)
                            {
                                continue;
                            }
                            if let Some(target) = entities.get(candidate).copied() {
                                *opacities.entry(target).or_insert(1.0) *= opacity;
                            }
                        }
                        continue;
                    }
                    if part_materials.contains_key(part_id) {
                        *opacities.entry(*entity).or_insert(1.0) *= opacity;
                    }
                }
                for (entity, value) in opacities {
                    let Some(material) = part_materials
                        .iter()
                        .find(|(id, _)| entities.get(*id).copied() == Some(entity))
                        .map(|(_, handle)| handle.clone())
                    else {
                        continue;
                    };
                    apply_preview_opacity(&mut commands, &mut materials, entity, &material, value);
                }
                // 媒体平面：本身就有专属材质，直接写它的 alpha（对象根透明度同样生效）。
                for plane in &media_planes {
                    let Some(item_root) = deltas
                        .iter()
                        .find(|(part_id, _)| {
                            super::super::part_id::decode_part_id(part_id).is_some_and(|decoded| {
                                decoded.part_id.is_empty()
                                    && super::super::part_id::belongs_to_item(
                                        &plane.item_id,
                                        decoded.item_id,
                                    )
                            })
                        })
                        .map(|(_, delta)| delta.opacity)
                    else {
                        continue;
                    };
                    if let Some(mut material) = materials.get_mut(&plane.material) {
                        if item_root <= 0.0 {
                            commands.entity(plane.entity).insert(Visibility::Hidden);
                        } else if item_root < 1.0 {
                            material.alpha_mode = bevy::material::AlphaMode::Blend;
                            material.base_color.set_alpha(item_root.clamp(0.0, 1.0));
                        }
                    }
                }
            }
            match &animation_camera {
                Some(camera) => {
                    let (center, radius) = (reference_center, reference_radius);
                    // 场景单位镜头 → 生产输出世界：距离与焦点偏移按同一自然倍率缩放、按内容根旋转，
                    // 保证成片构图与节点矩形/画布 zoom 无关（change:
                    // 2026-10-23-isolate-film-set-camera-space，任务 3.1 / design D4）。
                    let scale =
                        if root_transform.scale.x.is_finite() && root_transform.scale.x > 0.0 {
                            root_transform.scale.x
                        } else {
                            1.0
                        };
                    let focus_offset =
                        root_transform.rotation * (Vec3::from_array(camera.focus_offset) * scale);
                    setup_animation_camera(
                        &mut commands,
                        image.clone(),
                        camera,
                        center + focus_offset,
                        radius,
                        scale,
                        background,
                    );
                }
                None => setup_camera(
                    &mut commands,
                    image.clone(),
                    reference_radius,
                    PREVIEW_DEPTH,
                    background,
                ),
            }

            super::readiness::enqueue_readback(
                &mut commands,
                image,
                pixels_setup.clone(),
                capture_ready.clone(),
            );
        },
    );

    app.run();

    let guard = pixels.lock().expect("pixels lock");
    guard
        .clone()
        .ok_or_else(|| "renderer 未产出像素".to_owned())
        .map(|data| normalize_readback(&data, width, height))
}

/// 回读缓冲可能带行对齐填充；裁剪到 `width*height*4`。
pub(super) fn normalize_readback(data: &[u8], width: u32, height: u32) -> Vec<u8> {
    let expected = (width as usize) * (height as usize) * 4;
    let row = width as usize * 4;
    let stride = row.div_ceil(256) * 256;
    if stride != row && data.len() >= stride * height as usize {
        return data
            .chunks(stride)
            .take(height as usize)
            .flat_map(|line| line[..row].iter().copied())
            .collect();
    }
    if data.len() >= expected {
        data[..expected].to_vec()
    } else {
        data.to_vec()
    }
}

/// RGBA8 → PNG（不新增纹理/外部依赖之外的编码器）。
pub(super) fn encode_png(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let expected = (width as usize) * (height as usize) * 4;
    if pixels.len() < expected {
        return Err(format!("像素数据不足：{} < {}", pixels.len(), expected));
    }
    let mut buffer = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buffer, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&pixels[..expected])
            .map_err(|error| error.to_string())?;
    }
    Ok(buffer)
}
