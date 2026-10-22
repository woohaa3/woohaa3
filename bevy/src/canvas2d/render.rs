//! 2D scene 同步：普通卡片局部分块，组/片场/边与覆盖层保留共享几何
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3）。

use std::collections::HashMap;

use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

use crate::app::{CurrentScene, FrameFlags};
use crate::protocol::GraphNode;
use crate::theme::ThemeResource;

use super::Visuals;
use super::geometry::Geometry;

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_scene(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    mut visuals: ResMut<Visuals>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut images: ResMut<Assets<Image>>,
    mut flags: ResMut<FrameFlags>,
    mut text_query: Query<(&mut Text2d, &mut Transform, &mut TextColor), Without<Sprite>>,
    mut sprites: Query<(&mut Sprite, &mut Transform), Without<Text2d>>,
) {
    if !flags.changed {
        return;
    }
    let scene = &scene.0;
    visuals.textures.retain(|id, (entity, handle, texture_px)| {
        if let Some((index, node)) = scene
            .nodes
            .iter()
            .enumerate()
            .find(|(_, n)| &n.id == id && n.texture)
        {
            if let Ok((mut sprite, mut transform)) = sprites.get_mut(*entity) {
                let (content, center, color, z) = super::image_focus::sprite_layout(scene, node, *texture_px, index);
                sprite.custom_size = Some(content);
                sprite.color = color;
                transform.translation = Vec3::new(center.x, -center.y, z);
            }
            true
        } else {
            commands.entity(*entity).despawn();
            images.remove(handle.id());
            false
        }
    });

    let mut geometry = Geometry::default();
    let node_map: HashMap<&str, &GraphNode> =
        scene.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    // 边、边标签、悬停删除按钮与草稿线（抽至 `render_edges`，合并后保持 render.rs 在文件体积守卫内）。
    let (overlay_z, edge_blocks) =
        super::render_edges::sync_edges(&mut commands, scene, &theme, &mut visuals, &mut meshes);

    flags.edge_blocks_rebuilt = edge_blocks;

    let focused_id = super::image_focus::presented_media_focus(scene).map(|focus| focus.node_id);
    visuals.labels.retain(|id, entities| {
        if node_map.contains_key(id.as_str()) && focused_id != Some(id.as_str()) {
            true
        } else {
            for entity in entities {
                commands.entity(*entity).despawn();
            }
            false
        }
    });
    flags.card_blocks_rebuilt = super::card_cache::sync(
        &mut commands,
        &mut meshes,
        &mut visuals,
        &mut text_query,
        scene,
        &theme,
    );

    flags.card_decorations_rebuilt =
        super::decoration_cache::sync(&mut commands, &mut meshes, &mut visuals, scene, &theme);

    flags.container_blocks_rebuilt = super::container_cache::sync(
        &mut commands,
        &mut meshes,
        &mut visuals,
        &mut text_query,
        scene,
        &theme,
    );

    let shared_key = super::shared_key::SharedKey::new(scene, &theme);
    if visuals.shared_key.as_ref() == Some(&shared_key) {
        flags.canvas_committed = true;
        return;
    }
    visuals.shared_key = Some(shared_key);
    super::render_edges::draw_draft(&mut geometry, scene, &theme, &node_map);
    // 拍摄镜头归属线（change: 2026-10-15-add-film-set-shooting-shot-previews，design D5）：
    // 派生呈现，不在 `document.edges` 里；起点由映射层按当前观察相机投影给出，终点复用卡片
    // 左侧中点（与命中共用 `canvas_query::shot_preview` 几何）。无端口/删除/重连命中。
    super::render_edges::draw_shot_preview_links(&mut geometry, scene, &theme, &node_map, overlay_z);

    // 单节点拖动粘连 overlay（change: add-drag-touch-connections）：绘制在普通边与节点之后、
    // 框选之前；只被动消费语义投影，不执行碰撞或创建命令。owner 已不在节点集合时清除标签。
    let attach_base_z = overlay_z + 1.0;
    if let Some(attach) = &scene.drag_attach {
        if node_map.contains_key(attach.node_id.as_str()) {
            let labels = super::attach::draw_drag_attach(
                &mut geometry,
                &theme,
                &scene.nodes,
                attach,
                attach_base_z,
            );
            super::attach::sync_attach_labels(
                &mut commands,
                &mut visuals,
                &mut text_query,
                labels,
                attach_base_z + 0.003,
            );
        } else {
            super::attach::sync_attach_labels(
                &mut commands,
                &mut visuals,
                &mut text_query,
                Vec::new(),
                attach_base_z + 0.003,
            );
        }
    } else {
        super::attach::sync_attach_labels(
            &mut commands,
            &mut visuals,
            &mut text_query,
            Vec::new(),
            attach_base_z + 0.003,
        );
    }

    // 多选聚合把手 overlay（change: add-multi-select-aggregate-connect）：与粘连同为高层
    // overlay，绘制在普通节点/边之后、框选之前，只被动消费语义投影。
    if let Some(aggregate) = &scene.aggregate_connect {
        super::aggregate::draw_aggregate_connect(
            &mut geometry,
            &theme,
            &scene.nodes,
            aggregate,
            &scene.selection.nodes,
            attach_base_z + 0.02,
        );
    }

    // 框选选区矩形（change: fix-group-and-marquee-preview）：最后绘制，覆盖在所有节点与
    // 连线之上。共享 mesh 无深度测试，覆盖顺序即提交顺序，因此必须早于 `geometry.build()`、
    // 晚于节点循环，否则节点卡片会盖住选框（change: 修复框选虚线框不可见）。
    if let Some(marquee) = &scene.marquee {
        super::marquee::draw_marquee(&mut geometry, &theme, marquee);
    }

    // 空几何（例如删掉最后一个节点）也必须替换共享 mesh：否则上一帧的节点卡片会留在
    // 屏幕上（文字标签与纹理 Sprite 会各自回收，只剩卡片轮廓），表现为「删除后节点不消失」。
    // `Geometry::build` 对空输入返回不可见的兜底 mesh，因此这里无需提前 return。
    //
    // 不透明几何（卡片外壳、边、把手）与半透明叠加层分两张 mesh 分别更新
    // （change: 2026-10-09-fix-model-preview-layering-and-projection）：前者写深度实现真实
    // z 遮挡，后者保持 Blend 只做深度测试。
    let (opaque_geometry, blend_geometry) = geometry.into_layers();
    replace_geometry(
        &mut commands,
        &mut meshes,
        &mut visuals,
        false,
        opaque_geometry,
    );
    replace_geometry(
        &mut commands,
        &mut meshes,
        &mut visuals,
        true,
        blend_geometry,
    );

    // 通知 app 层记录一次静态 2D mesh 重建（change: 2026-10-10-optimize-canvas-interaction-hot-path）。
    // canvas2d 不得导入 bridge，故只置资源标记，由 app 层消费上报。
    flags.mesh_rebuilt = true;
    flags.canvas_committed = true;
}

/// 替换某个共享几何实体的 mesh；实体缺失时按需创建。
///
/// `blend` 选择半透明叠加层槽位（group 底、框选、聚合选区）。共享 mesh 覆盖全场；其 Aabb
/// 只在实体首次 spawn 时计算一次，之后我们只替换 `Mesh2d` handle，Bevy 不会重算 Aabb。
/// 若把 Aabb 交给 frustum culling，节点移动/新增后 Aabb 会与实际几何脱节：当那次记录的边界
/// 被移出视锥时，Bevy 会把整张 mesh 一起剔除，表现为「部分节点移出画面后，其余仍在画面内的
/// 节点外框全部消失」。因此关闭 frustum culling。
fn replace_geometry(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut Visuals,
    blend: bool,
    built: Mesh,
) {
    let (entity_slot, handle_slot, material) = if blend {
        (
            &mut visuals.blend_mesh_entity,
            &mut visuals.blend_mesh,
            visuals.blend_material.clone(),
        )
    } else {
        (
            &mut visuals.mesh_entity,
            &mut visuals.mesh,
            visuals.material.clone(),
        )
    };
    let new_handle = meshes.add(built);
    match *entity_slot {
        Some(entity) => {
            let old = std::mem::replace(handle_slot, new_handle.clone());
            meshes.remove(&old);
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(Mesh2d(new_handle));
            }
        }
        None => {
            *handle_slot = new_handle.clone();
            let entity = commands
                .spawn((
                    Mesh2d(new_handle),
                    MeshMaterial2d(material),
                    NoFrustumCulling,
                ))
                .id();
            *entity_slot = Some(entity);
        }
    }
}
