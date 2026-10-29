//! 片场媒体平面渲染（change: 2026-10-08-make-film-set-model-only，design D5）。
//!
//! 图片/视频作为**真实 3D 平面**显示：保留固有宽高比、默认竖直落地、双面可见，跟随片场
//! 整体 transform，并在普通画布、focus、镜头预览与拍摄中采用一致渲染语义。复用主 Bevy
//! 渲染器与纹理通道（`set_model_media_texture` → [`crate::app::FilmSetTextureBatch`]）。
//!
//! 本模块不重建静态模型几何：媒体帧更新只替换 `StandardMaterial.base_color_texture`。
//! 资源按平面 id 缓存，平面删除/替换/场景切换时释放。

use std::collections::HashMap;

use bevy::prelude::*;

use crate::protocol::MediaPlane;
use super::media_geometry::plane_transform;
use crate::protocol::ModelMediaPlane;

/// 片场媒体平面资源表：平面 id → entity + 材质句柄。
#[derive(Resource, Default)]
pub(crate) struct FilmSetMediaVisuals {
    planes: HashMap<String, MediaPlane>,
    /// 归属片场 → 拍摄镜头卡片预览层
    /// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
    ///
    /// 卡片相机只看所属片场的预览层，因此该片场的媒体平面必须同时加入这些层；由
    /// `shot_node_preview` 写入，本模块只负责应用（避免 model3d 反向依赖预览模块）。
    pub(crate) preview_layers: HashMap<String, Vec<usize>>,
}

struct MediaPlane {
    entity: Entity,
    material: Handle<StandardMaterial>,
}

/// 消费本帧片场媒体纹理批次（键为全局唯一 `planeId`）。
pub(crate) fn sync_film_set_textures(
    visuals: ResMut<FilmSetMediaVisuals>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut images: ResMut<Assets<Image>>,
    mut batch: ResMut<crate::app::FilmSetTextureBatch>,
) {
    for (plane_id, (width, height, rgba)) in batch.0.drain() {
        let Some(entry) = visuals.planes.get(&plane_id) else {
            continue;
        };
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
        // Retain texture identity across video frames, avoiding image allocation
        // and material rebinding for each seek or playback tick.
        let existing = materials
            .get(&entry.material)
            .and_then(|material| material.base_color_texture.clone());
        if let Some(handle) = existing.filter(|handle| images.contains(handle.id())) {
            if let Some(mut current) = images.get_mut(&handle) {
                *current = image;
            }
        } else {
            let handle = images.add(image);
            apply_texture(&mut materials, &entry.material, handle);
        }
    }
}

/// 同步片场媒体平面的存在性与世界 transform（内容/位置变化时）。
pub(crate) fn sync_film_set_planes(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    resources: Res<crate::app::ModelAssetTable>,
    mut visuals: ResMut<FilmSetMediaVisuals>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    flags: Res<crate::app::FrameFlags>,
) {
    if !flags.changed {
        return;
    }
    // 收集 (平面, 共同根 transform)：媒体与模型/地面共用同一条根链（D4/D7）；尺寸/偏移已是
    // 内容局部量，由共同根统一应用。
    let mut desired: Vec<(MediaPlane, Transform)> = scene
        .0
        .nodes
        .iter()
        .filter_map(|node| {
            let film_set = node.composite_asset.as_ref()?;
            let model = node
                .model
                .as_ref()
                .and_then(|reference| resources.0.get(&reference.resource_key));
            let root = super::media_geometry::film_set_root(node, model.map(|arc| arc.as_ref()));
            Some(
                film_set
                    .media_planes
                    .iter()
                    .cloned()
                    .map(move |plane| (plane, root)),
            )
        })
        .flatten()
        .collect();
    // Canonical film-set groups carry media bindings directly.  Keep a small
    // renderer-owned plane for each visible image/video binding so texture
    // replacement and lifecycle use the same residency path as legacy media.
    for group in &scene.0.managed_item_groups {
        let Some(owner) = scene.0.nodes.iter().find(|node| node.id == group.owner_node_id) else { continue; };
        let model = owner.model.as_ref().and_then(|reference| resources.0.get(&reference.resource_key)).map(|model| model.as_ref());
        let group_root = super::media_geometry::film_set_root(owner, model);
        let group_root = group.owner_transform.as_ref().map(|t| group_root.mul_transform(super::group_runtime::scene_transform(t))).unwrap_or(group_root);
        for binding in &group.items {
            if !binding.visible || binding.diagnostic.is_some() || !matches!(binding.kind.as_str(), "image" | "video") { continue; }
            let root = group_root.mul_transform(Transform {
                translation: Vec3::new(
                    binding.transform.x,
                    binding.transform.y,
                    binding.transform.z,
                ),
                rotation: Quat::from_rotation_y(binding.transform.yaw),
                scale: Vec3::splat(binding.transform.scale),
            });
            desired.push((super::media_geometry::group_media_plane(&group.owner_node_id, binding, model), root));
        }
    }
    // 释放不再需要的平面。
    let alive: std::collections::HashSet<&str> =
        desired.iter().map(|(plane, _)| plane.id.as_str()).collect();
    let stale: Vec<String> = visuals
        .planes
        .keys()
        .filter(|id| !alive.contains(id.as_str()))
        .cloned()
        .collect();
    for id in stale {
        if let Some(entry) = visuals.planes.remove(&id) {
            commands.entity(entry.entity).try_despawn();
            materials.remove(&entry.material);
        }
    }
    // 更新或创建。
    for (plane, root) in &desired {
        let transform = plane_transform(plane, root);
        if let Some(entry) = visuals.planes.get_mut(&plane.id) {
            if let Ok(mut entity) = commands.get_entity(entry.entity) {
                entity.insert(transform);
            }
        } else {
            let mesh = meshes.add(Plane3d::default().mesh().size(1.0, 1.0));
            let material = materials.add(StandardMaterial {
                base_color: Color::srgb(0.85, 0.85, 0.85),
                cull_mode: None,
                unlit: true,
                ..default()
            });
            let layers = media_plane_layers(&visuals.preview_layers, &plane.id, &plane.item_id);
            let entity = commands
                .spawn((
                    Mesh3d(mesh),
                    MeshMaterial3d(material.clone()),
                    transform,
                    layers,
                    // Unit plane bounds are derived from the mesh; the current
                    // world transform includes root and animated media placement.
                ))
                .id();
            visuals
                .planes
                .insert(plane.id.clone(), MediaPlane { entity, material });
        }
    }
}

/// 媒体平面渲染层：主渲染层并集 + 该平面所属片场的**全部**卡片预览层。
///
/// 平面 id 形如 `nodeId::itemId`；没有卡片预览层时保持与模型根默认层一致
/// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
pub(crate) fn media_plane_layers(
    preview_layers: &HashMap<String, Vec<usize>>,
    plane_id: &str,
    item_id: &str,
) -> bevy::camera::visibility::RenderLayers {
    let owner = plane_id
        .split_once("::")
        .map(|(owner, _)| owner)
        .or_else(|| item_id.split_once("::").map(|(owner, _)| owner))
        .unwrap_or(plane_id);
    let mut layers = crate::model3d::model_render_layers();
    if let Some(extra) = preview_layers.get(owner) {
        for layer in extra {
            layers = layers.with(*layer);
        }
    }
    layers
}

impl FilmSetMediaVisuals {
    /// 记录某片场的卡片预览层并写回其全部媒体平面，返回写入的平面数。
    ///
    /// 卡片预览层变化时调用（模型根层由 `model3d::add_preview_layers` 负责）；媒体平面是
    /// 片场内容的另一半，漏写会让卡片画面里缺图片/视频。**先**更新 owner → 层映射，使本帧
    /// 稍后新建的平面（`sync_film_set_planes` 读取同一映射）也拿到正确层，再写回已存在平面。
    pub(crate) fn refresh_preview_layers(
        &mut self,
        commands: &mut Commands,
        owner_id: &str,
        layers: &[usize],
    ) -> u64 {
        self.preview_layers
            .insert(owner_id.to_owned(), layers.to_vec());
        let mut written = 0;
        for (id, entry) in &self.planes {
            let owner = id.split_once("::").map(|(owner, _)| owner).unwrap_or(id);
            if owner != owner_id {
                continue;
            }
            let layers = media_plane_layers(&self.preview_layers, id, id);
            commands.entity(entry.entity).insert(layers);
            written += 1;
        }
        written
    }
}

/// 释放全部媒体平面（runtime 重建/dispose 时）。
///
/// 当前移除由 `sync_film_set_planes` 的差分回收处理，本函数保留用于需要整体清空的路径。
#[allow(dead_code)]
pub(crate) fn clear_film_set_planes(
    mut commands: Commands,
    mut visuals: ResMut<FilmSetMediaVisuals>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    for (_, entry) in visuals.planes.drain() {
        commands.entity(entry.entity).try_despawn();
        materials.remove(&entry.material);
    }
}

fn apply_texture(
    materials: &mut Assets<StandardMaterial>,
    handle: &Handle<StandardMaterial>,
    texture: Handle<Image>,
) {
    if let Some(mut material) = materials.get_mut(handle) {
        material.base_color = Color::WHITE;
        material.alpha_mode = AlphaMode::Blend;
        material.base_color_texture = Some(texture);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn video_frames_update_one_texture_without_rebinding_material() {
        let mut world = World::new();
        let mut materials = Assets::<StandardMaterial>::default();
        let material = materials.add(StandardMaterial::default());
        let entity = world.spawn_empty().id();
        let mut visuals = FilmSetMediaVisuals::default();
        visuals.planes.insert(
            "video".into(),
            MediaPlane {
                entity,
                material: material.clone(),
            },
        );
        world.insert_resource(visuals);
        world.insert_resource(materials);
        world.insert_resource(Assets::<Image>::default());
        world.insert_resource(crate::app::FilmSetTextureBatch::default());
        let mut schedule = Schedule::default();
        schedule.add_systems(sync_film_set_textures);
        let mut first = None;
        for pixel in [vec![0, 0, 255, 255], vec![255, 0, 0, 255]] {
            world
                .resource_mut::<crate::app::FilmSetTextureBatch>()
                .0
                .insert("video".into(), (1, 1, pixel.clone()));
            schedule.run(&mut world);
            let handle = world
                .resource::<Assets<StandardMaterial>>()
                .get(&material)
                .unwrap()
                .base_color_texture
                .clone()
                .unwrap();
            if let Some(previous) = first.as_ref() {
                assert_eq!(&handle, previous);
            }
            first = Some(handle.clone());
            assert_eq!(
                world
                    .resource::<Assets<Image>>()
                    .get(&handle)
                    .unwrap()
                    .data
                    .as_ref()
                    .unwrap(),
                &pixel
            );
            assert_eq!(world.resource::<Assets<Image>>().len(), 1);
        }
    }
}
