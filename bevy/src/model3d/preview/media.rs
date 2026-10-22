use bevy::prelude::*;
use bevy::asset::RenderAssetUsages;
use crate::renderer_protocol::NativeMediaFrame;

/// Uses the browser's exact plane/root transform and material semantics.
pub(super) fn spawn_media(commands: &mut Commands, meshes: &mut Assets<Mesh>, materials: &mut Assets<StandardMaterial>, images: &mut Assets<Image>, frames: &[NativeMediaFrame], root: &Transform) {
    for frame in frames {
        let texture = images.add(Image::new(
            bevy::render::render_resource::Extent3d { width: frame.width, height: frame.height, depth_or_array_layers: 1 },
            bevy::render::render_resource::TextureDimension::D2, frame.rgba.clone(),
            bevy::render::render_resource::TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD,
        ));
        let material = materials.add(StandardMaterial { base_color: Color::WHITE, base_color_texture: Some(texture), unlit: true, cull_mode: None, ..default() });
        commands.spawn((Mesh3d(meshes.add(Plane3d::default().mesh().size(1.0, 1.0))), MeshMaterial3d(material),
            crate::model3d::media_geometry::plane_transform(&frame.plane, root), crate::model3d::model_render_layers()));
    }
}
