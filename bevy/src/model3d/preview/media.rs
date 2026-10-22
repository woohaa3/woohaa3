use bevy::prelude::*;
use bevy::asset::RenderAssetUsages;
use crate::renderer_protocol::NativeMediaFrame;

/// 一个已落地的媒体平面：对象 id + 实体 + 专属材质（供透明度动作直接写 alpha）。
pub(super) struct SpawnedMediaPlane {
    pub item_id: String,
    pub entity: Entity,
    pub material: Handle<StandardMaterial>,
}

/// Uses the browser's exact plane/root transform and material semantics.
///
/// 返回每个平面的对象 id 与材质，让离屏帧也能应用「媒体平面直接写 alpha」的透明度规则
/// （change: 2026-10-19-extend-film-set-for-motion-graphics，D2）。
pub(super) fn spawn_media(commands: &mut Commands, meshes: &mut Assets<Mesh>, materials: &mut Assets<StandardMaterial>, images: &mut Assets<Image>, frames: &[NativeMediaFrame], root: &Transform) -> Vec<SpawnedMediaPlane> {
    let mut planes = Vec::with_capacity(frames.len());
    for frame in frames {
        let texture = images.add(Image::new(
            bevy::render::render_resource::Extent3d { width: frame.width, height: frame.height, depth_or_array_layers: 1 },
            bevy::render::render_resource::TextureDimension::D2, frame.rgba.clone(),
            bevy::render::render_resource::TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD,
        ));
        let material = materials.add(StandardMaterial { base_color: Color::WHITE, base_color_texture: Some(texture), unlit: true, cull_mode: None, ..default() });
        let entity = commands.spawn((Mesh3d(meshes.add(Plane3d::default().mesh().size(1.0, 1.0))), MeshMaterial3d(material.clone()),
            crate::model3d::media_geometry::plane_transform(&frame.plane, root), crate::model3d::model_render_layers())).id();
        planes.push(SpawnedMediaPlane { item_id: frame.plane.item_id.clone(), entity, material });
    }
    planes
}
