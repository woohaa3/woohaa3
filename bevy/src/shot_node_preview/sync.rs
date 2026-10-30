//! 卡片预览的 ECS 装配：串行采样系统与诊断
//! （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
//!
//! 本文件是 [`super`] 的运行时系统部分（只在 `wasm` 编译）。状态类型与装配辅助在
//! [`super::state`]；所有**判定**都在纯模块里（[`super::policy`] 尺寸/预算/串行、
//! [`super::plan`] 目标与采样身份、`crate::canvas_query::shot_preview` 卡片几何）。
//!
//! 关键不变式（design D7）：
//! - **全局每帧至多一个拍摄取景采样任务**：每张卡片有自己的 rig，但只有被选中的 rig 收到
//!   `TriggerShotPreview`（Manual 策略），因此同一帧只有一路取景真正渲染；
//! - **同一 rig 串行承担所有时刻**：目标切换/内容 dirty 时整条 rig 的 pose/lens/target 与
//!   采样身份一起推进，避免「只换相机漏换对象/媒体」；迟到结果按采样身份与就绪代数丢弃；
//! - **活动卡片每帧重画同一身份**：采样身份不含播放时钟，所以活动卡片每帧重新触发同一 rig
//!   把当前 T 画进同一张 Image，而就绪代数只在源内容/尺寸档/播放会话变化时推进；
//! - 屏外不新建 render target、不排连续帧；缓存超预算时优先保留活动目标。

use std::collections::{HashMap, HashSet};

use bevy::prelude::*;

use crate::{
    app::{AnimationCameraState, CurrentScene, ModelAssetTable},
    canvas_ecs::components::ShotPreviewSprite,
    model3d,
    shot_camera::{
        PreviewTarget, PreviewUpdatePolicy, ShotCameraCommands, ShotCameraConfig,
        ShotCameraEditable, ShotCameraLens, ShotCameraPreview, ShotPreviewOutput,
        TriggerShotPreview,
        preview_readiness::{ShotPreviewReadiness, ShotPreviewReady},
    },
};

use super::plan::LiveSampling;
use super::state::{
    Card, ShotPreviewCards, ShotPreviewRig, SpriteState, acquire_layer, apply_light_layers,
    card_camera_layers, identity_of, remove_card, rig_state_of,
    take_generation, target_component_of,
};
use super::{plan, policy};

/// 同步全部卡片预览：清理失效、创建/更新可见卡片、串行推进唯一采样目标。
///
/// 每帧运行：即使场景未变，也要在资源就绪后确认发布并回收缓存。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    mut commands: Commands,
    mut cards: ResMut<ShotPreviewCards>,
    mut layers: ResMut<crate::app::PreviewLayerPool>,
    scene: Res<CurrentScene>,
    index: Res<crate::app::NodeIndex>,
    models: Res<model3d::ModelVisuals>,
    resources: Res<ModelAssetTable>,
    animation_camera: Res<AnimationCameraState>,
    ready: Res<ShotPreviewReady>,
    outputs: Query<&ShotPreviewOutput>,
    time: Res<Time<Real>>,
    capture: Res<model3d::capture::ShotCaptureRouting>,
) {
    cards.tick = cards.tick.wrapping_add(1);
    let tick = cards.tick;
    let context_zoom = crate::canvas_query::focus_context::viewport(&scene.0)[2];
    let now = time.elapsed_secs_f64();
    cards.work.waiting = 0;
    let live = scene
        .0
        .animation_playback
        .as_ref()
        .filter(|playback| playback.view_mode == "shot-node-preview")
        .zip(animation_camera.0.as_ref())
        .map(|(playback, camera)| LiveSampling { playback, camera });
    let bounds_of = |node_id: &str| {
        model3d::shot_adapter::model_bounds_for_node(&scene.0, &models, &resources.0, node_id)
    };
    let quality_of = |node_id: &str| models.quality_identity(node_id);
    let preparing_of =
        |node_id: &str| models.preparation_state(node_id) == model3d::RootState::Pending;
    let display_of = |node_id: &str| {
        model3d::shot_adapter::display_unit_for_node(&scene.0, &resources.0, node_id)
    };
    let targets = plan::targets_with_preparation(
        &scene.0,
        &bounds_of,
        &quality_of,
        live,
        &preparing_of,
        &display_of,
    );
    let capture_pins = capture.pins(&scene.0);
    let pixel_ratio = scene
        .0
        .surface
        .as_ref()
        .map_or(1.0, |surface| surface.pixel_ratio);

    // 1. 清理不在目标集合里的卡片（源镜头删除/归属失效/被移除）。
    let alive: HashSet<&str> = targets
        .iter()
        .filter(|target| {
            let presentation_hidden = scene.0.model_focus.is_some()
                || index
                    .node(&scene.0, &target.node_id)
                    .is_some_and(|(_, node)| crate::canvas_query::shot_preview::hidden(node));
            // 参考已就绪的卡片不再保留 rig：显示录制内容（状态回到待更新/播放时重建）。
            (!presentation_hidden && !target.settled)
                || policy::needs_rig(
                    target.visible,
                    target.live,
                    capture_pins.contains(&target.node_id),
                    target.settled,
                )
        })
        .map(|target| target.node_id.as_str())
        .collect();
    let stale: Vec<String> = cards
        .cards
        .keys()
        .filter(|id| !alive.contains(id.as_str()))
        .cloned()
        .collect();
    for id in stale {
        remove_card(&mut commands, &mut cards, &mut layers, &ready, &id);
    }

    // 2. 目标尺寸档：按卡片实际显示像素分档（最长边 1024），并收敛到剩余像素预算内。
    let mut sizes: Vec<UVec2> = Vec::with_capacity(targets.len());
    for target in &targets {
        // 同代节点索引：按 id 定位，替代逐目标全文档扫描（design D7 / 任务 7.2）。
        let (width, height) = index
            .node(&scene.0, &target.node_id)
            .map(|(_, node)| {
                // Capture/preview resolution always follows the real card, never a focus tag.
                let (_, _, width, height) =
                    crate::canvas_query::shot_preview::content_rect_of(node);
                (width, height)
            })
            .unwrap_or((240.0, 135.0));
        // 先按镜头画幅 contain，再分配纹理，避免 resize 改变相机投影。
        let fitted_width = width.min(height * target.aspect);
        let fitted_height = fitted_width / target.aspect;
        let requested = policy::target_size(fitted_width, fitted_height, context_zoom, pixel_ratio);
        // 已保留像素只统计其它卡片（本卡片换档时旧纹理会被释放，不重复计入）。
        let retained = cards.retained_pixels().saturating_sub(
            cards
                .cards
                .get(&target.node_id)
                .map_or(0, |card| card.size.x as u64 * card.size.y as u64),
        );
        let available = policy::MAX_PIXELS.saturating_sub(retained).max(1);
        let requested =
            policy::fit_pixels(requested, available).unwrap_or(UVec2::splat(policy::BUCKET as u32));
        let size = if let Some(card) = cards.cards.get_mut(&target.node_id) {
            let settled = card.resize.update(
                [width, height, context_zoom, pixel_ratio],
                requested,
                card.size,
                now,
            );
            // 一次换档先完成发布，避免保留旧图的预算让待确认尺寸反复收缩。
            if card.published.is_some() && !card.published_current {
                card.size
            } else {
                settled
            }
        } else {
            requested // 首次画面立即创建，不等待缩放防抖。
        };
        sizes.push(size);
    }

    // 3. 创建/更新卡片（rig + sprite），并汇总 owner → 层并集。
    //
    // 层从共享层池租出（与模型卡片同一池）：池满时本卡片排队等待，不与其他视图共用层。
    let mut owner_layers: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, target) in targets.iter().enumerate() {
        if !cards.cards.contains_key(&target.node_id)
            && !policy::needs_rig(
                target.visible,
                target.live,
                capture_pins.contains(&target.node_id),
                target.settled,
            )
        {
            cards.pending_layers.remove(&target.node_id);
            continue;
        }
        let Some(layer) = acquire_layer(&mut layers, &target.node_id) else {
            // 池满：保留已有卡片的合法画面，新卡片排队（不无界增长层号）。
            cards.pending_layers.insert(target.node_id.clone());
            continue;
        };
        cards.pending_layers.remove(&target.node_id);
        owner_layers
            .entry(target.owner.clone())
            .or_default()
            .push(layer);
        let size = sizes[index];
        let rig_state = rig_state_of(target, size);
        if !cards.cards.contains_key(&target.node_id) {
            if !policy::needs_rig(
                target.visible,
                target.live,
                capture_pins.contains(&target.node_id),
                target.settled,
            ) {
                continue; // 仅屏外闲置卡片不创建；播放与捕捉不依赖视区。
            }
            // 归属片场仍在准备：先等待，不建立「空场」采样（发布后表示身份变化会重新武装）。
            if target.awaiting_root {
                continue;
            }
            let rig = commands.spawn_shot_camera(ShotCameraConfig {
                pose: target.pose,
                lens: ShotCameraLens::from_aspect(target.aspect),
                target: target_component_of(target),
                view_mask: card_camera_layers(layer),
                preview: Some(
                    ShotCameraPreview::new(size.x, size.y)
                        .with_target(PreviewTarget::Offscreen)
                        .with_policy(PreviewUpdatePolicy::Manual)
                        .with_clear_color(target.backdrop),
                ),
                editable: false,
            });
            commands
                .entity(rig)
                .insert((ShotPreviewRig { layer }, Name::new("shot-preview-rig")));
            // Sprite 先隐藏：首次确认前不显示未渲染的纹理（准备态由卡片正文表达）。
            let sprite = commands
                .spawn((
                    Sprite {
                        custom_size: Some(Vec2::new(1.0, 1.0)),
                        ..default()
                    },
                    Transform::from_xyz(0.0, 0.0, 10.01),
                    Visibility::Hidden,
                    // 归属 rig 与预览节点身份写在实体上；`ShotPreviewCards` 只保留采样状态。
                    ShotPreviewSprite {
                        node_id: target.node_id.clone(),
                        owner: rig,
                    },
                ))
                .id();
            cards.cards.insert(
                target.node_id.clone(),
                Card {
                    rig,
                    sprite,
                    // 归属片场 canonical 节点 id：截图 pin 与诊断用（change: 2026-10-15，任务 8.4）。
                    owner: target.owner.clone(),
                    size,
                    resize: policy::ResizeDebounce::default(),
                    published: None,
                    published_current: false,
                    layer,
                    dispatched: None,
                    generation: 0,
                    confirmed: false,
                    live: target.live,
                    requested: 0,
                    last_touched: 0,
                    waiting_since: tick,
                    visible: target.visible,
                    applied_sprite: None,
                    applied_rig: Some(rig_state),
                },
            );
            continue;
        }
        let card = cards.cards.get_mut(&target.node_id).unwrap();
        card.visible = target.visible;
        card.live = target.live;
        let layer_changed = card.layer != layer;
        card.layer = layer;
        if layer_changed {
            card.dispatched = None;
            card.confirmed = false;
            card.published_current = false;
        }
        if card.size != size {
            // 尺寸档变化：整条采样身份作废，等 shot_camera 重建纹理后再确认。
            card.size = size;
            card.published_current = false;
            card.dispatched = None;
            card.confirmed = false;
        }
        // rig 派生输入未变则跳过写入；pose/target/画幅/尺寸变化或活动卡片（同一 T 的采样相机）
        // 才重写。
        if layer_changed || card.live || card.applied_rig.as_ref() != Some(&rig_state) {
            commands.entity(card.rig).insert((
                target.pose,
                ShotCameraLens::from_aspect(target.aspect),
                target_component_of(target),
                card_camera_layers(layer),
                ShotCameraPreview::new(size.x, size.y)
                    .with_target(PreviewTarget::Offscreen)
                    .with_policy(PreviewUpdatePolicy::Manual)
                    .with_clear_color(target.backdrop),
                ShotCameraEditable { enabled: false },
            ));
            card.applied_rig = Some(rig_state);
        } else {
            cards.work.rig_skips += 1;
        }
    }

    // 4. owner 层并集只在变化时写回模型根与媒体平面；卡片层同时并入场景方向光。
    cards.desired_layers = owner_layers;
    apply_light_layers(&mut commands, &mut cards);

    // 5. 确认上一帧下发的采样代数（渲染侧真实稳定后才算发布）。
    let mut confirmed = 0u64;
    let mut waiting = 0u64;
    for card in cards.cards.values_mut() {
        if card.dispatched.is_none() {
            card.confirmed = false;
            continue;
        }
        // 已确认的同一代不因相机本帧未参与采样而退回准备态。
        card.confirmed |= ready.matches(card.rig, card.generation)
            && outputs
                .get(card.rig)
                .is_ok_and(|output| output.size == card.size);
        if card.confirmed {
            if let Ok(output) = outputs.get(card.rig) {
                card.published = Some((output.image.clone(), output.size));
                card.published_current = true;
            }
        }
        if card.confirmed {
            card.last_touched = tick;
            confirmed += 1;
        } else if card.visible {
            waiting += 1;
        }
    }
    cards.work.waiting += waiting;
    cards.work.samples += confirmed;

    // 6. 串行推进唯一采样目标：活动镜头优先，否则排空等待最久的封面。
    //
    // 候选 = 可见且需要新画面的卡片。除「下发身份与当前身份不同（源内容/尺寸档/播放会话变化）」
    // 外，**尚未被渲染侧确认**的卡片也必须持续成为候选：Manual 策略只在被选中那一帧激活相机，
    // 而首次创建相机的帧会以 `is_active: false` 提前返回，因此若确认前停止重触发，相机会永远
    // 不激活、`confirmed` 永远为 false（画面空白）。活动卡片每帧重画同一身份以推进播放时钟。
    // 首版全局每帧至多一个拍摄取景采样任务；停止播放后封面按队列年龄公平排空。
    let mut candidates: Vec<policy::Candidate> = Vec::new();
    for target in &targets {
        let Some(card) = cards.cards.get(&target.node_id) else {
            continue;
        };
        let needs = card.live
            || !card.confirmed
            || card.dispatched.as_ref() != Some(&identity_of(target, card.size));
        if policy::needs_rig(
            target.visible,
            target.live,
            capture_pins.contains(&target.node_id),
            target.settled,
        ) && needs
        {
            candidates.push(policy::Candidate {
                id: target.node_id.clone(),
                live: target.live || capture_pins.contains(&target.node_id),
                waiting_since: card.waiting_since,
                last_touched: card.last_touched,
            });
        }
    }
    candidates = policy::bound_candidates(candidates);
    let selected = policy::select(&candidates).map(|candidate| candidate.id.clone());
    cards.active = selected.clone();
    if let Some(id) = &selected {
        let (rig, identity, already_dispatched, superseded) = {
            let card = cards.cards.get(id).expect("selected card exists");
            let target = targets
                .iter()
                .find(|target| &target.node_id == id)
                .expect("selected target exists");
            let identity = identity_of(target, card.size);
            let same = card.dispatched.as_ref() == Some(&identity);
            let superseded = card.dispatched.is_some() && !same && !card.confirmed;
            (card.rig, identity, same, superseded)
        };
        // 同一身份重复选中时保持原代数（不因每帧重排而误判迟到）；身份变化才推进代数，
        // 使迟到结果无法覆盖新目标。
        let generation = if already_dispatched {
            cards.cards[id].generation
        } else {
            let generation = take_generation(&mut cards);
            let card = cards.cards.get_mut(id).unwrap();
            card.dispatched = Some(identity);
            card.generation = generation;
            card.confirmed = false;
            card.waiting_since = tick;
            generation
        };
        if superseded {
            cards.work.superseded += 1;
        }
        let (meshes, materials) = {
            let target = targets
                .iter()
                .find(|target| &target.node_id == id)
                .expect("selected target exists");
            (
                models.preview_meshes(&target.owner),
                models.preview_materials(&target.owner),
            )
        };
        commands.entity(rig).insert(ShotPreviewReadiness {
            key: rig,
            generation,
            meshes,
            materials,
        });
        cards.cards.get_mut(id).unwrap().requested = tick;
        // Manual 策略：显式触发一次渲染；同一帧最多一路（shot_camera 的预算再兜底）。
        commands.write_message(TriggerShotPreview { camera: rig });
    }

    // 7. 同步每张卡片的 sprite 摆放/可见性（位置变化不重编译几何）。
    //
    // 新结果只在确认后发布；等待期间继续显示最后已发布画面，首次加载才隐藏。
    for target in &targets {
        // 屏外目标从不新建卡片（第 3 步的 D7 规则），这里必须同样跳过；否则会解引用不存在的卡片。
        let Some(card) = cards.cards.get(&target.node_id) else {
            continue;
        };
        let (sprite, visible, size, image) = {
            let (image, size) = card
                .published
                .as_ref()
                .map_or((None, card.size), |(image, size)| {
                    (Some(image.clone()), *size)
                });
            (card.sprite, card.visible, size, image)
        };
        let Some((node_index, node)) = index.node(&scene.0, &target.node_id) else {
            continue;
        };
        let display = crate::canvas_query::focus_context::node(&scene.0, node);
        let node = display.as_ref();
        let node_index = crate::canvas_query::focus_context::index(&scene.0, &node.id, node_index);
        let (x, y, width, height) = crate::canvas_query::shot_preview::content_rect_of(node);
        let content = crate::canvas_query::shot_preview::texture_size(
            node,
            Vec2::new(size.x as f32, size.y as f32),
        );
        let z = 10.01 + node_index as f32 * 0.1;
        let state = SpriteState {
            transform: Transform::from_xyz(x + width / 2.0, -(y + height / 2.0), z),
            size: content,
            image: image
                .as_ref()
                .map_or(bevy::asset::AssetId::default(), |handle| handle.id()),
            visible,
        };
        let card = cards.cards.get_mut(&target.node_id).unwrap();
        if card.applied_sprite.as_ref() == Some(&state) {
            continue;
        }
        if let Some(image) = image {
            commands.entity(sprite).insert((
                Sprite {
                    image,
                    custom_size: Some(state.size),
                    ..default()
                },
                state.transform,
                if visible {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                },
            ));
        } else {
            commands.entity(sprite).insert((
                Sprite {
                    custom_size: Some(state.size),
                    ..default()
                },
                state.transform,
                Visibility::Hidden,
            ));
        }
        card.applied_sprite = Some(state);
    }

    // 8. 预算淘汰：按 LRU 回收非活动卡片；活动目标始终保留。
    let entries: Vec<(String, bool, u64, u64)> = cards
        .cards
        .iter()
        .map(|(id, card)| {
            (
                id.clone(),
                cards.active.as_deref() == Some(id.as_str()) || capture_pins.contains(id),
                card.last_touched,
                card.retained_pixels(),
            )
        })
        .collect();
    // 过渡期间旧贴图也占用缓存名额和像素预算。
    let retained_images = cards
        .cards
        .values()
        .filter(|card| card.published.is_some() && !card.published_current)
        .count();
    for id in policy::evictions(
        &entries,
        policy::MAX_IMAGES.saturating_sub(retained_images),
        policy::MAX_PIXELS,
    ) {
        remove_card(&mut commands, &mut cards, &mut layers, &ready, &id);
        cards.work.evictions += 1;
    }

    // 9. 诊断：只报实际工作计数与缓存状态，不当作 GPU 帧率。
    crate::bridge::set_shot_preview_diagnostics([
        cards.active.is_some() as u64,
        candidates.len() as u64,
        cards.retained_pixels() * 4,
        cards.cards.values().filter(|card| card.visible).count() as u64,
        cards.image_count() as u64,
        targets.iter().filter(|target| target.live).count() as u64,
        cards.work.superseded,
        cards.confirmed_count(),
    ]);
}

/// Apply the combined source mask after all consumers have made their frame decisions.
pub(crate) fn sync_source_layers(
    mut commands: Commands,
    mut cards: ResMut<ShotPreviewCards>,
    models: Res<model3d::ModelVisuals>,
    mut media: ResMut<model3d::film_set_media::FilmSetMediaVisuals>,
    overview: Res<crate::canvas_ecs::overview_cache::OverviewSourceLayers>,
) {
    let desired = std::mem::take(&mut cards.desired_layers);
    super::state::apply_owner_layers(&mut commands, &mut cards, &models, &mut media, &desired, &overview);
    cards.desired_layers = desired;
}

#[cfg(test)]
mod source_layer_tests {
    use super::*;
    use crate::canvas_ecs::overview_cache::{OverviewSourceLayer, OverviewSourceLayers};

    #[test]
    fn applies_new_overview_decision_in_the_same_update() {
        let mut app = App::new();
        app.init_resource::<ShotPreviewCards>()
            .init_resource::<model3d::ModelVisuals>()
            .init_resource::<model3d::film_set_media::FilmSetMediaVisuals>()
            .init_resource::<OverviewSourceLayers>()
            .add_systems(Update, (
                |mut cards: ResMut<ShotPreviewCards>, mut overview: ResMut<OverviewSourceLayers>| {
                    cards.desired_layers.insert("film".into(), vec![33]);
                    overview.owners.insert("film".into(), OverviewSourceLayer { layer: Some(32), cached: true });
                },
                sync_source_layers,
            ).chain());
        app.update();
        let cards = app.world().resource::<ShotPreviewCards>();
        assert_eq!(cards.applied_layers["film"].1, vec![32, 33]);
        assert!(cards.applied_overview_cached["film"]);
    }
}
