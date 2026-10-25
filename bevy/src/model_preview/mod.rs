//! Embedded model cards reuse model3d roots; each camera sees only its own layer.
mod gpu;
mod cache;
mod latency;
mod scheduling;
use scheduling::schedule;
mod policy;
mod startup;
pub(crate) mod render_work;
mod render_draw_work;
#[cfg(test)]
mod tests;
#[cfg(all(test, any(feature = "wasm", feature = "native-canvas"), target_os = "macos"))]
mod gpu_tests;

use crate::{
    app::{CurrentScene, FocusRig, ModelAssetTable, SurfaceState},
    canvas_query::layout,
    model3d,
};
use bevy::{
    asset::RenderAssetUsages,
    image::ImageSampler,
    prelude::*,
    camera::{RenderTarget, visibility::RenderLayers},
    render::{
        RenderApp, RenderSystems,
        extract_component::{ExtractComponent, ExtractComponentPlugin},
        render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Component, Clone, ExtractComponent)]
#[extract_app(RenderApp)]
pub(crate) struct PreviewView {
    pub(crate) camera: Entity,
    pub(crate) generation: u64,
    pub(crate) meshes: Vec<bevy::asset::AssetId<Mesh>>,
    pub(crate) materials: Vec<bevy::asset::AssetId<StandardMaterial>>,
    /// 卡片对应的模型根此刻是否存在。
    ///
    /// 与「根存在但没有 mesh」区分开：缺失时空画面只表示还没 spawn，不能当作已绘制；
    /// 合法的空模型（根存在、无 mesh）才是有效画面。
    pub(crate) rooted: bool,
}
#[derive(Resource, Clone, Default)]
pub(crate) struct Ready(Arc<Mutex<HashMap<Entity, u64>>>);
impl Ready {
    pub(crate) fn matches(&self, camera: Entity, generation: u64) -> bool {
        self.0.lock().unwrap().get(&camera).copied() == Some(generation)
    }
}
#[derive(Resource, Default)]
pub(crate) struct Previews {
    cards: HashMap<String, Card>,
    latency: latency::Latency,
    focus_node: Option<String>,
    tick: u64,
    retry_allocation: bool,
    deferred: HashMap<String, u64>,
    capture_pins: std::collections::HashSet<String>,
    /// 每个节点上一次实际下发的渲染层（含质量身份）：层与身份都未变时跳过重复写入
    /// （change: 2026-10-14-scope-film-set-object-picking-to-focus，design D7）。
    applied_layers: HashMap<String, (String, RenderLayers)>,
}
impl Previews {
    pub(crate) fn camera(&self, node_id: &str) -> Option<Entity> {
        self.cards.get(node_id).map(|card| card.camera)
    }

    /// 卡片相机的注视点（世界坐标）；透视取景换算用它确定相机到焦点的距离。
    pub(crate) fn pivot(&self, node_id: &str) -> Option<Vec3> {
        self.cards.get(node_id).map(|card| card.pivot)
    }

    /// 是否有排队/重试的预览分配仍在推进（需要连续帧，静止降频据此判定）。
    pub(crate) fn has_pending(&self) -> bool {
        self.retry_allocation || !self.deferred.is_empty()
    }
}
struct Card {
    camera: Entity,
    sprite: Entity,
    image: Handle<Image>,
    size: UVec2,
    layer: usize,
    signature: String,
    generation: u64,
    visible: bool,
    displayed: Handle<Image>,
    waiting_since: u64,
    live: bool,
    offscreen_since: Option<f64>,
    /// 卡片相机的注视点（世界坐标，含锚点与观察偏移）。
    ///
    /// 透视取景需要「相机到焦点」的真实距离：进入聚焦时按中心平面像素对齐换算整屏相机，
    /// 只靠 pose 反推距离会在观察偏移上放大误差。
    pivot: Vec3,
    /// 自何时起该卡片仍没有模型根（`None` 表示根存在）。
    ///
    /// 没有根的卡片画不出任何东西；若它长期占住调度槽，其它卡片会被饿死。等待有上限，
    /// 根出现后（表示身份变化）会重新武装并清零。
    awaiting_root_since: Option<u64>,
    /// 上一次实际写入的卡片相机 pose；未变则跳过命令。
    applied_pose: Option<Transform>,
    /// 上一次实际写入的 sprite 状态；未变则跳过命令。
    applied_sprite: Option<SpriteState>,
}

/// 卡片 sprite 的可见状态（位置/尺寸/可见性）；用于跳过重复命令。
#[derive(PartialEq)]
struct SpriteState {
    transform: Transform,
    size: Vec2,
    visible: bool,
}

/// 只在目标层（或质量身份）变化时对模型根下发 `RenderLayers`。
///
/// `RenderLayers` 不随层级继承，必须逐实体写入；去重依赖 `applied_layers`，
/// 并在质量/表示身份变化（根重建）时自动失效。
fn apply_preview_layer(
    commands: &mut Commands,
    state: &mut Previews,
    models: &mut model3d::ModelVisuals,
    id: &str,
    layer: usize,
    focused: bool,
) {
    let Some(layers) = models.preview_layers(id, layer, focused) else {
        // 根尚未 spawn（按需创建）：丢弃去重记录，保证根出现后重新写入层，
        // 否则新根的实体只带默认层，卡片相机看不到它。
        state.applied_layers.remove(id);
        return;
    };
    let identity = models.quality_identity(id);
    if state
        .applied_layers
        .get(id)
        .is_some_and(|(known, known_layers)| *known == identity && *known_layers == layers)
    {
        models.hot_path.preview_layer_skips += 1;
        return;
    }
    if let Some(inserted) = models.preview_layer(commands, id, layer, focused) {
        models.hot_path.preview_layer_inserts += inserted;
    }
    state.applied_layers.insert(id.to_owned(), (identity, layers));
}
pub(crate) struct ModelPreviewPlugin;
impl Plugin for ModelPreviewPlugin {
    fn build(&self, app: &mut App) {
        #[cfg(feature = "explicit-instancing")]
        app.add_plugins(model3d::instancing::InstancingPlugin);
        let ready = Ready::default();
        let work = render_work::RenderWork::default();
        #[cfg(feature = "explicit-instancing")]
        let work = work.with_instances(app.world().get_resource::<model3d::instancing::InstanceWork>()
            .cloned().unwrap_or_default());
        app.insert_resource(work.clone());
        app.insert_resource(ready.clone())
            .init_resource::<Previews>()
            .init_resource::<crate::app::PreviewLayerPool>()
            .add_plugins(ExtractComponentPlugin::<PreviewView>::default());
        if let Some(render) = app.get_sub_app_mut(RenderApp) {
            render_work::install(render, work);
            render.insert_resource(ready).add_systems(
                bevy::render::Render,
                gpu::observe.after(RenderSystems::Prepare).before(RenderSystems::Render),
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    mut commands: Commands,
    mut state: ResMut<Previews>,
    mut pool: ResMut<crate::app::PreviewLayerPool>,
    mut images: ResMut<Assets<Image>>,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    mut models: ResMut<model3d::ModelVisuals>,
    flags: Res<crate::app::FrameFlags>,
    resources: Res<ModelAssetTable>,
    theme: Res<crate::theme::ThemeResource>,
    ready: Res<Ready>,
    rig: Res<FocusRig>,
    mut cameras: Query<&mut Camera>,
    time: Res<Time>,
    render_work: Res<render_work::RenderWork>,
) {
    crate::bridge::set_render_stage_diagnostics(render_work.snapshot());
    state.tick = state.tick.wrapping_add(1);
    let now = time.elapsed_secs_f64();
    // 聚焦期间卡片被刻意隐藏（`visible` 恒为 false），但它的相机是退出聚焦时唯一的
    // 「卡片视角」来源：`focus_transition::overview_camera` 要靠它把整屏相机对齐回卡片像素。
    // 若在聚焦中把它当离屏回收，退出就只能退回等距画布相机，模型会沿画布锚点一路下移
    // （表现为「后退时模型固定往下走」）。因此聚焦中的目标卡片不参与离屏回收。
    let focused_card = rig.focus_node.as_deref();
    let expired: Vec<_> = state.cards.iter().filter(|(id, card)| {
        let focused = focused_card == Some(id.as_str());
        !focused && card.offscreen_since.is_some_and(|since| now - since >= 1.0)
    })
    .map(|(id, _)| id.clone())
    .collect();
    for id in expired {
        remove_card(&mut commands, &mut state, &mut pool, &mut images, &ready, &id);
    }
    let quality_changed = state.cards.iter().any(|(id, card)|
        !card.signature.ends_with(&format!(":{}", models.quality_identity(id))));
    let pins_changed = state.capture_pins != *models.capture_pins();
    if !pins_changed && !flags.camera_changed && !flags.changed && !flags.observer_changed && !quality_changed && !state.retry_allocation && state.focus_node == rig.focus_node {
        schedule(&mut commands, &mut state, &mut images, &ready, &mut cameras);
        return;
    }
    state.capture_pins.clone_from(models.capture_pins());
    state.focus_node = rig.focus_node.clone();
    let scene = &scene.0;
    let alive: std::collections::HashSet<&str> = scene
        .nodes
        .iter()
        .filter(|n| n.model_preview.is_some() && n.model.is_some())
        .map(|n| n.id.as_str())
        .collect();
    let stale: Vec<String> = state
        .cards
        .keys()
        .filter(|id| !alive.contains(id.as_str()))
        .cloned()
        .collect();
    for id in stale {
        remove_card(&mut commands, &mut state, &mut pool, &mut images, &ready, &id);
    }
    let clear = theme.token_color("canvasNodeContent");
    let tick = state.tick;
    state.retry_allocation = false;
    state.deferred.retain(|id, _| alive.contains(id.as_str()));
    state.latency.retain(&alive);
    let interactive = |id: &str| scene.hover.as_ref().and_then(|h| h.node_id.as_deref()) == Some(id)
        || scene.animation_playback.as_ref().is_some_and(|p| p.node_id == id);
    let viewport = crate::model3d::grid::scene_view(scene);
    let mut order: Vec<_> = scene.nodes.iter().enumerate().collect();
    order.sort_by_key(|(index, node)| (startup::priority(interactive(&node.id), state.deferred.get(&node.id).copied(), tick), *index));
    let mut start_budget = startup::StartBudget::new();
    for (index, node) in order {
        let (Some(view), Some(reference)) = (&node.model_preview, &node.model) else {
            continue;
        };
        let Some(resource) = resources.0.get(&reference.resource_key) else {
            continue;
        };
        let Some((bounds, anchor)) = model3d::model_bounds_for_node(resource, &reference.placement, node)
        else {
            continue;
        };
        let display = crate::canvas_query::focus_context::node(scene, node);
        let index = crate::canvas_query::focus_context::index(scene, &node.id, index);
        let (x, y, width, height) = layout::content_rect(&display);
        let context = crate::canvas_query::focus_context::contains(scene, &node.id);
        let viewport = if context { crate::isometric_grid::IsometricGridView { x: 0., y: 0., zoom: 1. } } else { viewport };
        let visible = (rig.focus_node.is_none() && scene.model_focus.is_none())
            && x * viewport.zoom + viewport.x < surface.size.x
            && (x + width) * viewport.zoom + viewport.x > 0.
            && y * viewport.zoom + viewport.y < surface.size.y
            && (y + height) * viewport.zoom + viewport.y > 0.;
        // Descriptor/query registration is independent of preview allocation.
        if !visible && !state.cards.contains_key(&node.id) {
            apply_preview_layer(
                &mut commands,
                &mut state,
                &mut models,
                &node.id,
                31,
                rig.focus_node.as_deref() == Some(node.id.as_str()),
            );
            continue;
        }
        let size = preview_target_size(
            width,
            height,
            viewport.zoom,
            scene
                .surface
                .as_ref()
                .map_or(1.0, |surface| surface.pixel_ratio),
        );
        // Across all retained cards, displayed + pending textures stay within
        // 128 MiB of RGBA8 pixels (excluding driver/MSAA attachments).
        //
        // The divisor is the **admitted/retained** card count, never the document
        // model count: adding 999 off-screen models (design D6, task 6.6) must not
        // shrink the visible preview of a fixed demand.
        let budget_cards = state.cards.len() + usize::from(!state.cards.contains_key(&node.id));
        let size = budget_target_size(size, budget_cards);
        let size = state.cards.get(&node.id).map_or(size, |card|
            policy::retained_size(card.size, size, budget_target_size(card.size, budget_cards) == card.size));
        // Account for real retained generations, rather than assuming every
        // displayed image already follows today's per-card budget.
        let replaceable = state.cards.get(&node.id).filter(|card| card.image != card.displayed)
            .map_or(0, |card| image_bytes(&images, &card.image));
        let available = policy::MAX_TEXTURE_BYTES.saturating_sub(texture_bytes(&state, &images).saturating_sub(replaceable));
        // Lens framing follows the logical card, independent of texture rounding/capping.
        let aspect = width.max(1.0) / height.max(1.0);
        let relative_center = Vec3::from_array(view.target_offset);
        let radius = (Vec3::from_array(bounds.max) - Vec3::from_array(bounds.min)).length() * 0.5;
        let fov = crate::orbit_camera::ORBIT_DEFAULT_FOV;
        let distance = fit_distance(radius.max(0.01), aspect) * view.distance_scale;
        let offset = Vec3::new(
            view.azimuth.sin() * view.elevation.cos(),
            view.elevation.sin(),
            view.azimuth.cos() * view.elevation.cos(),
        ) * distance;
        let relative_pose = Transform::from_translation(relative_center + offset)
            .looking_at(relative_center, Vec3::Y);
        let pivot = anchor + bounds.center() + relative_center;
        let pose = Transform {
            translation: pivot + offset,
            ..relative_pose
        };
        // 透视卡片预览：与聚焦观察镜头同一姿态、同一距离与 50° FOV，因此模型中心平面的
        // 可见高度仍是 `2·d·tan(fov/2)`，与聚焦首帧尺寸连续；但近处几何自然放大、远处收缩，
        // 卡片不再是「无透视」的正交画面。近裁剪面沿用聚焦镜头同一常量，进出聚焦不改裁剪语义。
        let projection = Projection::Perspective(PerspectiveProjection {
            fov,
            near: crate::model3d::focus::FOCUS_NEAR,
            far: crate::orbit_camera::ORBIT_DEFAULT_FAR,
            ..default()
        });
        let signature = cache::signature(node, reference, relative_pose, size, &projection,
            clear, &models.quality_identity(&node.id));
        let new_card = !state.cards.contains_key(&node.id);
        if state.cards.get(&node.id).is_none_or(|card| card.signature != signature) {
            state.latency.invalidate(&node.id);
        }
        if new_card {
            if !start_budget.permits() {
                state.deferred.entry(node.id.clone()).or_insert(tick);
                state.retry_allocation = true;
                continue;
            }
            // Layers come from the shared pool: an unused layer is rented only
            // after older views stop, so model and shot cards can never share a
            // layer. Exhaustion defers the card instead of growing layer numbers.
            let Some(slot) = pool.0.acquire(&node.id) else {
                pool.0.note_exhausted();
                state.deferred.entry(node.id.clone()).or_insert(tick);
                state.retry_allocation = true;
                continue;
            };
            let layer = slot.layer;
            let Some(allocated_size) = policy::fit_bytes(size, available) else {
                state.deferred.entry(node.id.clone()).or_insert(tick);
                state.retry_allocation = true;
                continue;
            };
            start_budget.started();
            let image = preview_image(&mut images, allocated_size);
            let camera = commands
                .spawn((
                    Camera3d::default(),
                    Camera {
                        order: -10,
                        is_active: false,
                        clear_color: ClearColorConfig::Custom(clear),
                        ..default()
                    },
                    RenderTarget::Image(image.clone().into()),
                    pose,
                    projection.clone(),
                    RenderLayers::from_layers(&[layer]),
                    Msaa::Sample4,
                    bevy::render::view::Tonemapping::None,
                    bevy::render::view::DebandDither::Disabled,
                    // 就绪门禁只统计可逐项计数的直接绘制队列；Bevy 的 multidraw 实例数是
                    // 私有字段，GPU 间接绘制的卡片会「画出来了却永远不 ready」，Sprite 因此
                    // 一直显示灰底。与截图相机同一策略（shot_camera/capture.rs）。
                    bevy::render::view::NoIndirectDrawing,
                ))
                .id();
            let sprite = commands
                .spawn((
                    Sprite {
                        image: image.clone(),
                        custom_size: Some(Vec2::new(width, height)),
                        ..default()
                    },
                    Transform::from_xyz(
                        x + width / 2.,
                        -y - height / 2.,
                        10.01 + index as f32 * 0.1,
                    ),
                ))
                .id();
            state.cards.insert(
                node.id.clone(),
                Card {
                    camera,
                    sprite,
                    displayed: image.clone(),
                    image,
                    size: allocated_size,
                    layer,
                    signature: String::new(),
                    generation: 0,
                    visible: false,
                    waiting_since: tick,
                    live: false,
                    offscreen_since: None,
                    pivot,
                    awaiting_root_since: None,
                    applied_pose: None,
                    applied_sprite: None,
                },
            );
        }
        let signature_changed = state.cards[&node.id].signature != signature;
        let admitted = !signature_changed || new_card || start_budget.permits();
        if !admitted {
            state.deferred.entry(node.id.clone()).or_insert(tick);
            state.retry_allocation = true;
        } else if !signature_changed {
            state.deferred.remove(&node.id);
        }
        let mut admitted_generation = None;
        let card = state.cards.get_mut(&node.id).unwrap();
        let focused = rig.focus_node.as_deref() == Some(node.id.as_str());
        let card_layer = card.layer;
        apply_preview_layer(&mut commands, &mut state, &mut models, &node.id, card_layer, focused);
        let card = state.cards.get_mut(&node.id).unwrap();
        card.pivot = pivot;
        card.visible = visible;
        if visible { card.offscreen_since = None; }
        else { card.offscreen_since.get_or_insert(now); }
        card.live = scene.hover.as_ref().and_then(|h| h.node_id.as_deref()) == Some(node.id.as_str())
            || scene.animation_playback.as_ref().is_some_and(|p| p.node_id == node.id);
        // 根缺失时卡片画不出内容；记录起点，让调度给它一个有界的等待窗口。
        // Native 后台准备中的根同样是「内容还在路上」：不算合法空场、不发布灰底，
        // 只按既有有界等待让位（change: 2026-10-18-prepare-native-film-sets-in-background）。
        if models.has_or_prepares_root(&node.id) {
            card.awaiting_root_since = None;
        } else {
            card.awaiting_root_since.get_or_insert(tick);
        }
        if !signature_changed {
            // A live/pending view must follow the moved subject even when its
            // static image identity and readiness generation stay unchanged.
            if card.applied_pose != Some(pose) {
                commands.entity(card.camera).insert(pose);
                card.applied_pose = Some(pose);
                models.hot_path.preview_pose_inserts += 1;
            } else {
                models.hot_path.preview_pose_skips += 1;
            }
        }
        let sprite_state = SpriteState {
            transform: Transform::from_xyz(x + width / 2., -y - height / 2., 10.01 + index as f32 * 0.1),
            size: Vec2::new(width, height),
            // 运行中让位给进度环：卡片实时画面与图片纹理同策略隐藏
            // （change: show-agent-turn-running-state-on-node）。否则 3D 卡片预览会盖住
            // `generation::sync_generation` 画在内容面上的进度环与百分比，看起来像没反应。
            visible: visible && !node.busy,
        };
        if card.applied_sprite.as_ref() != Some(&sprite_state) {
            let sprite_visible = sprite_state.visible;
            commands.entity(card.sprite).insert((
                sprite_state.transform,
                Sprite {
                    image: card.displayed.clone(),
                    custom_size: Some(sprite_state.size),
                    ..default()
                },
                if sprite_visible {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                },
            ));
            card.applied_sprite = Some(sprite_state);
            models.hot_path.preview_sprite_inserts += 1;
        } else {
            models.hot_path.preview_sprite_skips += 1;
        }
        if signature_changed && admitted {
            if card.generation > 0 {
                let Some(allocated_size) = policy::fit_bytes(size, available) else {
                    state.deferred.entry(node.id.clone()).or_insert(tick);
                    state.retry_allocation = true;
                    continue;
                };
                start_budget.started();
                if card.image != card.displayed { images.remove(card.image.id()); }
                card.image = preview_image(&mut images, allocated_size);
                card.size = allocated_size;
                commands.entity(card.camera).insert(RenderTarget::Image(card.image.clone().into()));
            }
            // Preserve queue age when superseding unfinished work.
            if ready.0.lock().unwrap().get(&card.camera).copied() == Some(card.generation) {
                card.waiting_since = tick;
            }
            card.signature = signature;
            card.generation = card.generation.wrapping_add(1);
            admitted_generation = Some(card.generation);
            commands.entity(card.camera).insert((
                pose,
                projection,
                PreviewView {
                    camera: card.camera,
                    generation: card.generation,
                    meshes: models.preview_meshes(&node.id),
                    materials: models.preview_materials(&node.id),
                    rooted: models.has_root(&node.id),
                },
            ));
            // 记录已下发的 pose，避免新旧签名交替时多写一次。
            card.applied_pose = Some(pose);
            models.hot_path.preview_pose_inserts += 1;
        }
        if signature_changed && admitted { state.deferred.remove(&node.id); }
        if let Some(generation) = admitted_generation { state.latency.admitted(&node.id, generation); }
    }
    schedule(&mut commands, &mut state, &mut images, &ready, &mut cameras);
    let mut layers = RenderLayers::from_layers(&[0, model3d::capture::CAPTURE_LAYER]);
    for card in state.cards.values() {
        layers = layers.with(card.layer);
    }
    // Share the existing scene illumination instead of spawning a light per node.
    commands.queue(move |world: &mut World| {
        merge_scene_light_layers(world, &layers);
    });
}

// Shot cards and ordinary model cards share these lights. Their independent
// refresh schedules must merge layers, otherwise a focus/overview transition
// removes shot illumination while its cached layer set still looks current.
fn merge_scene_light_layers(world: &mut World, layers: &RenderLayers) {
    let mut lights = world.query_filtered::<Entity, With<DirectionalLight>>();
    let entities: Vec<_> = lights.iter(world).collect();
    for entity in entities {
        let existing = world.get::<RenderLayers>(entity).cloned().unwrap_or_default();
        world.entity_mut(entity).insert(existing.union(layers));
    }
}
fn make_image(size: UVec2) -> Image {
    let mut image = Image::new_uninit(
        Extent3d {
            width: size.x,
            height: size.y,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::default(),
    );
    image.texture_descriptor.usage |=
        TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING;
    image.sampler = ImageSampler::linear();
    image
}
fn preview_image(images: &mut Assets<Image>, size: UVec2) -> Handle<Image> {
    images.add(make_image(size))
}

fn remove_card(
    commands: &mut Commands,
    state: &mut Previews,
    pool: &mut crate::app::PreviewLayerPool,
    images: &mut Assets<Image>,
    ready: &Ready,
    id: &str,
) {
    state.deferred.remove(id);
    state.latency.cancel(id);
    state.applied_layers.remove(id);
    let Some(card) = state.cards.remove(id) else { return; };
    // 层只在旧视图停止（实体销毁 + 就绪记录移除）后归还，下一次出租推进代数。
    pool.0.release(id);
    commands.entity(card.camera).try_despawn();
    commands.entity(card.sprite).try_despawn();
    images.remove(card.image.id());
    if card.displayed != card.image { images.remove(card.displayed.id()); }
    ready.0.lock().unwrap().remove(&card.camera);
}
fn image_bytes(images: &Assets<Image>, handle: &Handle<Image>) -> u64 {
    images.get(handle).map_or(0, |image|
        image.texture_descriptor.size.width as u64 * image.texture_descriptor.size.height as u64 * 4)
}

fn texture_bytes(state: &Previews, images: &Assets<Image>) -> u64 {
    let mut ids = std::collections::HashSet::new();
    state.cards.values().flat_map(|card| [&card.image, &card.displayed])
        .filter(|handle| ids.insert(handle.id())).map(|handle| image_bytes(images, handle)).sum()
}

// Render at displayed physical resolution, including zoomed-out cards. Round the longest edge into buckets to avoid reallocating
// textures for every small zoom change. Cap both axes uniformly to preserve aspect.
fn preview_target_size(width: f32, height: f32, zoom: f32, pixel_ratio: f32) -> UVec2 {
    const MAX_EDGE: f32 = 2048.0;
    const BUCKET: f32 = 64.0;
    let positive = |value: f32| {
        if value.is_finite() && value > 0.0 {
            value
        } else {
            1.0
        }
    };
    let width = positive(width);
    let height = positive(height);
    let edge = width.max(height);
    let scale = positive(zoom) * positive(pixel_ratio);
    let target_edge = ((edge * scale / BUCKET).ceil() * BUCKET).clamp(BUCKET, MAX_EDGE);
    UVec2::new(
        (width / edge * target_edge).ceil().clamp(1.0, MAX_EDGE) as u32,
        (height / edge * target_edge).ceil().clamp(1.0, MAX_EDGE) as u32,
    )
}

// Same sphere fit and lens as the observer and Web autoFrameDistance.
fn fit_distance(radius: f32, aspect: f32) -> f32 {
    crate::model3d::quality::preview_fit_distance(radius, aspect)
}

fn budget_target_size(size: UVec2, cards: usize) -> UVec2 {
    const PIXELS_PER_GENERATION: f32 = 16_777_216.;
    let budget = PIXELS_PER_GENERATION / cards.max(1) as f32;
    let pixels = size.x as f32 * size.y as f32;
    if pixels <= budget { return size; }
    let scale = (budget / pixels).sqrt();
    UVec2::new((size.x as f32 * scale).floor().max(1.) as u32, (size.y as f32 * scale).floor().max(1.) as u32)
}
