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
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
};

use crate::app::TextureBatch;
use crate::canvas_ecs::components::{CanvasNodeId, CanvasTextureSprite};

use super::TextureStore;
use super::texture_store::TextureAction;

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
) {
    let by_id: std::collections::HashMap<&str, Entity> = nodes
        .iter()
        .map(|(entity, id)| (id.0.as_str(), entity))
        .collect();
    let ids: Vec<String> = batch.0.keys().cloned().collect();
    let receipt_scope = batch.1;
    // batch.1=None 表示尚未有新作用域场景，不能提前清理当前画面。
    // 仅当出现新的 scope token 时才退役旧 sprite；Commands 延迟执行，本帧查询仍能看到它们。
    let mut retired = std::collections::HashSet::new();
    let scope_changed = match batch.1 {
        Some(scope) if *last_scope != Some(scope) => {
            *last_scope = Some(scope);
            true
        }
        _ => false,
    };
    if scope_changed {
        for (entity, _, _, _, _) in &sprites {
            commands.entity(entity).try_despawn();
            retired.insert(entity);
        }
        for released in texture_store.clear() {
            images.remove(released.id());
        }
    }
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
        let existing = if scope_changed {
            None
        } else {
            sprites
                .iter()
                .find(|(_, _, _, _, sprite)| sprite.owner == owner)
                .map(|(entity, _, _, _, sprite)| {
                    (entity, sprite.node_id.clone(), sprite.content_id.clone())
                })
        };
        let handle = match texture_store.resolve(content, texture_px) {
            TextureAction::Reused(shared) => shared,
            TextureAction::Fresh => {
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
                                images.insert(previous.id(), image);
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
            Some(token) => crate::bridge::texture_receipts::applied_scoped(token, "node", &id, width, height, content.unwrap_or("")),
            None => crate::bridge::texture_receipts::applied("node", &id, width, height, content.unwrap_or("")),
        }
        for stale in released {
            if stale != handle {
                images.remove(stale.id());
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
        }
    }
    // 纯位置/尺寸/聚焦增量：已绑定的 Sprite 必须跟随节点布局。
    //
    // 纹理只在内容或尺寸档变化时上传。若摆放只写在「收到纹理批次」的分支里，拖动节点
    // （或移动带动成员位移的组）后缩略图会留在旧位置，直到缩放画布触发换档重新上传才
    // 恢复。这里复用同一 `sprite_layout`，让位置、contain 尺寸、busy 透明与聚焦可见性
    // 都以当前 accepted 场景为准。
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
        let Some(image) = images.get(&sprite.image) else {
            continue;
        };
        let texture_px = Vec2::new(image.width() as f32, image.height() as f32);
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
        let images = world.resource::<Assets<Image>>();
        let poster_pixels = images.get(&shared).unwrap().data.clone().unwrap();
        assert_eq!(poster_pixels, poster);
        let frame_pixels = images.get(&private).unwrap().data.clone().unwrap();
        assert_eq!(frame_pixels, vec![0u8, 255, 0, 255, 0, 255, 0, 255]);
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
        assert_ne!(private, shared);
        assert_eq!(sprite_image(&mut world, "b"), shared);
        let images = world.resource::<Assets<Image>>();
        assert_eq!(images.get(&shared).unwrap().data.clone().unwrap(), poster);
        assert_eq!(
            images.get(&private).unwrap().data.clone().unwrap(),
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
            batch.0.insert("img".into(), (2, 1, vec![255, 0, 0, 255, 255, 0, 0, 255], Some("poster".into())));
        }
        world.run_system_once(sync_textures).unwrap();
        let rows = crate::poll_texture_receipts_scoped(&token).unwrap();
        assert!(rows.contains(r#"["node","img",2,1,"poster"]"#), "missing scoped receipt: {rows}");
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
        assert!(!crate::canvas_scope_current(&first).unwrap(), "old visit must not be current");
        // The query itself is read-only: asking again keeps the same answer.
        assert!(!crate::canvas_scope_current(&first).unwrap());
        assert!(crate::canvas_scope_current(&second).unwrap());
        assert!(crate::canvas_scope_current("0").is_err());
        crate::end_canvas_scope(&second).unwrap();
        assert!(!crate::canvas_scope_current(&second).unwrap(), "ended visit must not be current");
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
            batch.0.insert("img".into(), (1, 1, vec![255, 0, 0, 255], Some("old".into())));
        }
        app.add_systems(Update, sync_textures);
        app.update();
        let old = sprite_image(app.world_mut(), "img");
        assert!(app.world().resource::<Assets<Image>>().get(&old).is_some());
        app.world_mut().resource_mut::<TextureBatch>().1 = Some(2);
        app.update();
        let count = app.world_mut().query::<&CanvasTextureSprite>().iter(app.world()).count();
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
            batch.0.insert("img".into(), (1, 1, vec![255, 0, 0, 255], Some("old".into())));
        }
        app.add_systems(Update, sync_textures);
        app.update();
        let old = sprite_image(app.world_mut(), "img");
        {
            let mut batch = app.world_mut().resource_mut::<TextureBatch>();
            batch.1 = Some(12);
            batch.0.insert("img".into(), (1, 1, vec![0, 0, 255, 255], Some("new".into())));
        }
        app.update();
        let count = app.world_mut().query::<&CanvasTextureSprite>().iter(app.world()).count();
        assert_eq!(count, 1);
        let new = sprite_image(app.world_mut(), "img");
        assert_ne!(old.id(), new.id());
        let images = app.world().resource::<Assets<Image>>();
        assert!(images.get(&old).is_none());
        assert_eq!(images.get(&new).unwrap().data.as_deref(), Some(&[0, 0, 255, 255][..]));
        assert!(app.world().resource::<TextureStore>().binding("img").is_some_and(|(h, _)| h == new));
    }
}
