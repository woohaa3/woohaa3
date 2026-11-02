//! 纹理批次消费与 Sprite 生命周期
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3；
//!  change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— Sprite 归属改为
//!  `CanvasTextureSprite` owner 组件。按组件变更维护可丢弃索引，
//!  上传和资源增量只更新对应节点，完整场景/位置更新仍校验全部 Sprite。
//!
//! change: 2026-10-23-scale-canvas-media-residency（design D4 / 任务 4.4）：GPU 纹理按
//! **内容身份 + 尺寸**共享，`nodeId` 只是绑定实例。1000 个引用同一资产的卡片不再各建一份
//! `Image`；渲染代际恢复时若同内容已驻留，只重新绑定 Sprite，不必重传像素。
//!
//! 释放逐层进行：节点删除/换源/换档只解绑自己，最后一个引用结束才 `images.remove`。

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
};

use crate::app::TextureBatch;
use crate::canvas_ecs::components::{CanvasNodeId, CanvasTextureSprite};

use super::TextureStore;
use super::texture_store::TextureAction;

/// Derived lookup only; ECS components remain the ownership source of truth.
#[derive(Default)]
pub(crate) struct TextureSpriteIndex {
    by_node: std::collections::HashMap<String, Entity>,
    by_entity: std::collections::HashMap<Entity, String>,
}

impl TextureSpriteIndex {
    fn insert(&mut self, entity: Entity, id: &str) -> Option<String> {
        if self.by_entity.get(&entity).is_some_and(|old| old == id) {
            return None;
        }
        let previous = self.remove(entity);
        self.by_node.insert(id.to_owned(), entity);
        self.by_entity.insert(entity, id.to_owned());
        previous
    }

    fn remove(&mut self, entity: Entity) -> Option<String> {
        let id = self.by_entity.remove(&entity)?;
        if self.by_node.get(&id) != Some(&entity) {
            return None;
        }
        self.by_node.remove(&id);
        Some(id)
    }
}

/// Pan/zoom changes the camera, not world-space sprite layouts. Uploads and
/// accepted content/position/resource changes still synchronize in the same frame.
pub(crate) fn texture_sync_requested(
    flags: Res<crate::app::FrameFlags>,
    batch: Res<TextureBatch>,
) -> bool {
    !batch.0.is_empty()
        || flags.scene_received
        || flags.positions_received
        || flags.surface_changed
        || !flags.resource_nodes.is_empty()
}

/// 消费本帧 keyed 纹理批次并回收不再挂载的 Sprite。
pub(crate) fn sync_textures(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    index: Res<crate::app::NodeIndex>,
    mut texture_store: ResMut<TextureStore>,
    mut images: ResMut<Assets<Image>>,
    mut batch: ResMut<TextureBatch>,
    flags: Option<Res<crate::app::FrameFlags>>,
    projection: Option<Res<crate::canvas_ecs::CanvasProjectionState>>,
    mut lookup: Local<TextureSpriteIndex>,
    changed: Query<(Entity, &CanvasTextureSprite), Changed<CanvasTextureSprite>>,
    mut removed: RemovedComponents<CanvasTextureSprite>,
    nodes: Query<(Entity, &CanvasNodeId)>,
    mut sprites: Query<(
        Entity,
        &mut Sprite,
        &mut Transform,
        &mut Visibility,
        &CanvasTextureSprite,
    )>,
) {
    for entity in removed.read() {
        if let Some(id) = lookup.remove(entity) {
            for released in texture_store.release(&id) {
                images.remove(released.id());
            }
        }
    }
    for (entity, sprite) in &changed {
        if let Some(previous) = lookup.insert(entity, &sprite.node_id) {
            for released in texture_store.release(&previous) {
                images.remove(released.id());
            }
        }
    }
    let owner_for = |id: &str| {
        if let Some(projection) = projection.as_ref() {
            projection
                .entity(id)
                .filter(|entity| nodes.get(*entity).is_ok())
        } else {
            // Standalone CPU tests do not install the ECS projection resource.
            nodes
                .iter()
                .find(|(_, node)| node.0 == id)
                .map(|(entity, _)| entity)
        }
    };
    let full = flags.as_ref().is_none_or(|flags| {
        flags.scene_received || flags.positions_received || flags.surface_changed
    });
    let mut affected: std::collections::HashSet<String> = batch.0.keys().cloned().collect();
    if full {
        affected.extend(lookup.by_node.keys().cloned());
    } else if let Some(flags) = flags.as_ref() {
        affected.extend(
            flags
                .resource_nodes
                .iter()
                .filter_map(|slot| scene.0.nodes.get(*slot).map(|node| node.id.clone())),
        );
    }
    let overlay = crate::canvas_query::focus_context::overlay(&scene.0);
    let ids: Vec<String> = batch.0.keys().cloned().collect();
    for id in ids {
        let Some((width, height, rgba, content)) = batch.0.remove(&id) else {
            continue;
        };
        let scene = &scene.0;
        // 同代节点索引：按 id 定位，替代逐纹理全文档线性 find
        // （change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 7.2）。
        let Some((index, node)) = index.node(scene, &id).filter(|(_, node)| node.texture) else {
            continue;
        };
        let Some(owner) = owner_for(&id) else {
            continue;
        };
        let texture_px = Vec2::new(width as f32, height as f32);
        let content = content.as_deref();
        // Fresh pixels must never overwrite an existing shared content image,
        // including a new source/tier as well as exclusive video frames.
        let shared_binding = texture_store.is_shared(&id);
        // 同内容同尺寸已有共享纹理：只把该节点绑过去，不重复建 GPU 资源。
        if let Some(entity) = lookup.by_node.get(&id).copied() {
            if sprites
                .get(entity)
                .is_ok_and(|(_, _, _, _, marker)| marker.owner != owner)
            {
                commands.entity(entity).despawn();
                lookup.remove(entity);
                for released in texture_store.release(&id) {
                    images.remove(released.id());
                }
            }
        }
        let existing = lookup.by_node.get(&id).copied().filter(|entity| {
            sprites
                .get(*entity)
                .is_ok_and(|(_, _, _, _, marker)| marker.owner == owner)
        });
        let handle = match texture_store.resolve(content, texture_px) {
            TextureAction::Reused(shared) => shared,
            TextureAction::Fresh => {
                let image = Image::new(
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
                match existing.filter(|_| !shared_binding) {
                    // 同尺寸的既有纹理：原地覆盖，保留 handle 与 Sprite。
                    Some(entity) => {
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
        crate::bridge::texture_receipts::applied("node", &id, width, height, content.unwrap_or(""));
        for stale in released {
            if stale != handle {
                images.remove(stale.id());
            }
        }
        let display = crate::canvas_query::focus_context::node(scene, node);
        let index = crate::canvas_query::focus_context::index(scene, &node.id, index);
        let shown = scene.model_focus.is_none();
        let visibility = if shown {
            Visibility::Inherited
        } else {
            Visibility::Hidden
        };
        let (custom_size, center, color, z) =
            super::image_focus::sprite_layout(&overlay, &display, texture_px, index);
        match existing {
            Some(entity) => {
                if let Ok((_, mut sprite, mut transform, mut current_visibility, marker)) =
                    sprites.get_mut(entity)
                {
                    if sprite.image != handle {
                        sprite.image = handle.clone();
                    }
                    if sprite.custom_size != Some(custom_size) {
                        sprite.custom_size = Some(custom_size);
                    }
                    if sprite.color != color {
                        sprite.color = color;
                    }
                    let translation = Vec3::new(center.x, -center.y, z);
                    if transform.translation != translation {
                        transform.translation = translation;
                    }
                    current_visibility.set_if_neq(visibility);
                    if marker.content_id.as_deref() != content {
                        commands.entity(entity).insert(CanvasTextureSprite {
                            owner,
                            node_id: id.clone(),
                            content_id: content.map(str::to_owned),
                            // 更新路径同样要带上像素尺寸：字段是结构体要求，
                            // 且 Sprite 跟随几何重算尺寸时读它。
                            texture_px: [width, height],
                        });
                    }
                }
            }
            None => {
                // `texture_px` 是 sixi 侧新增字段（Sprite 每帧跟随节点几何重算尺寸要用）；
                // `.id()` 与 `lookup.insert` 来自 main（纹理实体索引）。
                let entity = commands
                    .spawn((
                        Sprite {
                            image: handle.clone(),
                            custom_size: Some(custom_size),
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
                            texture_px: [width, height],
                        },
                        Name::new(format!("canvas-texture:{id}")),
                    ))
                    .id();
                let _ = lookup.insert(entity, &id);
            }
        }
        affected.remove(&id); // Layout was already applied with this upload.
    }
    // Resource/upload frames visit only affected nodes. Full/position/surface
    // changes also reconcile deletion and focus layout for all existing sprites.
    let shown = scene.0.model_focus.is_none();
    for id in affected {
        let Some(entity) = lookup.by_node.get(&id).copied() else {
            continue;
        };
        if sprites.get(entity).is_err() {
            continue;
        }
        let alive = owner_for(&id).is_some_and(|owner| {
            sprites
                .get(entity)
                .is_ok_and(|(_, _, _, _, marker)| marker.owner == owner)
        }) && index
            .node(&scene.0, &id)
            .is_some_and(|(_, node)| node.texture);
        if !alive {
            commands.entity(entity).despawn();
            lookup.remove(entity);
            for released in texture_store.release(&id) {
                images.remove(released.id());
            }
            continue;
        }
        let Some((index, node)) = index.node(&scene.0, &id).filter(|(_, node)| node.texture) else {
            continue;
        };
        let display = crate::canvas_query::focus_context::node(&scene.0, node);
        let node_index = crate::canvas_query::focus_context::index(&scene.0, &node.id, index);
        let Ok((_, sprite, _, _, _)) = sprites.get(entity) else {
            continue;
        };
        let Some(image) = images.get(&sprite.image) else {
            continue;
        };
        let texture_px = Vec2::new(image.width() as f32, image.height() as f32);
        let (custom_size, center, color, z) =
            super::image_focus::sprite_layout(&overlay, &display, texture_px, node_index);
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
                    // 上游改为从 Image 句柄读像素尺寸；`texture_px` 仍是本仓跟随布局时需要
                    // 的缓存，测试里给与实际图像一致的尺寸。
                    texture_px: [100, 50],
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

    #[test]
    fn scheduled_texture_sync_skips_viewport_but_handles_upload_move_release_and_delete() {
        use crate::app::FrameFlags;
        let mut world = World::new();
        let scene = two_card_scene();
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        world.insert_resource(CurrentScene(scene));
        world.insert_resource(index);
        world.init_resource::<FrameFlags>();
        world.init_resource::<TextureStore>();
        world.init_resource::<TextureBatch>();
        world.insert_resource(Assets::<Image>::default());
        for id in ["a", "b"] {
            world.spawn(CanvasNodeId(id.into()));
            world
                .resource_mut::<TextureBatch>()
                .0
                .insert(id.into(), (1, 1, vec![255; 4], Some("shared".into())));
        }
        let mut schedule = Schedule::default();
        schedule.add_systems(sync_textures.run_if(texture_sync_requested));
        schedule.run(&mut world);
        let a = world
            .query::<(Entity, &CanvasTextureSprite)>()
            .iter(&world)
            .find(|(_, sprite)| sprite.node_id == "a")
            .unwrap()
            .0;
        let before = world.get::<Transform>(a).unwrap().translation;
        assert_eq!(world.resource::<Assets<Image>>().len(), 1);
        world.clear_trackers();
        world.resource_mut::<FrameFlags>().viewport_only = true;
        world.resource_mut::<CurrentScene>().0.viewport.x += 20.;
        schedule.run(&mut world);
        assert_eq!(
            world
                .query_filtered::<Entity, Or<(Changed<Sprite>, Changed<Transform>)>>()
                .iter(&world)
                .count(),
            0
        );

        world.resource_mut::<FrameFlags>().positions_received = true;
        world.resource_mut::<CurrentScene>().0.nodes[0].x += 30.;
        schedule.run(&mut world);
        assert_eq!(
            world.get::<Transform>(a).unwrap().translation.x,
            before.x + 30.
        );
        world.resource_mut::<FrameFlags>().positions_received = false;
        world.resource_mut::<FrameFlags>().resource_nodes = vec![0];
        world.resource_mut::<CurrentScene>().0.nodes[0].texture = false;
        schedule.run(&mut world);
        assert!(world.get_entity(a).is_err());
        assert_eq!(
            world.resource::<Assets<Image>>().len(),
            1,
            "other binding retains the shared image"
        );

        let next = crate::protocol::Scene::default();
        world.resource_mut::<NodeIndex>().rebuild(&next);
        world.resource_mut::<CurrentScene>().0 = next;
        world.resource_mut::<FrameFlags>().scene_received = true;
        schedule.run(&mut world);
        assert_eq!(
            world.query::<&CanvasTextureSprite>().iter(&world).count(),
            0
        );
        assert_eq!(world.resource::<Assets<Image>>().len(), 0);
    }

    #[test]
    fn sparse_upload_preserves_other_sprites_and_releases_removed_bindings() {
        use crate::app::FrameFlags;
        use crate::canvas_ecs::{CanvasProjectionState, project_canvas_nodes};
        let mut scene = two_card_scene();
        scene.nodes = (0..3000)
            .map(|i| {
                let mut node = scene.nodes[0].clone();
                node.id = format!("image-{i}");
                node.x = i as f32 * 220.;
                node
            })
            .collect();
        let mut world = World::new();
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        world.insert_resource(CurrentScene(scene));
        world.insert_resource(index);
        world.insert_resource(FrameFlags {
            scene_received: true,
            ..default()
        });
        world.init_resource::<CanvasProjectionState>();
        world.init_resource::<TextureStore>();
        world.init_resource::<TextureBatch>();
        world.insert_resource(Assets::<Image>::default());
        world.run_system_once(project_canvas_nodes).unwrap();
        for i in 0..3000 {
            world.resource_mut::<TextureBatch>().0.insert(
                format!("image-{i}"),
                (1, 1, vec![255; 4], Some("shared".into())),
            );
        }
        let mut schedule = Schedule::default();
        schedule.add_systems(sync_textures.run_if(texture_sync_requested));
        schedule.run(&mut world);
        assert_eq!(
            world.query::<&CanvasTextureSprite>().iter(&world).count(),
            3000
        );
        assert_eq!(world.resource::<Assets<Image>>().len(), 1);
        world.resource_mut::<FrameFlags>().scene_received = false;
        world.clear_trackers();
        // Same content receipt must not dirty the ownership marker or other sprites.
        world.resource_mut::<TextureBatch>().0.insert(
            "image-42".into(),
            (1, 1, vec![255; 4], Some("shared".into())),
        );
        schedule.run(&mut world);
        assert_eq!(
            world
                .query_filtered::<Entity, Changed<CanvasTextureSprite>>()
                .iter(&world)
                .count(),
            0
        );
        let touched: Vec<_> = world
            .query_filtered::<&CanvasTextureSprite, Changed<Sprite>>()
            .iter(&world)
            .map(|marker| marker.node_id.clone())
            .collect();
        assert!(touched.is_empty());
        let shared = sprite_image(&mut world, "image-44");
        world.resource_mut::<TextureBatch>().0.insert(
            "image-42".into(),
            (1, 1, vec![0; 4], Some("new-source".into())),
        );
        schedule.run(&mut world);
        assert_ne!(sprite_image(&mut world, "image-42"), shared);
        assert_eq!(sprite_image(&mut world, "image-44"), shared);
        assert_eq!(
            world
                .resource::<Assets<Image>>()
                .get(&shared)
                .unwrap()
                .data
                .as_ref()
                .unwrap(),
            &vec![255; 4]
        );
        assert_eq!(world.resource::<Assets<Image>>().len(), 2);
        let touched: Vec<_> = world
            .query_filtered::<&CanvasTextureSprite, Changed<Sprite>>()
            .iter(&world)
            .map(|marker| marker.node_id.clone())
            .collect();
        assert_eq!(touched, ["image-42"]);

        // A pure resource update removes just this binding; the 2999 others survive.
        world.resource_mut::<FrameFlags>().resource_nodes = vec![42];
        world.resource_mut::<CurrentScene>().0.nodes[42].texture = false;
        schedule.run(&mut world);
        assert_eq!(
            world.query::<&CanvasTextureSprite>().iter(&world).count(),
            2999
        );
        assert_eq!(world.resource::<Assets<Image>>().len(), 1);

        // External despawn is reconciled through RemovedComponents, without a full scene scan.
        let entity = world
            .query::<(Entity, &CanvasTextureSprite)>()
            .iter(&world)
            .find(|(_, marker)| marker.node_id == "image-43")
            .unwrap()
            .0;
        world.despawn(entity);
        schedule.run(&mut world);
        assert!(
            world
                .resource::<TextureStore>()
                .binding("image-43")
                .is_none()
        );
        assert!(
            world
                .resource::<TextureStore>()
                .binding("image-44")
                .is_some()
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
        let images = world.resource::<Assets<Image>>();
        let poster_pixels = images.get(&shared).unwrap().data.clone().unwrap();
        assert_eq!(poster_pixels, poster);
        let frame_pixels = images.get(&private).unwrap().data.clone().unwrap();
        assert_eq!(frame_pixels, vec![0u8, 255, 0, 255, 0, 255, 0, 255]);
    }
}
