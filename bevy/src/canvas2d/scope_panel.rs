//! Shared Bevy container surface: border/text and optional flat reference thumbnails, never DOM.
use super::{geometry::Geometry, labels::Label};
use crate::{
    protocol::{GraphNode, Scene},
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
    if node.model.is_none() {
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
    super::dash::dashed_rounded_rect(
        geometry,
        x,
        y,
        width,
        height,
        12.,
        if selected { 2. } else { 1. },
        z + 0.001,
        theme.token_u32(if selected {
            "interactionAccent"
        } else {
            "canvasEdgeDefault"
        }),
    );
    if selected && node.resizable {
        super::film_set::draw_scope_grip(
            geometry,
            theme,
            &super::scope::grip(&super::scope::node_scope(node)),
            z,
        );
    }
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

struct Thumbnail {
    entity: Entity,
    image: Handle<Image>,
    size: Vec2,
}
#[derive(Resource, Default)]
pub(crate) struct PanelImages {
    images: HashMap<String, Thumbnail>,
}

/// Reuses the existing composite-media upload channel; consumes only IDs declared by panels.
pub(crate) fn sync_images(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    flags: Res<crate::app::FrameFlags>,
    mut batch: ResMut<crate::app::FilmSetTextureBatch>,
    mut state: ResMut<PanelImages>,
    mut images: ResMut<Assets<Image>>,
    mut sprites: Query<(&mut Sprite, &mut Transform)>,
) {
    if !flags.changed && batch.0.is_empty() {
        return;
    }
    let desired = image_slots(&scene.0);
    state.images.retain(|id, entry| {
        if desired.contains_key(id) {
            true
        } else {
            commands.entity(entry.entity).despawn();
            images.remove(entry.image.id());
            false
        }
    });
    for (id, (rect, z)) in &desired {
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
            if let Some(entry) = state.images.get_mut(id) {
                images.insert(entry.image.id(), image).unwrap();
                entry.size = Vec2::new(width as f32, height as f32);
            } else {
                let handle = images.add(image);
                let entity = commands
                    .spawn((Sprite::from_image(handle.clone()), Transform::default()))
                    .id();
                state.images.insert(
                    id.clone(),
                    Thumbnail {
                        entity,
                        image: handle,
                        size: Vec2::new(width as f32, height as f32),
                    },
                );
            }
        }
        if let Some(entry) = state.images.get(id) {
            let size = fit(entry.size, Vec2::new(rect[2], rect[3]));
            let transform =
                Transform::from_xyz(rect[0] + rect[2] / 2., -(rect[1] + rect[3] / 2.), *z);
            if let Ok((mut sprite, mut current)) = sprites.get_mut(entry.entity) {
                sprite.custom_size = Some(size);
                *current = transform;
            } else {
                commands.entity(entry.entity).insert((
                    Sprite {
                        image: entry.image.clone(),
                        custom_size: Some(size),
                        ..default()
                    },
                    transform,
                ));
            }
        }
    }
}
fn image_slots(scene: &Scene) -> HashMap<String, ([f32; 4], f32)> {
    let mut result = HashMap::new();
    for (index, node) in scene.nodes.iter().enumerate() {
        let Some(panel) = node
            .composite_asset
            .as_ref()
            .and_then(|asset| asset.panel.as_ref())
        else {
            continue;
        };
        let layout = crate::canvas_query::composite_panel::layout(node, panel.image_ids.len());
        for (id, rect) in panel.image_ids.iter().zip(layout.images) {
            result.insert(id.clone(), (rect, 10. + index as f32 * 0.1 + 0.01));
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
            .add_systems(Update, sync_images);
        app.world_mut()
            .resource_mut::<crate::app::FilmSetTextureBatch>()
            .0
            .insert("ref".into(), (2, 1, vec![255; 8]));
        app.update();
        let entry = &app.world().resource::<PanelImages>().images["ref"];
        let entity = entry.entity;
        let handle = entry.image.clone();
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
        assert_eq!(
            app.world().resource::<PanelImages>().images["ref"]
                .image
                .id(),
            handle.id()
        );
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
