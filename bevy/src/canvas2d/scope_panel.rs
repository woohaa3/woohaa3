//! Read-only scope panels share Bevy text, geometry and composite media uploads.
use super::{geometry::Geometry, labels::Label};
use crate::{
    app::{CurrentScene, FilmSetTextureBatch, FrameFlags},
    protocol::GraphNode,
    theme::ThemeResource,
};
use bevy::prelude::*;
use std::collections::{HashMap, HashSet};

#[derive(Resource, Default)]
pub(crate) struct PanelImages(HashMap<String, (Entity, Handle<Image>, Vec2)>);

fn image_rect(node: &GraphNode, index: usize) -> (Vec2, Vec2) {
    let asset = node.composite_asset.as_ref().unwrap();
    let count = asset.panel.as_ref().unwrap().image_ids.len();
    let columns = count.clamp(1, 4);
    let rows = count.div_ceil(columns);
    let edge = ((asset.width - 32. - (columns - 1) as f32 * 6.) / columns as f32)
        .min((asset.height - 90. - (rows - 1) as f32 * 6.) / rows as f32)
        .clamp(1., 64.);
    let width = columns as f32 * (edge + 6.) - 6.;
    let height = rows as f32 * (edge + 6.) - 6.;
    (
        Vec2::new(
            asset.x
                + (asset.width - width) / 2.
                + (index % columns) as f32 * (edge + 6.)
                + edge / 2.,
            asset.y
                + 44.
                + (asset.height - 90. - height) / 2.
                + (index / columns) as f32 * (edge + 6.)
                + edge / 2.,
        ),
        Vec2::splat(edge),
    )
}

pub(super) fn draw(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    selected: bool,
    z: f32,
) -> Vec<Label> {
    let asset = node.composite_asset.as_ref().unwrap();
    let panel = asset.panel.as_ref().unwrap();
    geometry.rounded_rect(
        asset.x,
        asset.y,
        asset.width,
        asset.height,
        12.,
        z,
        theme.token_u32("canvasNodeContent"),
    );
    super::dash::dashed_rounded_rect(
        geometry,
        asset.x,
        asset.y,
        asset.width,
        asset.height,
        12.,
        1.,
        z + 0.001,
        theme.token_u32(if selected { "canvasNodeBorderSelected" } else { "canvasNodeBorder" }),
    );
    if selected {
        super::film_set::draw_scope_grip(geometry, theme, &super::scope::grip(&super::scope::node_scope(node)), z);
    }
    let centered = |text: &str, y: f32, size: f32, color: u32| {
        let max = ((asset.width - 24.).max(0.) / size).floor() as usize;
        let text: String = text.chars().take(max).collect();
        let width = super::layout::estimated_text_width(&text, size);
        (
            text,
            Vec2::new(asset.x + (asset.width - width) / 2., y),
            size,
            color,
        )
    };
    let mut labels = vec![
        centered(
            &panel.title,
            asset.y + 16.,
            14.,
            theme.token_u32("canvasEdgeLabelText"),
        ),
        centered(
            &panel.hint,
            asset.y + asset.height - 28.,
            10.,
            theme.token_u32("canvasCloseIcon"),
        ),
    ];
    if !panel.message.is_empty() {
        labels.push(centered(
            &panel.message,
            asset.y + asset.height / 2. - 7.,
            12.,
            theme.token_u32("canvasCloseIcon"),
        ));
    }
    for index in 0..panel.image_ids.len() {
        let (center, size) = image_rect(node, index);
        geometry.rounded_rect(
            center.x - size.x / 2.,
            center.y - size.y / 2.,
            size.x,
            size.y,
            4.,
            z + 0.001,
            theme.token_u32("canvasNodeBorder"),
        );
    }
    labels
}

/// Consume only panel uploads; the remaining batch still belongs to 3D media planes.
pub(crate) fn sync_images(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    flags: Res<FrameFlags>,
    mut visuals: ResMut<PanelImages>,
    mut images: ResMut<Assets<Image>>,
    mut batch: ResMut<FilmSetTextureBatch>,
    mut sprites: Query<(&mut Sprite, &mut Transform)>,
) {
    if !flags.changed && batch.0.is_empty() {
        return;
    }
    let mut alive = HashSet::new();
    for (node_index, node) in scene.0.nodes.iter().enumerate() {
        let Some(panel) = node
            .composite_asset
            .as_ref()
            .and_then(|asset| asset.panel.as_ref())
        else {
            continue;
        };
        for (index, id) in panel.image_ids.iter().enumerate() {
            alive.insert(id.clone());
            if let Some((width, height, rgba)) = batch.0.remove(id) {
                let image = Image::new(
                    bevy::render::render_resource::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    bevy::render::render_resource::TextureDimension::D2,
                    rgba,
                    bevy::render::render_resource::TextureFormat::Rgba8UnormSrgb,
                    bevy::asset::RenderAssetUsages::default(),
                );
                let size = Vec2::new(width as f32, height as f32);
                if let Some((_, handle, old_size)) = visuals.0.get_mut(id) {
                    images.insert(handle.id(), image).unwrap();
                    *old_size = size;
                } else {
                    let handle = images.add(image);
                    let entity = commands
                        .spawn((Sprite::from_image(handle.clone()), Transform::default()))
                        .id();
                    visuals.0.insert(id.clone(), (entity, handle, size));
                }
            }
            if let Some((entity, handle, pixels)) = visuals.0.get(id) {
                let (center, bounds) = image_rect(node, index);
                let size = *pixels * (bounds.x / pixels.x).min(bounds.y / pixels.y);
                let transform =
                    Transform::from_xyz(center.x, -center.y, 10. + node_index as f32 * 0.1 + 0.01);
                if let Ok((mut sprite, mut current)) = sprites.get_mut(*entity) {
                    sprite.custom_size = Some(size);
                    *current = transform;
                } else {
                    commands.entity(*entity).insert((
                        Sprite {
                            image: handle.clone(),
                            custom_size: Some(size),
                            ..default()
                        },
                        transform,
                    ));
                }
            }
        }
    }
    visuals.0.retain(|id, (entity, handle, _)| {
        if alive.contains(id) {
            return true;
        }
        commands.entity(*entity).try_despawn();
        images.remove(handle.id());
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> GraphNode {
        serde_json::from_value(serde_json::json!({"id":"reference","type":"model","x":20,"y":30,
            "compositeAsset":{"x":20,"y":30,"width":280,"height":210,"scopeShape":"rect",
                "panel":{"title":"参考图","message":"","hint":"最多 8 张","imageIds":["reference::a"]}}})).unwrap()
    }

    #[test]
    fn thumbnails_follow_scope_and_release_with_content() {
        let mut app = App::new();
        app.init_resource::<PanelImages>()
            .init_resource::<Assets<Image>>()
            .init_resource::<FilmSetTextureBatch>()
            .init_resource::<FrameFlags>()
            .init_resource::<CurrentScene>()
            .add_systems(Update, sync_images);
        app.world_mut().resource_mut::<CurrentScene>().0.nodes = vec![node()];
        app.world_mut()
            .resource_mut::<FilmSetTextureBatch>()
            .0
            .insert("reference::a".into(), (2, 1, vec![255; 8]));
        app.update();
        let (entity, handle, _) = app.world().resource::<PanelImages>().0["reference::a"].clone();
        let initial = app.world().get::<Transform>(entity).unwrap().translation;
        assert_eq!(
            app.world().get::<Sprite>(entity).unwrap().custom_size,
            Some(Vec2::new(64., 32.))
        );
        app.world_mut().resource_mut::<FrameFlags>().changed = true;
        app.world_mut().resource_mut::<CurrentScene>().0.nodes[0]
            .composite_asset
            .as_mut()
            .unwrap()
            .x += 80.;
        app.update();
        assert_eq!(
            app.world().get::<Transform>(entity).unwrap().translation.x,
            initial.x + 80.
        );
        app.world_mut()
            .resource_mut::<CurrentScene>()
            .0
            .nodes
            .clear();
        app.update();
        assert!(app.world().resource::<PanelImages>().0.is_empty());
        assert!(app.world().get_entity(entity).is_err());
        assert!(
            !app.world()
                .resource::<Assets<Image>>()
                .contains(handle.id())
        );
    }

    #[test]
    fn eight_thumbnails_fit_inside_the_panel() {
        let mut node = node();
        node.composite_asset
            .as_mut()
            .unwrap()
            .panel
            .as_mut()
            .unwrap()
            .image_ids = (0..8).map(|n| n.to_string()).collect();
        for i in 0..8 {
            let (center, size) = image_rect(&node, i);
            assert!(center.x - size.x / 2. >= 36. && center.x + size.x / 2. <= 284.);
            assert!(center.y - size.y / 2. >= 74. && center.y + size.y / 2. <= 194.);
        }
    }
}
