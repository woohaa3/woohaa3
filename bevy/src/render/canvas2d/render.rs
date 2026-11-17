//! 2D 画布帧系统：投影 → 展示实体 → 按类型几何 → 选中描边 → 标签/覆盖层 → flush
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，design D2 / 任务 2.1–2.4）。
//!
//! `sync_scene` 的大同步过程拆分为独立 system：所有节点输入来自 ECS Query（稳定身份、
//! 布局、深度与展示组件），完整绘制 DTO 仍按 id 从 `CurrentScene`/`NodeIndex` 读取。
//! 16 节点块、共享 mesh 句柄、Geometry、纹理共享与预算仍是 Resource。
use std::collections::HashMap;

use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

use crate::app::{CurrentScene, FrameFlags, NodeIndex, SurfaceState};
use crate::canvas_ecs::components::{
    CanvasDepth, CanvasLabelRole, CanvasLayout, CanvasNodeId, CanvasSelection, CardPresentation,
    CardVisual, EdgeVisual,
};
use crate::canvas_ecs::{CanvasBatchWriter, SelectionOutlineBatch};
use crate::protocol::GraphNode;
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::labels::{LabelOwner, LabelRequests, LabelSpec, LabelStyle, LabelWriter};
use super::{CanvasOverlayCache, CardBlockCache, CardDecorationCache, EdgeBlockCache};

/// 静态 2D 场景只在 accepted scene/视口/主题变化时重建。
pub(crate) fn canvas_render_requested(
    flags: Res<FrameFlags>,
    card_visuals: Query<(), Changed<CardVisual>>,
    edge_visuals: Query<(), Changed<EdgeVisual>>,
    theme: Res<ThemeResource>,
    surface: Res<SurfaceState>,
) -> bool {
    flags.scene_received
        || flags.positions_received
        || flags.surface_changed
        || flags.theme_changed
        || !card_visuals.is_empty()
        || !edge_visuals.is_empty()
        || theme.is_changed()
        || surface.is_changed()
}

/// Update mesh and Card-label visibility on camera movement without rebuilding
/// geometry. Node roots remain visible for 3D previews and capture consumers.
pub(super) fn workset_viewport(scene: &crate::protocol::Scene) -> crate::protocol::Viewport {
    let [x, y, zoom] = crate::canvas_query::focus_context::viewport(scene);
    let (x, y, zoom) = super::image_focus::camera_view(scene).unwrap_or((x, y, zoom));
    crate::protocol::Viewport { x, y, zoom }
}

pub(crate) fn sync_workset(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    mut flags: ResMut<FrameFlags>,
    mut cards: ResMut<CardBlockCache>,
    mut edges: ResMut<EdgeBlockCache>,
    mut requests: ResMut<LabelRequests>,
    mut labels: Query<(
        &crate::canvas_ecs::components::CanvasLabel,
        &ChildOf,
        &mut Visibility,
    )>,
) {
    if flags.camera_changed
        || flags.scene_received
        || flags.positions_received
        || flags.surface_changed
    {
        let viewport = workset_viewport(&scene.0);
        cards.sync_workset(&mut commands, viewport.clone(), surface.size);
        edges.sync_workset(&mut commands, &viewport, surface.size);
    }
    let mut entities = std::collections::HashSet::new();
    for owner in cards.take_visibility_owners() {
        entities
            .extend(requests.applied_for_owner(CanvasLabelRole::Card, &LabelOwner::Node(owner)));
    }
    entities.extend(requests.take_new_card_labels());
    #[cfg(test)]
    {
        flags.card_visibility_label_visits = entities.len();
    }
    for entity in entities {
        let Ok((label, child, mut visibility)) = labels.get_mut(entity) else {
            continue;
        };
        if label.role != CanvasLabelRole::Card {
            continue;
        }
        let next = if cards.owner_visible(child.parent()) {
            Visibility::Visible
        } else {
            Visibility::Hidden
        };
        if *visibility != next {
            *visibility = next;
        }
    }
}

/// 一个按文档顺序投影的节点：实体 + 完整绘制 DTO。
struct ProjectedNode {
    entity: Entity,
    render: usize,
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
    let mut projected: Vec<(usize, Entity, usize, GraphNode)> = nodes
        .iter()
        .filter_map(|(entity, id, depth)| {
            crate::canvas_ecs::node_for_draw(scene, index, &id.0)
                .map(|node| (depth.index, entity, depth.render, node.into_owned()))
        })
        .collect();
    projected.sort_by_key(|(index, _, _, _)| *index);
    projected
        .into_iter()
        .map(|(_, entity, render, node)| ProjectedNode {
            entity,
            render,
            node,
        })
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
    nodes: Query<(Entity, &CanvasNodeId, &CanvasDepth, &CardPresentation)>,
    changes: Option<Res<crate::app::RuntimeChanges>>,
    projection: Option<Res<crate::canvas_ecs::CanvasProjectionState>>,
) {
    let dirty = if !cfg!(feature = "canvas-reference")
        && flags.positions_received
        && !flags.scene_received
        && !flags.theme_changed
        && !flags.surface_changed
        && !flags.observer_changed
        && flags.resource_nodes.is_empty()
        && !theme.is_changed()
        && visuals.can_update_blocks(scene.0.nodes.len())
    {
        changes
            .as_ref()
            .filter(|changes| changes.has_scene)
            .map(|changes| &changes.current.card_blocks)
    } else {
        None
    };
    let indexed_cards = dirty.and_then(|dirty| {
        let entities = projection.as_ref()?.entity_index.as_ref()?;
        let mut cards = Vec::new();
        for &block in dirty {
            let start = block as usize * super::card_cache::BLOCK_SIZE;
            for (offset, source) in scene
                .0
                .nodes
                .get(start..(start + super::card_cache::BLOCK_SIZE).min(scene.0.nodes.len()))?
                .iter()
                .enumerate()
            {
                let slot = start + offset;
                if index.position(&source.id) != Some(slot) {
                    return None;
                }
                let entity = *entities.get(&source.id)?;
                let (_, id, depth, _) = nodes.get(entity).ok()?;
                if id.0 != source.id || depth.index != slot {
                    return None;
                }
                let node = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0)?;
                cards.push((slot, entity, depth.render, node));
            }
        }
        Some(cards)
    });
    let use_dirty = dirty.is_some() && indexed_cards.is_some();
    let mut cards = indexed_cards.unwrap_or_else(|| {
        nodes
            .iter()
            .filter_map(|(entity, id, depth, _)| {
                crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0)
                    .map(|node| (depth.index, entity, depth.render, node))
            })
            .collect()
    });
    cards.sort_by_key(|(index, _, _, _)| *index);
    #[cfg(test)]
    {
        flags.card_input_visits = cards.len();
    }
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
        if use_dirty { dirty } else { None },
    );
}

/// 普通卡片的悬停端点半钮（选中描边由 selection producer 独占）。
///
/// 纯位置帧只读取被变更集合点名的卡片块，并复用同代 `CanvasDepth::render` rank；完整场景、
/// 主题、surface、资源、观察者变化或缓存未就绪时仍投影全部节点。
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
    nodes: Query<(Entity, &CanvasNodeId, &CanvasDepth, &CardPresentation)>,
    changes: Option<Res<crate::app::RuntimeChanges>>,
    projection: Option<Res<crate::canvas_ecs::CanvasProjectionState>>,
) {
    let incremental = !cfg!(feature = "canvas-reference")
        && flags.positions_received
        && !flags.scene_received
        && !flags.theme_changed
        && !flags.surface_changed
        && !flags.observer_changed
        && flags.resource_nodes.is_empty()
        && !theme.is_changed()
        && visuals.blocks.len() == scene.0.nodes.len().div_ceil(super::card_cache::BLOCK_SIZE);
    let dirty = incremental
        .then(|| {
            changes
                .as_ref()
                .filter(|changes| changes.has_scene)
                .map(|changes| &changes.current.card_blocks)
        })
        .flatten();
    let indexed = dirty.and_then(|dirty| {
        let entities = projection.as_ref()?.entity_index.as_ref()?;
        let mut projected = Vec::new();
        for &block in dirty.iter() {
            let start = block as usize * super::card_cache::BLOCK_SIZE;
            let end = (start + super::card_cache::BLOCK_SIZE).min(scene.0.nodes.len());
            for (offset, source) in scene.0.nodes.get(start..end)?.iter().enumerate() {
                let slot = start + offset;
                if index.position(&source.id) != Some(slot) {
                    return None;
                }
                let entity = *entities.get(&source.id)?;
                let (_, id, depth, _) = nodes.get(entity).ok()?;
                if id.0 != source.id || depth.index != slot {
                    return None;
                }
                let node = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0)?;
                projected.push((slot, depth.render, node));
            }
        }
        Some(projected)
    });
    let use_dirty = dirty.is_some() && indexed.is_some();
    let mut projected = indexed.unwrap_or_else(|| {
        nodes
            .iter()
            .filter_map(|(_, id, depth, _)| {
                let node = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0)?;
                Some((depth.index, depth.render, node))
            })
            .collect()
    });
    projected.sort_by_key(|(index, _, _)| *index);
    let projected: Vec<_> = projected
        .into_iter()
        .map(
            |(index, render, node)| super::decoration_cache::HoverInput {
                index,
                render,
                node: std::borrow::Cow::Owned(node.into_owned()),
            },
        )
        .collect();
    flags.card_decorations_rebuilt = super::decoration_cache::sync(
        &mut commands,
        &mut meshes,
        &mut visuals,
        &scene.0,
        &theme,
        &projected,
        &materials,
        scene.0.nodes.len(),
        if use_dirty { dirty } else { None },
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
    changes: Option<Res<crate::app::RuntimeChanges>>,
    projection: Option<Res<crate::canvas_ecs::CanvasProjectionState>>,
    index: Res<NodeIndex>,
) {
    let dirty = if !cfg!(feature = "canvas-reference")
        && flags.positions_received
        && !flags.scene_received
        && !flags.theme_changed
        && !flags.surface_changed
        && flags.resource_nodes.is_empty()
        && !theme.is_changed()
        && visuals.can_update_blocks(scene.0.edges.len())
    {
        changes
            .as_ref()
            .filter(|changes| changes.has_scene)
            .map(|changes| &changes.current.edge_blocks)
    } else {
        None
    };
    let indexed_layouts = dirty.and_then(|dirty| {
        let entities = projection.as_ref()?.entity_index.as_ref()?;
        let mut result = HashMap::new();
        for &block in dirty {
            let start = block as usize * super::edge_cache::BLOCK_SIZE;
            for edge in scene
                .0
                .edges
                .get(start..(start + super::edge_cache::BLOCK_SIZE).min(scene.0.edges.len()))?
            {
                for id in [&edge.source, &edge.target] {
                    if result.contains_key(id.as_str()) || index.position(id).is_none() {
                        continue;
                    }
                    let entity = *entities.get(id)?;
                    let (_, actual, layout) = nodes.get(entity).ok()?;
                    if actual.0 != *id {
                        return None;
                    }
                    result.insert(id.as_str(), *layout);
                }
            }
        }
        Some(result)
    });
    let use_dirty = dirty.is_some() && indexed_layouts.is_some();
    let layouts = indexed_layouts.unwrap_or_else(|| {
        nodes
            .iter()
            .map(|(_, id, layout)| (id.0.as_str(), *layout))
            .collect()
    });
    #[cfg(test)]
    {
        flags.edge_layout_visits = layouts.len();
    }
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
        if use_dirty { dirty } else { None },
        &index,
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
    nodes: Query<(
        &CanvasNodeId,
        &CanvasDepth,
        &CanvasSelection,
        &CardPresentation,
    )>,
) {
    let writer = batch.writer();
    for (id, depth, selection, _) in &nodes {
        if !selection.selected {
            continue;
        }
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        super::cards::draw_selection_outline(writer, &theme, &node, depth.render);
    }
}

/// 共享 mesh 的两个失效范围。
///
/// 静态部分（容器外壳）只依赖文档与主题；动态部分（草稿线、粘连操作条、聚合把手、框选）还依赖
/// 瞬时 overlay state。两者分别记 value 键、分别替换各自的几何槽位，因此纯悬停/拖动变化不会
/// 重建容器外壳，视口帧也不会让静态部分重扫文档。
#[derive(Default)]
pub(crate) struct OverlayKeys {
    static_key: Option<(u64, String, u64)>,
    /// 按值比较的 overlay 输入（选择、悬停、草稿、粘连、聚合、框选、主题、作用域）。
    dynamic_key: Option<crate::canvas2d::shared_key::SharedKey>,
}

fn hash_scene(doc: &crate::protocol::Scene) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    doc.nodes.len().hash(&mut hasher);
    let ranks = crate::canvas2d::draw_order::render_ranks(&doc.nodes);
    for (index, node) in doc.nodes.iter().enumerate() {
        node.id.hash(&mut hasher);
        // Static chrome depends on the world rect, the derived render slot, the shell kind, the
        // editor mode and the palette-derived label; never on live content fields.
        for value in [node.x, node.y, node.width, node.height] {
            value.to_bits().hash(&mut hasher);
        }
        ranks.get(index).hash(&mut hasher);
        node.card_label.hash(&mut hasher);
        match &node.chrome {
            crate::protocol::NodeChrome::Card => 0_u8.hash(&mut hasher),
            crate::protocol::NodeChrome::Frame { .. } => 1_u8.hash(&mut hasher),
            crate::protocol::NodeChrome::None => 2_u8.hash(&mut hasher),
        }
    }
    doc.theme
        .tokens
        .iter()
        .map(|(name, value)| (name, value))
        .collect::<std::collections::BTreeMap<_, _>>()
        .hash(&mut hasher);
    hasher.finish()
}

fn static_key(
    source: &crate::protocol::Scene,
    theme: &ThemeResource,
    scopes_revision: u64,
) -> (u64, String, u64) {
    (
        hash_scene(source),
        theme.fingerprint().to_owned(),
        scopes_revision,
    )
}

fn dynamic_key(
    source: &crate::protocol::Scene,
    theme: &ThemeResource,
    scopes_revision: u64,
) -> crate::canvas2d::shared_key::SharedKey {
    // Any change of what the dynamic overlay draws (selection, hover, draft, drag attach,
    // aggregate, marquee, theme, scope) must invalidate this layer.
    crate::canvas2d::shared_key::SharedKey::new(source, theme, scopes_revision)
}

/// 静态容器外壳：只在文档内容/主题/作用域变化时重建。
fn draw_frames(
    source: &crate::protocol::Scene,
    scopes: Option<&crate::scope_visual::ScopeVisuals>,
    theme: &ThemeResource,
    projected: &[ProjectedNode],
    mut geometry: Geometry,
) -> Geometry {
    for projected_node in projected {
        let node = &projected_node.node;
        if !matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }) {
            continue;
        }
        let mut style = scopes
            .map(|scopes| scopes.style(source, theme, &node.id))
            .unwrap_or_else(|| crate::scope_visual::ScopeStyle::for_node(source, theme, &node.id));
        style.width /= source.viewport.zoom.max(0.01);
        super::chrome::draw_frame(&mut geometry, theme, node, projected_node.render, style);
    }
    geometry
}

/// 共享 overlay producer：容器外壳（静态半透明层）与瞬时 overlay（动态半透明层）分别记 value
/// 键、分别重建。纯视口帧只有相机变化，两个键都命中时整段返回，不扫文档；纯悬停/拖动变化只重建
/// 动态层，不重扫容器外壳。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_canvas_overlay(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    scopes: Option<Res<crate::scope_visual::ScopeVisuals>>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    mut visuals: ResMut<CanvasOverlayCache>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut requests: ResMut<LabelRequests>,
    mut flags: ResMut<FrameFlags>,
    mut keys: Local<OverlayKeys>,
    nodes: Query<(Entity, &CanvasNodeId, &CanvasDepth)>,
) {
    let source = &scene.0;
    let scopes_revision = scopes.as_deref().map_or(0, |scopes| scopes.revision);
    let next_static = static_key(source, &theme, scopes_revision);
    let overlay = crate::canvas_query::focus_context::overlay(source);
    let scene = overlay.as_ref();
    let next_dynamic = dynamic_key(scene, &theme, scopes_revision);
    let static_dirty = keys.static_key.as_ref() != Some(&next_static);
    let dynamic_dirty = keys.dynamic_key.as_ref() != Some(&next_dynamic);
    if !static_dirty && !dynamic_dirty {
        flags.canvas_committed = true;
        requests.ack_geometry();
        return;
    }
    keys.static_key = Some(next_static);
    keys.dynamic_key = Some(next_dynamic);

    // 投影列表只在真的要重画时构建：两个键都命中时这里不扫节点。
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
    let node_refs: Vec<&GraphNode> = projected.iter().map(|projected| &projected.node).collect();

    // 图层 1：容器外壳。只依赖文档几何/主题/作用域版本；静态层变化时才重建，并留作动态层的底座。
    if static_dirty {
        // 同时记录动态层尚未刷新：底座换了，动态 overlay 必须在新底座上重画。
        visuals.keep_static_blend(draw_frames(
            source,
            scopes.as_deref(),
            &theme,
            &projected,
            Geometry::default(),
        ));
    }

    let overlay_z = 10.0 + scene.nodes.len() as f32 * 0.1 + 1.5;
    let attach_base_z = overlay_z + 1.0;
    let mut attach_keys = Vec::new();
    // 图层 2：动态 overlay。以静态批次为底座追加，静态层下一帧仍从同一份批次复用。
    let mut geometry = visuals.take_static_blend();
    super::render_edges::draw_draft(&mut geometry, scene, &theme, &layouts);
    // 多选选区背景带：低 z 的临时容器感，绘制在成员卡片之下。
    if scene.aggregate_connect.is_some()
        && crate::canvas_query::aggregate::selection_bounds(&scene.nodes, &scene.selection.nodes)
            .is_some()
    {
        super::aggregate::draw_aggregate_selection_band(
            &mut geometry,
            &theme,
            &node_refs,
            &scene.selection.nodes,
            super::aggregate::SELECTION_BAND_Z,
        );
    }

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
                let owner = LabelOwner::Node(attach.node_id.clone());
                requests.bind(owner.clone(), entity);
                for (slot, label) in labels.into_iter().enumerate() {
                    attach_keys.push((
                        owner.clone(),
                        slot as u16,
                        LabelSpec::from_label(
                            (label.text, label.position, label.size, label.color),
                            attach_base_z + 0.003,
                            LabelStyle::Attach,
                        ),
                    ));
                }
            }
        }
    }

    // 多选聚合把手 overlay（change: add-multi-select-aggregate-connect）：与粘连同为高层
    // overlay，绘制在普通节点/边之后、框选之前，只被动消费语义投影。
    if let Some(aggregate) = &scene.aggregate_connect {
        super::aggregate::draw_aggregate_connect(
            &mut geometry,
            &theme,
            &node_refs,
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

    // 与 HEAD 一致：不透明部分进不透明槽位，半透明部分（容器外壳 + 动态 overlay）进 blend 槽位。
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
    flags.canvas_committed = true;
    {
        let mut txn = requests.transaction(LabelWriter::Attach);
        txn.replace_role(CanvasLabelRole::Attach, attach_keys);
        let _ = txn.commit();
    }
    requests.ack_geometry();
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
