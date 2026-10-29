//! 2D 画布帧系统：投影 → 展示实体 → 按类型几何 → 选中描边 → 标签/覆盖层 → flush
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，design D2 / 任务 2.1–2.4）。
//!
//! `sync_scene` 的大同步过程拆分为独立 system：所有节点输入来自 ECS Query（稳定身份、
//! 布局、深度与展示组件），完整绘制 DTO 仍按 id 从 `CurrentScene`/`NodeIndex` 读取。
//! 16 节点块、共享 mesh 句柄、Geometry、纹理共享与预算仍是 Resource。
use std::collections::HashMap;

use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

use crate::app::{CurrentScene, FrameFlags, ModelAssetTable, NodeIndex, SurfaceState};
use crate::canvas_ecs::components::{
    CanvasDepth, CanvasLabelRole, CanvasLayout, CanvasNodeId, CanvasSelection, CardPresentation,
    CardVisual, ContainerVisual, EdgeVisual, FilmSetPresentation, GroupPresentation,
};
use crate::canvas_ecs::{CanvasBatchWriter, SelectionOutlineBatch};
use crate::protocol::GraphNode;
use crate::theme::ThemeResource;

use super::{CardBlockCache, CardDecorationCache, ContainerBlockCache, EdgeBlockCache, CanvasOverlayCache};
use super::geometry::Geometry;
use super::labels::{LabelRequests, LabelStyle};

/// 静态 2D 场景只在 accepted scene/视口/主题变化时重建。
pub(crate) fn canvas_render_requested(
    flags: Res<FrameFlags>,
    card_visuals: Query<(), Changed<CardVisual>>,
    container_visuals: Query<(), Changed<ContainerVisual>>,
    edge_visuals: Query<(), Changed<EdgeVisual>>,
    theme: Res<ThemeResource>,
    surface: Res<SurfaceState>,
) -> bool {
    flags.scene_received
        || flags.positions_received
        || flags.surface_changed
        || flags.theme_changed
        || !card_visuals.is_empty()
        || !container_visuals.is_empty()
        || !edge_visuals.is_empty()
        || theme.is_changed()
        || surface.is_changed()
}

/// 一个按文档顺序投影的节点：实体 + 完整绘制 DTO。
struct ProjectedNode {
    entity: Entity,
    node: GraphNode,
}

/// 按 `CanvasDepth::index` 排序的投影节点；绘制 DTO 由 `node_for_draw` 取。
///
/// 只在共享 overlay 确认需要重建后调用，避免稳态帧克隆节点内容。
fn projected_nodes(
    scene: &crate::protocol::Scene,
    index: &NodeIndex,
    nodes: &Query<(Entity, &CanvasNodeId, &CanvasDepth)>,
) -> Vec<ProjectedNode> {
    let mut projected: Vec<(usize, Entity, GraphNode)> = nodes
        .iter()
        .filter_map(|(entity, id, depth)| {
            crate::canvas_ecs::node_for_draw(scene, index, &id.0)
                .map(|node| (depth.index, entity, node.into_owned()))
        })
        .collect();
    projected.sort_by_key(|(index, _, _)| *index);
    projected
        .into_iter()
        .map(|(_, entity, node)| ProjectedNode { entity, node })
        .collect()
}

/// 普通卡片几何（静态内容 + 历史条）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn produce_card_geometry(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    mut visuals: ResMut<CardBlockCache>,
    materials: Res<super::CanvasMaterials>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut requests: ResMut<LabelRequests>,
    mut flags: ResMut<FrameFlags>,
    nodes: Query<(
        Entity,
        &CanvasNodeId,
        &CanvasDepth,
        &CardPresentation,
    )>,
) {
    let mut cards: Vec<(usize, Entity, usize, std::borrow::Cow<'_, GraphNode>)> =
        Vec::with_capacity(nodes.iter().len());
    for (entity, id, depth, _) in &nodes {
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        cards.push((depth.index, entity, depth.render, node));
    }
    cards.sort_by_key(|(index, _, _, _)| *index);
    let cards: Vec<_> = cards
        .iter()
        .map(|(index, entity, render, node)| {
            super::card_cache::input(*entity, *index, *render, node.as_ref())
        })
        .collect();
    flags.card_blocks_rebuilt = super::card_cache::sync(
        &mut commands,
        &mut meshes,
        &mut visuals,
        &mut requests,
        &cards,
        scene.0.nodes.len(),
        &scene.0,
        &theme,
        &materials,
    );
}

/// 普通卡片的悬停端点半钮（选中描边由 selection producer 独占）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn produce_card_hover(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    mut visuals: ResMut<CardDecorationCache>,
    materials: Res<super::CanvasMaterials>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut flags: ResMut<FrameFlags>,
    nodes: Query<(
        Entity,
        &CanvasNodeId,
        &CanvasDepth,
        &CardPresentation,
    )>,
) {
    let mut projected = Vec::with_capacity(nodes.iter().len());
    for (_, id, depth, _) in &nodes {
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        projected.push((
            depth.index,
            super::decoration_cache::HoverInput {
                index: depth.index,
                node,
            },
        ));
    }
    projected.sort_by_key(|(index, _)| *index);
    let projected: Vec<_> = projected.into_iter().map(|(_, input)| input).collect();
    flags.card_decorations_rebuilt = super::decoration_cache::sync(
        &mut commands,
        &mut meshes,
        &mut visuals,
        &scene.0,
        &theme,
        &projected,
        &materials,
        scene.0.nodes.len(),
    );
}

/// group 与片场容器几何。
#[allow(clippy::too_many_arguments)]
pub(crate) fn produce_container_geometry(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    mut visuals: ResMut<ContainerBlockCache>,
    materials: Res<super::CanvasMaterials>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut requests: ResMut<LabelRequests>,
    mut flags: ResMut<FrameFlags>,
    nodes: Query<(Entity, &CanvasNodeId, &CanvasDepth)>,
) {
    let mut containers = Vec::new();
    for (entity, id, depth) in &nodes {
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        if node.group.is_none() && node.composite_asset.is_none() {
            continue;
        }
        containers.push((
            depth.index,
            super::container_cache::ContainerInput {
                index: depth.index,
                render: depth.render,
                entity,
                node,
            },
        ));
    }
    containers.sort_by_key(|(index, _)| *index);
    let containers: Vec<_> = containers.into_iter().map(|(_, input)| input).collect();
    flags.container_blocks_rebuilt = super::container_cache::sync(
        &mut commands,
        &mut meshes,
        &mut visuals,
        &mut requests,
        &containers,
        scene.0.nodes.len(),
        &scene.0,
        &theme,
        &materials,
    );
}

/// 边、边标签、删除按钮与草稿线（端点读取 ECS 布局）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn produce_edges(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    mut visuals: ResMut<EdgeBlockCache>,
    materials: Res<super::CanvasMaterials>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut requests: ResMut<LabelRequests>,
    mut flags: ResMut<FrameFlags>,
    nodes: Query<(Entity, &CanvasNodeId, &CanvasLayout)>,
) {
    let layouts: HashMap<&str, CanvasLayout> = nodes
        .iter()
        .map(|(_, id, layout)| (id.0.as_str(), *layout))
        .collect();
    // 连线删除按钮高于所有节点卡片（卡片 z = 10.0 + index*0.1），与命中测试「按钮优先于节点」
    // 保持一致（change: add-edge-hover-delete）。
    let overlay_z = 10.0 + scene.0.nodes.len() as f32 * 0.1 + 1.5;
    flags.edge_blocks_rebuilt = super::edge_cache::sync(
        &mut commands,
        &mut meshes,
        &mut visuals,
        &mut requests,
        &scene.0,
        &theme,
        &layouts,
        overlay_z,
        &materials,
    );
}

/// 帧起点：清空选择描边几何。
pub(crate) fn begin_selection_outlines(mut batch: ResMut<SelectionOutlineBatch>) {
    batch.begin();
}

/// Card 持久选中描边 producer。
pub(crate) fn produce_card_selection(
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    mut batch: ResMut<SelectionOutlineBatch>,
    nodes: Query<(&CanvasNodeId, &CanvasDepth, &CanvasSelection, &CardPresentation)>,
) {
    let writer = batch.writer();
    for (id, depth, selection, _) in &nodes {
        if !selection.selected {
            continue;
        }
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        if node.group.is_some() || node.composite_asset.is_some() {
            continue;
        }
        super::cards::draw_selection_outline(writer, &theme, &node, depth.render);
    }
}

/// Group 持久选中描边 producer。
pub(crate) fn produce_group_selection(
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    mut batch: ResMut<SelectionOutlineBatch>,
    nodes: Query<(&CanvasNodeId, &CanvasDepth, &CanvasSelection, &GroupPresentation)>,
) {
    let writer = batch.writer();
    for (id, depth, selection, _) in &nodes {
        if !selection.selected {
            continue;
        }
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        super::group::draw_group_selection(writer, &theme, &node, depth.z);
    }
}

/// FilmSet 持久选中描边 producer（面板范围框与纯模型范围框共用同一批次）。
pub(crate) fn produce_film_set_selection(
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    mut batch: ResMut<SelectionOutlineBatch>,
    nodes: Query<(&CanvasNodeId, &CanvasDepth, &CanvasSelection, &FilmSetPresentation)>,
) {
    let writer = batch.writer();
    for (id, depth, selection, presentation) in &nodes {
        if !selection.selected {
            continue;
        }
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        if presentation.panel {
            super::scope_panel::draw_selection(writer, &theme, &node, depth.z);
        } else {
            super::film_set::draw_film_set_selection(writer, &theme, &node, depth.z);
        }
    }
}

/// 共享 overlay 几何：归属线、草稿线、拍摄归属、粘连操作条、聚合把手与框选。
///
/// 只读取公共节点组件与瞬时 scene state；`shared_key` 未变化时跳过重建，但卡片/容器
/// 几何与选中描边批次仍按各自 cache 独立提交。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_canvas_overlay(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    model_assets: Res<ModelAssetTable>,
    theme: Res<ThemeResource>,
    mut visuals: ResMut<CanvasOverlayCache>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut requests: ResMut<LabelRequests>,
    mut flags: ResMut<FrameFlags>,
    nodes: Query<(Entity, &CanvasNodeId, &CanvasDepth)>,
) {
    let source = &scene.0;
    let overlay = crate::canvas_query::focus_context::overlay(source);
    let scene = overlay.as_ref();
    let ownership_links = super::ownership_links::segments(source, &model_assets.0);
    let mut shared_key = super::shared_key::SharedKey::new(scene, &theme);
    shared_key.ownership_links = ownership_links.clone();
    shared_key.focus_ownership_links = source.model_focus.is_some();
    if visuals.shared_key.as_ref() == Some(&shared_key) {
        flags.canvas_committed = true;
        return;
    }
    visuals.shared_key = Some(shared_key);

    // 投影节点按文档顺序排列；完整绘制 DTO 由 `node_for_draw` 取。
    let projected = projected_nodes(source, &index, &nodes);
    let node_map: HashMap<&str, &GraphNode> = projected
        .iter()
        .map(|projected| (projected.node.id.as_str(), &projected.node))
        .collect();
    let layouts: HashMap<&str, CanvasLayout> = projected
        .iter()
        .map(|projected| {
            (
                projected.node.id.as_str(),
                CanvasLayout::from_node(&projected.node),
            )
        })
        .collect();
    let entities: HashMap<&str, Entity> = projected
        .iter()
        .map(|projected| (projected.node.id.as_str(), projected.entity))
        .collect();
    let nodes: Vec<&GraphNode> = projected.iter().map(|projected| &projected.node).collect();

    let overlay_z = 10.0 + scene.nodes.len() as f32 * 0.1 + 1.5;
    // 单节点拖动粘连 overlay 标签：owner 为拖动节点实体。
    requests.begin(CanvasLabelRole::Attach);
    let attach_base_z = overlay_z + 1.0;
    let mut geometry = Geometry::default();
    super::ownership_links::draw(
        &mut geometry,
        &ownership_links,
        &theme,
        if source.model_focus.is_some() {
            super::ownership_links::FOCUS_LINK_OPACITY
        } else {
            1.
        },
    );
    super::render_edges::draw_draft(&mut geometry, scene, &theme, &layouts);
    super::render_edges::draw_shot_preview_links(&mut geometry, scene, &theme, &layouts, overlay_z);

    // 单节点拖动粘连 overlay（change: add-drag-touch-connections）：绘制在普通边与节点之后、
    // 框选之前；只被动消费语义投影，不执行碰撞或创建命令。
    if let Some(attach) = &scene.drag_attach {
        if let Some(owner) = node_map.get(attach.node_id.as_str()).copied() {
            let labels = super::attach::draw_drag_attach(
                &mut geometry,
                &theme,
                owner,
                &node_map,
                attach,
                attach_base_z,
            );
            if let Some(entity) = entities.get(attach.node_id.as_str()).copied() {
                requests.push(
                    CanvasLabelRole::Attach,
                    entity,
                    labels
                        .into_iter()
                        .map(|label| (label.text, label.position, label.size, label.color))
                        .collect(),
                    attach_base_z + 0.003,
                    LabelStyle::Attach,
                );
            }
        }
    }

    // 多选聚合把手 overlay（change: add-multi-select-aggregate-connect）：与粘连同为高层
    // overlay，绘制在普通节点/边之后、框选之前，只被动消费语义投影。
    if let Some(aggregate) = &scene.aggregate_connect {
        super::aggregate::draw_aggregate_connect(
            &mut geometry,
            &theme,
            &nodes,
            aggregate,
            &scene.selection.nodes,
            attach_base_z + 0.02,
        );
    }

    // 框选选区矩形（change: fix-group-and-marquee-preview）：最后绘制，覆盖在所有节点与
    // 连线之上。共享 mesh 无深度测试，覆盖顺序即提交顺序。
    if let Some(marquee) = &scene.marquee {
        super::marquee::draw_marquee(&mut geometry, &theme, marquee);
    }

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
    visuals: &mut CanvasOverlayCache,
    blend: bool,
    built: Mesh,
) {
    let material = if blend {
        visuals.blend_material.clone()
    } else {
        visuals.material.clone()
    };
    let (entity_slot, handle_slot) = if blend {
        (&mut visuals.blend_mesh_entity, &mut visuals.blend_mesh)
    } else {
        (&mut visuals.mesh_entity, &mut visuals.mesh)
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
