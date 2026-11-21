//! 纹理批次消费与 Sprite 生命周期
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3；
//!  change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— Sprite 归属改为
//!  `CanvasTextureSprite` owner 组件，节点删除/换源按 owner 查询回收，不再保存
//!  `HashMap<String, Entity>`）。
//!
//! change: 2026-10-23-scale-canvas-media-residency（design D4 / 任务 4.4）：GPU 纹理按
//! **内容身份 + 尺寸**共享，`nodeId` 只是绑定实例。1000 个引用同一资产的卡片不再各建一份
//! `Image`；渲染代际恢复时若同内容已驻留，只重新绑定 Sprite，不必重传像素。
//!
//! 释放逐层进行：节点删除/换源/换档只解绑自己，最后一个引用结束才 `images.remove`。

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::{
        Render, RenderApp, RenderSystems,
        render_asset::RenderAssets,
        render_resource::{
            Extent3d, Origin3d, TexelCopyBufferLayout, TexelCopyTextureInfo, TextureAspect,
            TextureDimension, TextureFormat,
        },
        renderer::RenderQueue,
        texture::GpuImage,
    },
};

use crate::app::TextureBatch;
use crate::canvas_ecs::components::{CanvasNodeId, CanvasTextureSprite};

use super::TextureStore;
use super::texture_store::TextureAction;

#[derive(Clone, Debug)]
pub(crate) struct AtlasPatch {
    pub(crate) page_id: AssetId<Image>,
    pub(crate) origin_x: u32,
    pub(crate) origin_y: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) data: Vec<u8>,
}

/// Shared queue of sub-region atlas slot uploads from Main World (`sync_textures`)
/// to Render World (`flush_atlas_patches`), avoiding 64 MB whole-page `AssetEvent::Modified`
/// re-uploads on every thumbnail arrival.
#[derive(Resource, Clone, Default)]
pub(crate) struct AtlasPatchQueue(pub(crate) std::sync::Arc<std::sync::Mutex<Vec<AtlasPatch>>>);

pub(crate) struct AtlasSubUploadPlugin;

impl Plugin for AtlasSubUploadPlugin {
    fn build(&self, app: &mut App) {
        if app.get_sub_app_mut(RenderApp).is_none() {
            return;
        }
        let queue = AtlasPatchQueue::default();
        app.insert_resource(queue.clone());
        if let Some(render) = app.get_sub_app_mut(RenderApp) {
            render.insert_resource(queue).add_systems(
                Render,
                flush_atlas_patches
                    .after(RenderSystems::PrepareAssets)
                    .before(RenderSystems::Prepare),
            );
        }
    }
}

fn flush_atlas_patches(
    queue: Res<AtlasPatchQueue>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    render_queue: Res<RenderQueue>,
) {
    const MAX_PATCH_BYTES_PER_FRAME: usize = 8 * 1024 * 1024;
    const MAX_PATCHES_PER_FRAME: usize = 16;
    let Ok(mut patches) = queue.0.lock() else {
        return;
    };
    if patches.is_empty() {
        return;
    }
    let mut uploaded_bytes = 0usize;
    let mut uploaded_count = 0usize;
    let mut index = 0;
    while index < patches.len() {
        let patch = &patches[index];
        if uploaded_count >= MAX_PATCHES_PER_FRAME
            || (uploaded_count > 0 && uploaded_bytes + patch.data.len() > MAX_PATCH_BYTES_PER_FRAME)
        {
            break;
        }
        let Some(gpu_image) = gpu_images.get(patch.page_id) else {
            index += 1;
            continue;
        };
        render_queue.write_texture(
            TexelCopyTextureInfo {
                texture: &gpu_image.texture,
                mip_level: 0,
                origin: Origin3d {
                    x: patch.origin_x,
                    y: patch.origin_y,
                    z: 0,
                },
                aspect: TextureAspect::All,
            },
            &patch.data,
            TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(patch.width * 4),
                rows_per_image: Some(patch.height),
            },
            Extent3d {
                width: patch.width,
                height: patch.height,
                depth_or_array_layers: 1,
            },
        );
        uploaded_bytes += patch.data.len();
        uploaded_count += 1;
        patches.remove(index);
    }
}

fn build_atlas_patch(
    page_id: AssetId<Image>,
    placement: super::texture_store::AtlasPlacement,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Option<AtlasPatch> {
    let expected = width as usize * height as usize * 4;
    if rgba.len() < expected || width == 0 || height == 0 {
        return None;
    }
    let slot_size = TextureStore::atlas_slot_size() as usize;
    let padding = TextureStore::atlas_padding() as usize;
    let pad_x = (width as usize + padding * 2 <= slot_size) as usize * padding;
    let pad_y = (height as usize + padding * 2 <= slot_size) as usize * padding;
    let patch_w = width as usize + pad_x * 2;
    let patch_h = height as usize + pad_y * 2;
    let patch_stride = patch_w * 4;
    let row_bytes = width as usize * 4;
    let mut data = vec![0u8; patch_w * patch_h * 4];
    for row in 0..height as usize {
        let source = &rgba[row * row_bytes..(row + 1) * row_bytes];
        let dst_row = (pad_y + row) * patch_stride;
        let dst_inner = dst_row + pad_x * 4;
        data[dst_inner..dst_inner + row_bytes].copy_from_slice(source);
        if pad_x > 0 {
            data[dst_row..dst_inner].copy_from_slice(&source[..4]);
            let right = dst_inner + row_bytes;
            data[right..right + 4].copy_from_slice(&source[row_bytes - 4..row_bytes]);
        }
    }
    if pad_y > 0 {
        let first_inner = pad_y * patch_stride;
        let last_inner = (pad_y + height as usize - 1) * patch_stride;
        data.copy_within(first_inner..first_inner + patch_stride, 0);
        data.copy_within(
            last_inner..last_inner + patch_stride,
            (patch_h - 1) * patch_stride,
        );
    }
    Some(AtlasPatch {
        page_id,
        origin_x: placement.offset.x,
        origin_y: placement.offset.y,
        width: patch_w as u32,
        height: patch_h as u32,
        data,
    })
}

fn write_atlas_pixels(
    image: &mut Image,
    placement: super::texture_store::AtlasPlacement,
    width: u32,
    height: u32,
    rgba: &[u8],
) {
    let Some(data) = image.data.as_mut() else {
        return;
    };
    let expected = width as usize * height as usize * 4;
    if rgba.len() < expected {
        return;
    }
    let page_size = TextureStore::atlas_page_size() as usize;
    let slot_size = TextureStore::atlas_slot_size() as usize;
    let padding = TextureStore::atlas_padding() as usize;
    let pad_x = (width as usize + padding * 2 <= slot_size) as usize * padding;
    let pad_y = (height as usize + padding * 2 <= slot_size) as usize * padding;
    let origin_x = placement.offset.x as usize + pad_x;
    let origin_y = placement.offset.y as usize + pad_y;
    let page_stride = page_size * 4;
    let row_bytes = width as usize * 4;
    for row in 0..height as usize {
        let source = &rgba[row * row_bytes..(row + 1) * row_bytes];
        let destination = (origin_y + row) * page_stride + origin_x * 4;
        data[destination..destination + row_bytes].copy_from_slice(source);
        if pad_x > 0 {
            data[destination - 4..destination].copy_from_slice(&source[..4]);
            let right = destination + row_bytes;
            data[right..right + 4].copy_from_slice(&source[row_bytes - 4..row_bytes]);
        }
    }
    if pad_y > 0 {
        let copy_bytes = (width as usize + pad_x * 2) * 4;
        let first = origin_y * page_stride + (origin_x - pad_x) * 4;
        let last = (origin_y + height as usize - 1) * page_stride + (origin_x - pad_x) * 4;
        let top = first - page_stride;
        let bottom = last + page_stride;
        let first_row = data[first..first + copy_bytes].to_vec();
        let last_row = data[last..last + copy_bytes].to_vec();
        data[top..top + copy_bytes].copy_from_slice(&first_row);
        data[bottom..bottom + copy_bytes].copy_from_slice(&last_row);
    }
}

fn locked_color(node: &crate::protocol::GraphNode, color: Color) -> Color {
    if node
        .edit_scope
        .as_ref()
        .is_some_and(|scope| scope.mode == "locked")
    {
        color.with_alpha(color.alpha() * 0.6)
    } else {
        color
    }
}

/// 消费本帧 keyed 纹理批次并回收不再挂载的 Sprite。
pub(crate) fn sync_textures(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    index: Res<crate::app::NodeIndex>,
    mut texture_store: ResMut<TextureStore>,
    mut images: ResMut<Assets<Image>>,
    mut batch: ResMut<TextureBatch>,
    nodes: Query<(Entity, &CanvasNodeId)>,
    mut sprites: Query<(
        Entity,
        &mut Sprite,
        &mut Transform,
        &mut Visibility,
        &mut CanvasTextureSprite,
    )>,
    mut last_scope: Local<Option<u64>>,
    flags: Option<Res<crate::app::FrameFlags>>,
    changes: Option<Res<crate::app::RuntimeChanges>>,
    cards: Option<Res<super::CardBlockCache>>,
    patch_queue: Option<Res<AtlasPatchQueue>>,
) {
    let scope_changed = match batch.1 {
        Some(scope) if *last_scope != Some(scope) => {
            *last_scope = Some(scope);
            true
        }
        _ => false,
    };
    if batch.0.is_empty() && !scope_changed {
        if let Some(flags) = flags.as_deref() {
            let only_camera = flags.camera_changed
                && !flags.scene_received
                && !flags.positions_received
                && !flags.observer_changed
                && !flags.surface_changed;
            let only_positions = flags.positions_received
                && !flags.scene_received
                && !flags.observer_changed
                && !flags.surface_changed
                && !flags.camera_changed;
            if !flags.scene_received
                && !flags.positions_received
                && !flags.observer_changed
                && !flags.surface_changed
                && !flags.camera_changed
            {
                return;
            }
            if only_camera {
                if !cfg!(feature = "canvas-reference") && scene.0.model_focus.is_none() {
                    if let Some(cards) = cards.as_deref() {
                        for (_, _, _, mut visibility, sprite) in &mut sprites {
                            let next = if cards.owner_visible(sprite.owner) {
                                Visibility::Inherited
                            } else {
                                Visibility::Hidden
                            };
                            if *visibility != next {
                                *visibility = next;
                            }
                        }
                    }
                }
                return;
            }
            if only_positions {
                let changed_ids = changes
                    .as_deref()
                    .map(|changes| changes.changed_node_ids.as_slice())
                    .unwrap_or(flags.changed_node_ids.as_slice());
                let changed: std::collections::HashSet<&str> =
                    changed_ids.iter().map(String::as_str).collect();
                let overlay = crate::canvas_query::focus_context::overlay(&scene.0);
                let shown = scene.0.model_focus.is_none();
                let cards = if !cfg!(feature = "canvas-reference") && shown {
                    cards.as_deref()
                } else {
                    None
                };
                let targets: Vec<(Entity, String, Entity)> = sprites
                    .iter()
                    .filter(|(_, _, _, _, owner)| changed.contains(owner.node_id.as_str()))
                    .map(|(entity, _, _, _, owner)| (entity, owner.node_id.clone(), owner.owner))
                    .collect();
                for (entity, node_id, owner_entity) in targets {
                    let Some((index, node)) = index
                        .node(&scene.0, &node_id)
                        .filter(|(_, node)| node.texture)
                    else {
                        continue;
                    };
                    let display = crate::canvas_query::focus_context::node(&scene.0, node);
                    let node_index =
                        crate::canvas_query::focus_context::index(&scene.0, &node.id, index);
                    let Some((_, texture_px)) = texture_store.binding(&node_id) else {
                        continue;
                    };
                    let (custom_size, center, color, z) = super::image_focus::sprite_layout(
                        &overlay, &display, texture_px, node_index,
                    );
                    let visibility = if !shown {
                        Visibility::Hidden
                    } else if cards.is_some_and(|cards| cards.owner_visible(owner_entity)) {
                        Visibility::Inherited
                    } else if cards.is_some() {
                        Visibility::Hidden
                    } else {
                        Visibility::Inherited
                    };
                    if let Ok((_, mut sprite, mut transform, mut current_visibility, _)) =
                        sprites.get_mut(entity)
                    {
                        sprite.custom_size = Some(custom_size);
                        sprite.rect = texture_store.rect(&node_id);
                        sprite.color = locked_color(node, color);
                        transform.translation = Vec3::new(center.x, -center.y, z);
                        *current_visibility = visibility;
                    }
                }
                return;
            }
        }
    }
    let by_id: std::collections::HashMap<&str, Entity> = nodes
        .iter()
        .map(|(entity, id)| (id.0.as_str(), entity))
        .collect();
    let mut ids: Vec<String> = batch.0.keys().cloned().collect();
    // Ensure entries carrying pixel data (`!rgba.is_empty()`) are processed before
    // 0-byte shared-content rebinds arriving in the same frame batch.
    ids.sort_by_key(|id| {
        batch
            .0
            .get(id)
            .is_none_or(|(_, _, rgba, _)| rgba.is_empty())
    });
    let receipt_scope = batch.1;
    // batch.1=None 表示尚未有新作用域场景，不能提前清理当前画面。
    // 仅当出现新的 scope token 时才退役旧 sprite；Commands 延迟执行，本帧查询仍能看到它们。
    let mut retired = std::collections::HashSet::new();
    if scope_changed {
        for (entity, _, _, _, _) in &sprites {
            commands.entity(entity).try_despawn();
            retired.insert(entity);
        }
        if let Some(queue) = patch_queue.as_deref() {
            if let Ok(mut patches) = queue.0.lock() {
                patches.clear();
            }
        }
        for released in texture_store.clear() {
            images.remove(released.id());
        }
    }
    let sprite_by_owner: std::collections::HashMap<Entity, (Entity, String, Option<String>)> =
        if scope_changed {
            std::collections::HashMap::new()
        } else {
            sprites
                .iter()
                .map(|(entity, _, _, _, sprite)| {
                    (
                        sprite.owner,
                        (entity, sprite.node_id.clone(), sprite.content_id.clone()),
                    )
                })
                .collect()
        };
    for id in ids {
        let Some((width, height, rgba, content)) = batch.0.remove(&id) else {
            continue;
        };
        let scene = &scene.0;
        // 同代节点索引：按 id 定位，替代逐纹理全文档线性 find
        // （change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 7.2）。
        let Some((index, node)) = index
            .node(scene, &id)
            .filter(|(_, node)| node.texture && node.chrome.is_card())
        else {
            continue;
        };
        let Some(owner) = by_id.get(id.as_str()).copied() else {
            continue;
        };
        let texture_px = Vec2::new(width as f32, height as f32);
        let content = content.as_deref();
        // 独占上传（无内容身份，典型是视频实时帧）绝不能写进**别的节点共享**的纹理：
        // 共享内容按「像素不变」前提复用，原地覆盖会同时改掉其他绑定节点的画面
        // （例如两个节点共用同一张封面，其中一个开始播放后另一个也跟着变帧）。
        // 节点当前绑在共享内容上时改为新开一份私有纹理，旧共享引用由 `bind` 结算。
        let replace_shared = texture_store.is_shared(&id);
        // 同内容同尺寸已有共享纹理：只把该节点绑过去，不重复建 GPU 资源。
        // 切 scope 后旧 sprite 仍在本帧查询里，但不能当作可复用绑定；新上传必须当帧新建。
        let existing = sprite_by_owner.get(&owner).cloned();
        let placement = content
            .filter(|_| TextureStore::atlas_eligible(content, texture_px))
            .and_then(|content| texture_store.ensure_atlas_slot(content, texture_px));
        let handle = match (placement, texture_store.resolve(content, texture_px)) {
            (Some(_placement), TextureAction::Reused(shared)) => shared,
            (Some(placement), TextureAction::Fresh) => {
                if rgba.is_empty() {
                    continue;
                }
                let use_gpu_patch = patch_queue.is_some() && !super::video_diagnostics::enabled();
                let page_handle = if let Some(handle) = texture_store.atlas_page_handle(placement) {
                    handle
                } else {
                    let page_size = TextureStore::atlas_page_size();
                    let usages = if use_gpu_patch {
                        RenderAssetUsages::RENDER_WORLD
                    } else {
                        RenderAssetUsages::default()
                    };
                    let size = Extent3d {
                        width: page_size,
                        height: page_size,
                        depth_or_array_layers: 1,
                    };
                    let mut image = if use_gpu_patch {
                        Image::new_uninit(
                            size,
                            TextureDimension::D2,
                            TextureFormat::Rgba8UnormSrgb,
                            usages,
                        )
                    } else {
                        Image::new(
                            size,
                            TextureDimension::D2,
                            vec![0; page_size as usize * page_size as usize * 4],
                            TextureFormat::Rgba8UnormSrgb,
                            usages,
                        )
                    };
                    if super::video_diagnostics::enabled() {
                        image.texture_descriptor.usage |=
                            bevy::render::render_resource::TextureUsages::COPY_SRC;
                    }
                    let handle = images.add(image);
                    texture_store.set_atlas_page_handle(placement, handle.clone());
                    handle
                };
                if use_gpu_patch {
                    if let Some(queue) = patch_queue.as_deref()
                        && let Some(patch) =
                            build_atlas_patch(page_handle.id(), placement, width, height, &rgba)
                        && let Ok(mut patches) = queue.0.lock()
                    {
                        patches.push(patch);
                    }
                } else if let Some(mut image) = images.get_mut(&page_handle) {
                    write_atlas_pixels(&mut image, placement, width, height, &rgba);
                }
                page_handle
            }
            (_, TextureAction::Reused(shared)) => shared,
            (None, TextureAction::Fresh) => {
                if rgba.is_empty() {
                    continue;
                }
                let mut image = Image::new(
                    Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    TextureDimension::D2,
                    rgba,
                    TextureFormat::Rgba8UnormSrgb,
                    RenderAssetUsages::default(),
                );
                if super::video_diagnostics::enabled() {
                    image.texture_descriptor.usage |=
                        bevy::render::render_resource::TextureUsages::COPY_SRC;
                }
                match existing.clone().filter(|_| !replace_shared) {
                    // 同尺寸的既有纹理：原地覆盖，保留 handle 与 Sprite。
                    Some((entity, _, _)) => {
                        let previous = sprites
                            .get(entity)
                            .ok()
                            .map(|(_, sprite, _, _, _)| sprite.image.clone());
                        match previous {
                            Some(previous) if images.contains(previous.id()) => {
                                let _ = images.insert(previous.id(), image);
                                previous
                            }
                            _ => images.add(image),
                        }
                    }
                    // 新节点：新建 handle；旧 handle 交给共享表决定是否释放。
                    None => images.add(image),
                }
            }
        };
        // 共享表里换绑可能释放旧 handle（同内容换 handle / 换源 / 换档）。
        let released = texture_store.bind(&id, content, texture_px, handle.clone());
        // 纹理已进入 Bevy 资产表：前端据此结束「加载中」。缺回执会让图片显示后
        // 仍停在加载环上（`textureApplied` 一直等这条内容+尺寸的确认）。
        match receipt_scope {
            Some(token) => crate::bridge::texture_receipts::applied_scoped(
                token,
                "node",
                &id,
                width,
                height,
                content.unwrap_or(""),
            ),
            None => crate::bridge::texture_receipts::applied(
                "node",
                &id,
                width,
                height,
                content.unwrap_or(""),
            ),
        }
        for stale in released {
            if stale != handle {
                images.remove(stale.id());
                if let Some(queue) = patch_queue.as_deref()
                    && let Ok(mut patches) = queue.0.lock()
                {
                    patches.retain(|patch| patch.page_id != stale.id());
                }
            }
        }
        let display = crate::canvas_query::focus_context::node(scene, node);
        let index = crate::canvas_query::focus_context::index(scene, &node.id, index);
        let overlay = crate::canvas_query::focus_context::overlay(scene);
        let shown = scene.model_focus.is_none();
        let visibility = if shown {
            Visibility::Inherited
        } else {
            Visibility::Hidden
        };
        let (custom_size, center, color, z) =
            super::image_focus::sprite_layout(&overlay, &display, texture_px, index);
        let color = locked_color(node, color);
        match existing {
            Some((entity, _, _)) => {
                commands.entity(entity).insert(visibility);
                if let Ok((_, mut sprite, mut transform, _, mut owner_component)) =
                    sprites.get_mut(entity)
                {
                    sprite.image = handle.clone();
                    sprite.rect = texture_store.rect(&id);
                    sprite.custom_size = Some(custom_size);
                    sprite.color = color;
                    transform.translation = Vec3::new(center.x, -center.y, z);
                    owner_component.content_id = content.map(str::to_owned);
                }
            }
            None => {
                commands.spawn((
                    Sprite {
                        image: handle.clone(),
                        custom_size: Some(custom_size),
                        rect: texture_store.rect(&id),
                        // 运行中上传的纹理先隐藏，避免盖住进度环
                        // （change: add-node-running-progress）。
                        color,
                        ..default()
                    },
                    Transform::from_xyz(center.x, -center.y, z),
                    visibility,
                    CanvasTextureSprite {
                        owner,
                        node_id: id.clone(),
                        content_id: content.map(str::to_owned),
                    },
                    Name::new(format!("canvas-texture:{id}")),
                ));
            }
        }
    }
    // 节点删除/类型替换/不再显示纹理：回收 Sprite 并让共享表释放本节点引用。
    let mut stale = Vec::new();
    for (entity, _, _, _, sprite) in &sprites {
        // 本帧已退役的旧 sprite 不能再 release：同 id 的新绑定会一起被拆掉。
        if retired.contains(&entity) {
            continue;
        }
        let alive = by_id.contains_key(sprite.node_id.as_str())
            && index
                .node(&scene.0, &sprite.node_id)
                .is_some_and(|(_, node)| node.texture && node.chrome.is_card());
        if !alive {
            stale.push((entity, sprite.node_id.clone()));
        }
    }
    for (entity, id) in stale {
        commands.entity(entity).despawn();
        for released in texture_store.release(&id) {
            images.remove(released.id());
            if let Some(queue) = patch_queue.as_deref()
                && let Ok(mut patches) = queue.0.lock()
            {
                patches.retain(|patch| patch.page_id != released.id());
            }
        }
    }
    // 纯位置/尺寸/聚焦增量：已绑定的 Sprite 必须跟随节点布局。
    //
    // 纹理只在内容或尺寸档变化时上传。若摆放只写在「收到纹理批次」的分支里，拖动节点
    // （或移动带动成员位移的组）后缩略图会留在旧位置，直到缩放画布触发换档重新上传才
    // 恢复。这里复用同一 `sprite_layout`，让位置、contain 尺寸、busy 透明与聚焦可见性
    // 都以当前 accepted 场景为准。
    // 当帧若有 Flags 且既无 scene_received / positions_received / observer_changed / surface_changed，
    // 说明只是新纹理到达或资源标记变化，已有其它 Sprite 的位置/尺寸并未改动，无需全表重排。
    let layout_may_have_changed = flags.as_deref().is_none_or(|flags| {
        flags.scene_received
            || flags.positions_received
            || flags.observer_changed
            || flags.surface_changed
    });
    if !layout_may_have_changed {
        return;
    }
    let followed: Vec<(Entity, String)> = sprites
        .iter()
        .filter(|(entity, _, _, _, _)| !retired.contains(entity))
        .map(|(entity, _, _, _, owner)| (entity, owner.node_id.clone()))
        .collect();
    let overlay = crate::canvas_query::focus_context::overlay(&scene.0);
    let shown = scene.0.model_focus.is_none();
    for (entity, id) in followed {
        let Some((index, node)) = index.node(&scene.0, &id).filter(|(_, node)| node.texture) else {
            continue;
        };
        let display = crate::canvas_query::focus_context::node(&scene.0, node);
        let node_index = crate::canvas_query::focus_context::index(&scene.0, &node.id, index);
        let Ok((_, sprite, _, _, _)) = sprites.get(entity) else {
            continue;
        };
        let (texture_px, rect) = texture_store
            .binding(&id)
            .map(|(_, size)| (size, texture_store.rect(&id)))
            .or_else(|| {
                images
                    .get(&sprite.image)
                    .map(|image| (Vec2::new(image.width() as f32, image.height() as f32), None))
            })
            .unwrap_or((Vec2::ZERO, None));
        if texture_px == Vec2::ZERO {
            continue;
        }
        let (custom_size, center, color, z) =
            super::image_focus::sprite_layout(&overlay, &display, texture_px, node_index);
        let color = locked_color(node, color);
        let translation = Vec3::new(center.x, -center.y, z);
        let visibility = if shown {
            Visibility::Inherited
        } else {
            Visibility::Hidden
        };
        if let Ok((_, mut sprite, mut transform, mut current_visibility, _)) =
            sprites.get_mut(entity)
        {
            if transform.translation != translation {
                transform.translation = translation;
            }
            if sprite.custom_size != Some(custom_size) {
                sprite.custom_size = Some(custom_size);
            }
            if sprite.rect != rect {
                sprite.rect = rect;
            }
            if sprite.color != color {
                sprite.color = color;
            }
            if *current_visibility != visibility {
                *current_visibility = visibility;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{CurrentScene, NodeIndex};
    use bevy::ecs::system::RunSystemOnce;

    fn scene() -> crate::protocol::Scene {
        crate::protocol::Scene {
            nodes: serde_json::from_value(serde_json::json!([{
                "id":"img","type":"image","x":10,"y":20,"width":200,"height":100,
                "texture":true
            }]))
            .unwrap(),
            ..default()
        }
    }

    /// 缩略图/图片卡的 Sprite 必须在**纯位置增量**后跟随节点；纹理上传不是刷新位置的前提。
    #[test]
    fn texture_sprite_follows_pure_position_updates() {
        let mut world = World::new();
        let scene = scene();
        world.insert_resource(CurrentScene(scene.clone()));
        world.insert_resource(NodeIndex::default());
        world.resource_mut::<NodeIndex>().rebuild(&scene);
        world.insert_resource(TextureStore::default());
        world.insert_resource(TextureBatch::default());
        let mut images = Assets::<Image>::default();
        let image = Image::new(
            Extent3d {
                width: 100,
                height: 50,
                depth_or_array_layers: 1,
            },
            TextureDimension::D2,
            vec![0; 100 * 50 * 4],
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::default(),
        );
        let handle = images.add(image);
        world.insert_resource(images);
        let owner = world.spawn(CanvasNodeId("img".into())).id();
        let sprite = world
            .spawn((
                Sprite {
                    image: handle,
                    ..default()
                },
                Transform::default(),
                Visibility::Inherited,
                CanvasTextureSprite {
                    owner,
                    node_id: "img".into(),
                    content_id: None,
                },
            ))
            .id();
        world.run_system_once(sync_textures).unwrap();
        world.flush();
        let before = *world.get::<Transform>(sprite).unwrap();
        let size_before = world.get::<Sprite>(sprite).unwrap().custom_size;
        // 前端位置增量只改 accepted 节点的 x/y，不重新上传纹理。
        {
            let mut scene = world.resource_mut::<CurrentScene>();
            let node = &mut scene.0.nodes[0];
            node.x += 150.;
            node.y += 40.;
        }
        world.run_system_once(sync_textures).unwrap();
        world.flush();
        let after = *world.get::<Transform>(sprite).unwrap();
        assert_eq!(after.translation.x - before.translation.x, 150.);
        assert_eq!(after.translation.y - before.translation.y, -40.);
        assert_eq!(
            world.get::<Sprite>(sprite).unwrap().custom_size,
            size_before
        );
    }

    fn two_card_scene() -> crate::protocol::Scene {
        crate::protocol::Scene {
            nodes: serde_json::from_value(serde_json::json!([
                {"id":"a","type":"image","x":0,"y":0,"width":200,"height":100,"texture":true},
                {"id":"b","type":"image","x":300,"y":0,"width":200,"height":100,"texture":true}
            ]))
            .unwrap(),
            ..default()
        }
    }

    fn sprite_image(world: &mut World, node_id: &str) -> Handle<Image> {
        let mut query = world.query::<(&CanvasTextureSprite, &Sprite)>();
        query
            .iter(world)
            .find(|(sprite, _)| sprite.node_id == node_id)
            .map(|(_, sprite)| sprite.image.clone())
            .unwrap_or_else(|| panic!("node {node_id} sprite missing"))
    }

    fn sprite_pixels(world: &mut World, node_id: &str) -> Vec<u8> {
        let (handle, rect) = {
            let mut query = world.query::<(&CanvasTextureSprite, &Sprite)>();
            query
                .iter(world)
                .find(|(owner, _)| owner.node_id == node_id)
                .map(|(_, sprite)| (sprite.image.clone(), sprite.rect))
                .unwrap_or_else(|| panic!("node {node_id} sprite missing"))
        };
        let image = world.resource::<Assets<Image>>().get(&handle).unwrap();
        let data = image.data.as_ref().unwrap();
        let Some(rect) = rect else {
            return data.clone();
        };
        let width = (rect.max.x - rect.min.x) as usize;
        let height = (rect.max.y - rect.min.y) as usize;
        let stride = image.width() as usize * 4;
        let row_bytes = width * 4;
        let mut pixels = Vec::with_capacity(width * height * 4);
        for row in 0..height {
            let start = (rect.min.y as usize + row) * stride + rect.min.x as usize * 4;
            pixels.extend_from_slice(&data[start..start + row_bytes]);
        }
        pixels
    }

    fn sprite_rect(world: &mut World, node_id: &str) -> Option<Rect> {
        let mut query = world.query::<(&CanvasTextureSprite, &Sprite)>();
        query
            .iter(world)
            .find(|(owner, _)| owner.node_id == node_id)
            .and_then(|(_, sprite)| sprite.rect)
    }

    /// 纹理进入资产表后必须回执内容身份与尺寸；前端靠它结束图片的「加载中」。
    #[test]
    fn applied_texture_emits_receipt_for_loading_state() {
        let mut world = World::new();
        let scene = scene();
        world.insert_resource(CurrentScene(scene.clone()));
        world.insert_resource(NodeIndex::default());
        world.resource_mut::<NodeIndex>().rebuild(&scene);
        world.insert_resource(TextureStore::default());
        world.insert_resource(TextureBatch::default());
        world.insert_resource(Assets::<Image>::default());
        world.spawn(CanvasNodeId("img".into()));
        world.resource_mut::<TextureBatch>().0.insert(
            "img".into(),
            (
                2,
                1,
                vec![255u8, 0, 0, 255, 255, 0, 0, 255],
                Some("poster".into()),
            ),
        );
        world.run_system_once(sync_textures).unwrap();
        let receipts = crate::bridge::texture_receipts::take();
        assert!(
            receipts.contains(r#"["node","img",2,1,"poster"]"#),
            "missing texture receipt: {receipts}"
        );
    }

    /// 独占上传（视频实时帧）不得原地覆盖别的节点共享的纹理。
    ///
    /// 共享纹理按「同内容像素不变」复用；实时帧内容身份为空，若仍写入共享 handle，
    /// 另一个绑定同一封面的节点会一起变帧。此时该节点必须换成自己的私有纹理。
    #[test]
    fn exclusive_upload_replaces_shared_binding_with_private_image() {
        let mut world = World::new();
        let scene = two_card_scene();
        world.insert_resource(CurrentScene(scene.clone()));
        world.insert_resource(NodeIndex::default());
        world.resource_mut::<NodeIndex>().rebuild(&scene);
        world.insert_resource(TextureStore::default());
        world.insert_resource(TextureBatch::default());
        world.insert_resource(Assets::<Image>::default());
        world.spawn(CanvasNodeId("a".into()));
        world.spawn(CanvasNodeId("b".into()));
        let poster = vec![255u8, 0, 0, 255, 255, 0, 0, 255];
        {
            let mut batch = world.resource_mut::<TextureBatch>();
            batch
                .0
                .insert("a".into(), (2, 1, poster.clone(), Some("poster".into())));
            batch
                .0
                .insert("b".into(), (2, 1, poster.clone(), Some("poster".into())));
        }
        world.run_system_once(sync_textures).unwrap();
        world.flush();
        let shared = sprite_image(&mut world, "a");
        assert_eq!(sprite_image(&mut world, "b"), shared);

        // a 上传独占实时帧：只替换 a 的纹理，b 仍指向共享封面。
        world.resource_mut::<TextureBatch>().0.insert(
            "a".into(),
            (2, 1, vec![0u8, 255, 0, 255, 0, 255, 0, 255], None),
        );
        world.run_system_once(sync_textures).unwrap();
        world.flush();
        let private = sprite_image(&mut world, "a");
        assert_ne!(private, shared);
        assert_eq!(sprite_image(&mut world, "b"), shared);
        assert_eq!(sprite_pixels(&mut world, "b"), poster);
        assert_eq!(
            sprite_pixels(&mut world, "a"),
            vec![0u8, 255, 0, 255, 0, 255, 0, 255]
        );
    }

    #[test]
    fn changed_content_gets_new_binding_without_overwriting_shared_pixels() {
        let mut world = World::new();
        let scene = two_card_scene();
        world.insert_resource(CurrentScene(scene.clone()));
        world.insert_resource(NodeIndex::default());
        world.resource_mut::<NodeIndex>().rebuild(&scene);
        world.insert_resource(TextureStore::default());
        world.insert_resource(TextureBatch::default());
        world.insert_resource(Assets::<Image>::default());
        world.spawn(CanvasNodeId("a".into()));
        world.spawn(CanvasNodeId("b".into()));
        let poster = vec![255u8, 0, 0, 255, 255, 0, 0, 255];
        {
            let mut batch = world.resource_mut::<TextureBatch>();
            batch
                .0
                .insert("a".into(), (2, 1, poster.clone(), Some("poster".into())));
            batch
                .0
                .insert("b".into(), (2, 1, poster.clone(), Some("poster".into())));
        }
        world.run_system_once(sync_textures).unwrap();
        world.flush();
        let shared = sprite_image(&mut world, "a");
        let shared_rect = sprite_rect(&mut world, "a");
        assert_eq!(sprite_image(&mut world, "b"), shared);

        world.resource_mut::<TextureBatch>().0.insert(
            "a".into(),
            (
                2,
                1,
                vec![0u8, 255, 0, 255, 0, 255, 0, 255],
                Some("focus:2".into()),
            ),
        );
        world.run_system_once(sync_textures).unwrap();
        world.flush();
        let private = sprite_image(&mut world, "a");
        assert_eq!(private, shared);
        assert_ne!(sprite_rect(&mut world, "a"), shared_rect);
        assert_eq!(sprite_image(&mut world, "b"), shared);
        assert_eq!(sprite_pixels(&mut world, "b"), poster);
        assert_eq!(
            sprite_pixels(&mut world, "a"),
            vec![0u8, 255, 0, 255, 0, 255, 0, 255]
        );
    }

    #[test]
    fn scoped_texture_application_emits_scoped_receipt() {
        let _guard = crate::bridge::test_global_state_guard();
        crate::bridge::begin_canvas_renderer();
        let token = crate::begin_canvas_scope("receipt-canvas").unwrap();
        let parsed: u64 = token.parse().unwrap();
        let mut world = World::new();
        let scene = scene();
        world.insert_resource(CurrentScene(scene.clone()));
        world.insert_resource(NodeIndex::default());
        world.resource_mut::<NodeIndex>().rebuild(&scene);
        world.insert_resource(TextureStore::default());
        world.insert_resource(TextureBatch::default());
        world.insert_resource(Assets::<Image>::default());
        world.spawn(CanvasNodeId("img".into()));
        {
            let mut batch = world.resource_mut::<TextureBatch>();
            batch.1 = Some(parsed);
            batch.0.insert(
                "img".into(),
                (
                    2,
                    1,
                    vec![255, 0, 0, 255, 255, 0, 0, 255],
                    Some("poster".into()),
                ),
            );
        }
        world.run_system_once(sync_textures).unwrap();
        let rows = crate::poll_texture_receipts_scoped(&token).unwrap();
        assert!(
            rows.contains(r#"["node","img",2,1,"poster"]"#),
            "missing scoped receipt: {rows}"
        );
        assert_eq!(crate::poll_texture_receipts_scoped(&token).unwrap(), "[]");
        crate::end_canvas_scope(&token).unwrap();
        crate::bridge::begin_canvas_renderer();
    }

    /// Desktop document editors query the access identity read-only before compositing: a stale
    /// visit must answer `false`, the current one `true`, and nothing may be mutated by the query.
    #[test]
    fn canvas_access_query_reports_only_the_current_visit() {
        let _guard = crate::bridge::test_global_state_guard();
        crate::bridge::begin_canvas_renderer();
        let first = crate::begin_canvas_scope("access-a").unwrap();
        assert!(crate::canvas_scope_current(&first).unwrap());
        let second = crate::begin_canvas_scope("access-b").unwrap();
        assert!(crate::canvas_scope_current(&second).unwrap());
        assert!(
            !crate::canvas_scope_current(&first).unwrap(),
            "old visit must not be current"
        );
        // The query itself is read-only: asking again keeps the same answer.
        assert!(!crate::canvas_scope_current(&first).unwrap());
        assert!(crate::canvas_scope_current(&second).unwrap());
        assert!(crate::canvas_scope_current("0").is_err());
        crate::end_canvas_scope(&second).unwrap();
        assert!(
            !crate::canvas_scope_current(&second).unwrap(),
            "ended visit must not be current"
        );
        crate::bridge::begin_canvas_renderer();
    }

    #[test]
    fn scoped_scene_replacement_removes_old_sprite() {
        let mut app = App::new();
        let initial = scene();
        app.insert_resource(CurrentScene(initial.clone()));
        let mut index = NodeIndex::default();
        index.rebuild(&initial);
        app.insert_resource(index);
        app.insert_resource(TextureStore::default());
        app.insert_resource(TextureBatch::default());
        app.insert_resource(Assets::<Image>::default());
        app.world_mut().spawn(CanvasNodeId("img".into()));
        {
            let mut batch = app.world_mut().resource_mut::<TextureBatch>();
            batch.1 = Some(1);
            batch.0.insert(
                "img".into(),
                (1, 1, vec![255, 0, 0, 255], Some("old".into())),
            );
        }
        app.add_systems(Update, sync_textures);
        app.update();
        let old = sprite_image(app.world_mut(), "img");
        assert!(app.world().resource::<Assets<Image>>().get(&old).is_some());
        app.world_mut().resource_mut::<TextureBatch>().1 = Some(2);
        app.update();
        let count = app
            .world_mut()
            .query::<&CanvasTextureSprite>()
            .iter(app.world())
            .count();
        assert_eq!(count, 0, "new scope must not display the old canvas sprite");
        assert!(app.world().resource::<Assets<Image>>().get(&old).is_none());
    }

    #[test]
    fn scoped_scene_replacement_keeps_new_upload() {
        let mut app = App::new();
        let initial = scene();
        app.insert_resource(CurrentScene(initial.clone()));
        let mut index = NodeIndex::default();
        index.rebuild(&initial);
        app.insert_resource(index);
        app.insert_resource(TextureStore::default());
        app.insert_resource(TextureBatch::default());
        app.insert_resource(Assets::<Image>::default());
        app.world_mut().spawn(CanvasNodeId("img".into()));
        {
            let mut batch = app.world_mut().resource_mut::<TextureBatch>();
            batch.1 = Some(11);
            batch.0.insert(
                "img".into(),
                (1, 1, vec![255, 0, 0, 255], Some("old".into())),
            );
        }
        app.add_systems(Update, sync_textures);
        app.update();
        let old = sprite_image(app.world_mut(), "img");
        {
            let mut batch = app.world_mut().resource_mut::<TextureBatch>();
            batch.1 = Some(12);
            batch.0.insert(
                "img".into(),
                (1, 1, vec![0, 0, 255, 255], Some("new".into())),
            );
        }
        app.update();
        let count = app
            .world_mut()
            .query::<&CanvasTextureSprite>()
            .iter(app.world())
            .count();
        assert_eq!(count, 1);
        let new = sprite_image(app.world_mut(), "img");
        assert_ne!(old.id(), new.id());
        assert!(app.world().resource::<Assets<Image>>().get(&old).is_none());
        assert_eq!(sprite_pixels(app.world_mut(), "img"), vec![0, 0, 255, 255]);
        assert!(
            app.world()
                .resource::<TextureStore>()
                .binding("img")
                .is_some_and(|(h, _)| h == new)
        );
    }

    #[test]
    fn atlas_sub_upload_queues_patch_and_zero_byte_rebinds_shared_slot() {
        let _guard = crate::bridge::test_global_state_guard();
        let mut app = App::new();
        let mut s = scene();
        let mut second = s.nodes[0].clone();
        second.id = "img2".into();
        s.nodes.push(second);
        app.insert_resource(CurrentScene(s.clone()));
        let mut index = NodeIndex::default();
        index.rebuild(&s);
        app.insert_resource(index);
        app.insert_resource(TextureStore::default());
        app.insert_resource(TextureBatch::default());
        app.insert_resource(Assets::<Image>::default());
        let queue = AtlasPatchQueue::default();
        app.insert_resource(queue.clone());
        app.world_mut().spawn(CanvasNodeId("img".into()));
        app.world_mut().spawn(CanvasNodeId("img2".into()));
        {
            let mut batch = app.world_mut().resource_mut::<TextureBatch>();
            batch.1 = Some(1);
            batch.0.insert(
                "img".into(),
                (
                    2,
                    2,
                    vec![10, 20, 30, 255].repeat(4),
                    Some("shared-k".into()),
                ),
            );
            // Second node shares the same content_id and sends a 0-byte payload in the same batch
            batch
                .0
                .insert("img2".into(), (2, 2, Vec::new(), Some("shared-k".into())));
        }
        app.add_systems(Update, sync_textures);
        app.update();

        let patches = queue.0.lock().unwrap();
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].width, 4); // 2 + 2px edge padding
        assert_eq!(patches[0].height, 4);
        assert_eq!(patches[0].data.len(), 4 * 4 * 4);
        drop(patches);

        let h1 = sprite_image(app.world_mut(), "img");
        let h2 = sprite_image(app.world_mut(), "img2");
        assert_eq!(h1.id(), h2.id());
    }
}
