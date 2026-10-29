//! Shared Bevy container surface: border/text and optional flat reference thumbnails, never DOM.
use super::{geometry::Geometry, labels::Label};
use crate::{
    app::NodeIndex,
    canvas_ecs::components::{CanvasDepth, CanvasNodeId, CompositePanelThumbnail},
    protocol::GraphNode,
    theme::ThemeResource,
};
use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
};
use std::collections::HashMap;

pub(super) fn draw(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    selected: bool,
    z: f32,
) -> Vec<Label> {
    let Some(panel) = node
        .composite_asset
        .as_ref()
        .and_then(|asset| asset.panel.as_ref())
    else {
        return Vec::new();
    };
    let layout = crate::canvas_query::composite_panel::layout(node, panel.image_ids.len());
    let [x, y, width, height] = layout.bounds;
    // A model uses the transparent center; flat image containers use a normal panel background.
    let frame_only = panel.title.is_empty() && panel.message.is_empty() && panel.hint.is_empty() && panel.image_ids.is_empty();
    if frame_only {
        // The embedded real card owns its surface and title; leave the dashed padding visible.
    } else if node.model.is_none() {
        geometry.rounded_rect(
            x,
            y,
            width,
            height,
            12.,
            z,
            theme.token_u32("canvasNodeContent"),
        );
    } else {
        geometry.rect(
            x + 12.,
            y + 4.,
            (width - 24.).max(1.),
            34.,
            z,
            theme.token_u32("canvasNodeContent"),
        );
        geometry.rect(
            x + 12.,
            y + height - 40.,
            (width - 24.).max(1.),
            34.,
            z,
            theme.token_u32("canvasNodeContent"),
        );
    }
    // 选中描边由 `draw_selection` 独占；这里只生产非选中面板边框。
    if !selected {
        super::dash::dashed_rounded_rect(
            geometry,
            x,
            y,
            width,
            height,
            12.,
            1.,
            z + 0.001,
            theme.token_u32("canvasEdgeDefault"),
        );
    }
    if frame_only { return Vec::new(); }
    let text = |value: &str, size: f32| -> String {
        let max = ((width - 28.) / (size * 0.85)).max(1.) as usize;
        if value.chars().count() <= max {
            value.to_owned()
        } else {
            format!(
                "{}…",
                value
                    .chars()
                    .take(max.saturating_sub(1))
                    .collect::<String>()
            )
        }
    };
    let mut labels = vec![(
        text(&panel.title, 13.),
        layout.title,
        13.,
        theme.token_u32("canvasBodyText"),
    )];
    if !panel.message.is_empty() {
        labels.push((
            text(&panel.message, 12.),
            layout.message,
            12.,
            theme.token_u32("canvasCloseIcon"),
        ));
    }
    if !panel.hint.is_empty() {
        labels.push((
            text(&panel.hint, 11.),
            layout.hint,
            11.,
            theme.token_u32("canvasCloseIcon"),
        ));
    }
    labels
}

/// 复合面板持久选中描边 producer：强调色虚线边框 + 范围抓手。
pub(crate) fn draw_selection(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    z: f32,
) {
    let Some(panel) = node
        .composite_asset
        .as_ref()
        .and_then(|asset| asset.panel.as_ref())
    else {
        return;
    };
    let layout = crate::canvas_query::composite_panel::layout(node, panel.image_ids.len());
    let [x, y, width, height] = layout.bounds;
    super::dash::dashed_rounded_rect(
        geometry,
        x,
        y,
        width,
        height,
        12.,
        2.,
        z + 0.001,
        theme.token_u32("interactionAccent"),
    );
    if node.resizable {
        super::film_set::draw_scope_grip(
            geometry,
            theme,
            &super::scope::grip(&super::scope::node_scope(node)),
            z,
        );
    }
}

/// 已发布的面板缩略图资产：内容 id → GPU 图像 + 归属节点。
///
/// 图像资产留在 Resource（迟到上传、聚焦隔离后重新绑定不需要重传）；实体身份与槽位由
/// [`CompositePanelThumbnail`] 组件表达。
struct PublishedImage {
    image: Handle<Image>,
    size: Vec2,
    owner_node: String,
}

#[derive(Resource, Default)]
pub(crate) struct PanelImages {
    images: HashMap<String, PublishedImage>,
}

/// Reuses the existing composite-media upload channel; consumes only IDs declared by panels.
pub(crate) fn sync_images(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    index: Res<NodeIndex>,
    flags: Res<crate::app::FrameFlags>,
    mut batch: ResMut<crate::app::FilmSetTextureBatch>,
    mut state: ResMut<PanelImages>,
    mut images: ResMut<Assets<Image>>,
    nodes: Query<(Entity, &CanvasNodeId, &CanvasDepth)>,
    mut sprites: Query<(Entity, &mut Sprite, &mut Transform, &CompositePanelThumbnail)>,
) {
    if !(flags.scene_received || flags.positions_received || flags.surface_changed || flags.theme_changed) && !scene.is_changed() && batch.0.is_empty() {
        return;
    }
    let desired = image_slots(&scene.0, &index, &nodes);
    let projected_ids: std::collections::HashSet<String> =
        nodes.iter().map(|(_, id, _)| id.0.clone()).collect();

    // 1) 回收不再被当前投影请求的缩略图实体（图像资产按归属节点保留，供聚焦退出后重绑）。
    let stale: Vec<Entity> = sprites
        .iter()
        .filter(|(_, _, _, thumb)| desired.get(&thumb.image_id).is_none_or(|slot| slot.0 != thumb.owner))
        .map(|(entity, _, _, _)| entity)
        .collect();
    for entity in stale {
        commands.entity(entity).despawn();
    }

    // 2) 上传/复用图像并更新 Sprite。
    for (id, (owner, slot, rect, z, node_id)) in &desired {
        if let Some((width, height, rgba)) = batch.0.remove(id) {
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
            match state.images.get_mut(id) {
                Some(entry) => {
                    images.insert(entry.image.id(), image).unwrap();
                    entry.size = Vec2::new(width as f32, height as f32);
                    entry.owner_node = node_id.clone();
                }
                None => {
                    let handle = images.add(image);
                    state.images.insert(
                        id.clone(),
                        PublishedImage {
                            image: handle,
                            size: Vec2::new(width as f32, height as f32),
                            owner_node: node_id.clone(),
                        },
                    );
                }
            }
        }
        let Some(entry) = state.images.get(id) else {
            continue;
        };
        let size = fit(entry.size, Vec2::new(rect[2], rect[3]));
        let transform =
            Transform::from_xyz(rect[0] + rect[2] / 2., -(rect[1] + rect[3] / 2.), *z);
        let existing = sprites
            .iter()
            .find(|(_, _, _, thumb)| thumb.owner == *owner && thumb.image_id == *id)
            .map(|(entity, _, _, _)| entity);
        match existing {
            Some(entity) => {
                if let Ok((_, mut sprite, mut current, _)) = sprites.get_mut(entity) {
                    sprite.custom_size = Some(size);
                    current.translation = transform.translation;
                }
            }
            None => {
                commands.spawn((
                    Sprite {
                        image: entry.image.clone(),
                        custom_size: Some(size),
                        ..default()
                    },
                    transform,
                    CompositePanelThumbnail {
                        owner: *owner,
                        image_id: id.clone(),
                        slot: *slot,
                    },
                    Name::new(format!("canvas-panel-thumbnail:{id}")),
                ));
            }
        }
    }

    // 3) 释放不再被任何仍在投影中的面板引用的图像（聚焦隐藏的节点保留资产）。
    let referenced: std::collections::HashSet<&str> =
        desired.keys().map(String::as_str).collect();
    let mut released = Vec::new();
    state.images.retain(|id, entry| {
        let alive = index.node(&scene.0, &entry.owner_node).is_some();
        let hidden_by_focus = !projected_ids.contains(&entry.owner_node);
        let keep = alive && (hidden_by_focus || referenced.contains(id.as_str()));
        if !keep {
            released.push(entry.image.id());
        }
        keep
    });
    for id in released {
        images.remove(id);
    }
}

fn image_slots(
    scene: &crate::protocol::Scene,
    index: &NodeIndex,
    nodes: &Query<(Entity, &CanvasNodeId, &CanvasDepth)>,
) -> HashMap<String, (Entity, u16, [f32; 4], f32, String)> {
    let mut result = HashMap::new();
    for (entity, id, depth) in nodes.iter() {
        let Some(node) = crate::canvas_ecs::node_for_draw(scene, index, &id.0) else {
            continue;
        };
        let Some(panel) = node
            .composite_asset
            .as_ref()
            .and_then(|asset| asset.panel.as_ref())
        else {
            continue;
        };
        let layout = crate::canvas_query::composite_panel::layout(&node, panel.image_ids.len());
        for (slot, (image_id, rect)) in panel.image_ids.iter().zip(layout.images).enumerate() {
            result.insert(
                image_id.clone(),
                (
                    entity,
                    slot as u16,
                    rect,
                    depth.z + 0.01,
                    node.id.clone(),
                ),
            );
        }
    }
    result
}
fn fit(source: Vec2, slot: Vec2) -> Vec2 {
    source * (slot.x / source.x.max(1.)).min(slot.y / source.y.max(1.))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Scene;

    fn rebuild_index(mut index: ResMut<NodeIndex>, scene: Res<crate::app::CurrentScene>) {
        index.rebuild(&scene.0);
    }

    fn thumbnail(world: &mut World) -> (Entity, Handle<Image>) {
        world
            .query::<(Entity, &CompositePanelThumbnail)>()
            .iter(world)
            .find(|(_, thumb)| thumb.image_id == "ref")
            .map(|(entity, _)| (entity, world.get::<Sprite>(entity).unwrap().image.clone()))
            .unwrap()
    }

    #[test]
    fn composite_panel_upload_move_replace_and_remove_without_renderer() {
        // Pure ECS/asset lifecycle; no window, renderer, adapter or GPU is started.
        let scene: Scene = serde_json::from_value(serde_json::json!({"version":crate::protocol::CANVAS_RENDER_SCENE_VERSION,
            "nodes":[{"id":"references","type":"model","x":0,"y":0,"compositeAsset":{"x":100,"y":200,"width":280,"height":210,"scopeShape":"rect","panel":{"title":"Reference","imageIds":["ref"]}}}],"edges":[],"theme":{
            "id":"default","version":crate::theme_generated::APP_THEME_SCHEMA_VERSION,"fingerprint":crate::theme_generated::APP_THEME_DEFAULT_FINGERPRINT,
            "tokens":crate::theme_generated::APP_THEME_DEFAULT_TOKENS.iter().copied().collect::<std::collections::HashMap<_,_>>()}})).unwrap();
        let mut app = App::new();
        app.insert_resource(crate::app::CurrentScene(scene))
            .insert_resource(crate::app::FrameFlags {
                changed: true,
                ..default()
            })
            .init_resource::<crate::app::FilmSetTextureBatch>()
            .init_resource::<PanelImages>()
            .init_resource::<Assets<Image>>()
            .init_resource::<NodeIndex>()
            .init_resource::<crate::canvas_ecs::CanvasProjectionState>()
            .add_systems(
                Update,
                (
                    rebuild_index,
                    crate::canvas_ecs::project_canvas_nodes,
                    bevy::ecs::schedule::ApplyDeferred,
                    sync_images,
                )
                    .chain(),
            );
        app.world_mut()
            .resource_mut::<crate::app::FilmSetTextureBatch>()
            .0
            .insert("ref".into(), (2, 1, vec![255; 8]));
        app.update();
        let (entity, handle) = thumbnail(app.world_mut());
        assert_eq!(
            app.world().get::<Sprite>(entity).unwrap().custom_size,
            Some(Vec2::new(244., 122.))
        );
        let start = app.world().get::<Transform>(entity).unwrap().translation;
        app.world_mut()
            .resource_mut::<crate::app::CurrentScene>()
            .0
            .nodes[0]
            .composite_asset
            .as_mut()
            .unwrap()
            .x += 50.;
        app.update();
        assert_eq!(
            app.world().get::<Transform>(entity).unwrap().translation.x,
            start.x + 50.
        );
        app.world_mut()
            .resource_mut::<crate::app::FilmSetTextureBatch>()
            .0
            .insert("ref".into(), (1, 2, vec![255; 8]));
        app.update();
        assert_eq!(
            app.world().get::<Sprite>(entity).unwrap().custom_size,
            Some(Vec2::new(61., 122.))
        );
        assert_eq!(thumbnail(app.world_mut()).1.id(), handle.id());
        app.world_mut()
            .resource_mut::<crate::app::CurrentScene>()
            .0
            .nodes
            .clear();
        app.update();
        assert!(app.world().get_entity(entity).is_err());
        assert!(
            app.world()
                .resource::<Assets<Image>>()
                .get(&handle)
                .is_none()
        );
    }
}
