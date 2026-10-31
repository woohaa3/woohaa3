//! Local group/film-scope buffers; each group panel owns an independent transparent entity z.
//!
//! change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— 输入改为 ECS 节点 Query；
//! group 面板实体由 presentation system 按 owner 组件维护，本模块只生产共享几何与标签请求。
use super::{CanvasMaterials, geometry::Geometry, labels::LabelRequest, labels::LabelRequests, labels::LabelStyle};
use crate::canvas_ecs::components::{CanvasLabelRole, ContainerVisual};
use crate::{
    protocol::{GraphNode, GroupPresentation, Scene},
    theme::ThemeResource,
};
use bevy::{camera::visibility::NoFrustumCulling, mesh::VertexAttributeValues, prelude::*};
const BLOCK_SIZE: usize = 16;
#[derive(PartialEq)]
struct Key {
    geometry_visual: Option<crate::canvas_ecs::components::ContainerGeometryInput>,
    id: String,
    /// 文档下标（16 节点分块）。
    index: usize,
    /// 渲染槽位（ghost 固定最低层）。
    render: usize,
    rect: [f32; 4],
    scope: Option<(f32, f32, f32, f32)>,
    scope_vertices: Option<[Vec2; 4]>,
    panel: Option<crate::protocol::CompositeContainerPanel>,
    has_model: bool,
    group: Option<GroupPresentation>,
    group_model_layout: Option<crate::canvas_query::group_model::GroupModelLayout>,
    group_badge_bottom: Option<[Vec2; 5]>,
    selected: bool,
    resizable: bool,
    hovered: bool,
    /// 聚合节点运行遮罩（change: 2026-10-12-unify-generation-history-strip，design D5）：
    /// 仅聚合节点（复合资产）出现，运行中时绘制半透明遮罩 + 「运行中」。
    aggregate_run: bool,
    film_run: Option<crate::protocol::FilmSetRunFeedback>,
}
impl Key {
    fn new(n: &GraphNode, index: usize, render: usize, scene: &Scene) -> Self {
        Self {
            geometry_visual: ContainerVisual::from_node(n).map(|visual| visual.geometry),
            id: n.id.clone(),
            index,
            render,
            rect: [n.x, n.y, n.width, n.height],
            scope: n
                .composite_asset
                .as_ref()
                .map(|asset| (asset.x, asset.y, asset.width, asset.height)),
            panel: n
                .composite_asset
                .as_ref()
                .and_then(|asset| asset.panel.clone()),
            has_model: n.model.is_some(),
            scope_vertices: n
                .composite_asset
                .as_ref()
                .map(|_| super::scope::node_scope(n).vertices),
            // Group title is label input; keep the geometry key independent of it.
            group: n.group.clone().map(|mut group| { group.title.clear(); group }),
            group_model_layout: crate::canvas_query::group_model::for_node(n),
            group_badge_bottom: crate::canvas_query::group_model::badge_bottom_polygon(n),
            selected: scene.selection.nodes.contains(&n.id),
            resizable: n.resizable,
            hovered: n.composite_asset.is_some()
                && scene.hover.as_ref().and_then(|h| h.node_id.as_deref()) == Some(n.id.as_str()),
            aggregate_run: n
                .aggregate_run
                .as_ref()
                .is_some_and(|run| run.active && run.film_set.is_none()),
            film_run: n
                .aggregate_run
                .as_ref()
                .and_then(|run| run.film_set.clone()),
        }
    }
}

/// 一个容器投影输入（group 或 composite-asset）。
pub(super) struct ContainerInput<'a> {
    pub(crate) index: usize,
    pub(crate) render: usize,
    pub(crate) entity: Entity,
    pub(crate) node: std::borrow::Cow<'a, GraphNode>,
}

#[derive(Default)]
pub(super) struct Block {
    keys: Vec<Key>,
    /// 标签输入独立于几何 key；标题变化只更新请求，不替换 mesh。
    label_keys: Vec<(String, String)>,
    theme: String,
    band: Option<[f32; 4]>,
    sort_z: f32,
    entities: [Option<Entity>; 2],
    meshes: [Option<Handle<Mesh>>; 2],
    /// 上一帧提交的标签请求；块命中时原样重提。
    labels: Vec<LabelRequest>,
}

#[derive(Resource, Default)]
pub(crate) struct ContainerBlockCache {
    pub(super) blocks: Vec<Block>,
}
impl Block {
    fn clear(&mut self, commands: &mut Commands, meshes: &mut Assets<Mesh>) {
        for entity in &mut self.entities {
            if let Some(entity) = entity.take() {
                commands.entity(entity).despawn();
            }
        }
        for handle in &mut self.meshes {
            if let Some(handle) = handle.take() {
                meshes.remove(handle.id());
            }
        }
        self.keys.clear();
        self.label_keys.clear();
        self.theme.clear();
        self.band = None;
        self.labels.clear();
    }
    #[cfg(test)]
    pub(super) fn blend_entity(&self) -> Option<Entity> {
        self.entities[1]
    }
    #[cfg(test)]
    pub(super) fn state(&self) -> [Option<bevy::asset::AssetId<Mesh>>; 2] {
        self.meshes
            .each_ref()
            .map(|handle| handle.as_ref().map(Handle::id))
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut ContainerBlockCache,
    requests: &mut LabelRequests,
    containers: &[ContainerInput<'_>],
    document_len: usize,
    scene: &Scene,
    theme: &ThemeResource,
    materials: &CanvasMaterials,
) -> u64 {
    requests.begin(CanvasLabelRole::Container);
    let band = scene.aggregate_connect.as_ref().and_then(|_| {
        crate::canvas_query::aggregate::selection_bounds(&scene.nodes, &scene.selection.nodes)
    });
    let mut blocks = std::mem::take(&mut visuals.blocks);
    let count = document_len.div_ceil(BLOCK_SIZE);
    for block in blocks.iter_mut().skip(count) {
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    let mut rebuilt = 0;
    for block_index in 0..count {
        let block = &mut blocks[block_index];
        let range = block_index * BLOCK_SIZE..((block_index + 1) * BLOCK_SIZE).min(document_len);
        let keys: Vec<_> = containers
            .iter()
            .filter(|input| range.contains(&input.index))
            .filter(|input| input.node.group.is_some() || input.node.composite_asset.is_some())
            .map(|input| Key::new(input.node.as_ref(), input.index, input.render, scene))
            .collect();
        let label_keys: Vec<_> = keys.iter().map(|key| {
            let node = containers.iter().find(|input| input.index == key.index).map(|input| input.node.as_ref());
            let title = node.map(|n| {
                let group_title = n.group.as_ref().map(|group| group.title.as_str()).unwrap_or_default();
                format!("{}\u{1f}" , if group_title.is_empty() { n.title.as_str() } else { group_title })
            }).unwrap_or_default();
            let kind = node.map(|n| n.kind.clone()).unwrap_or_default();
            (title, kind)
        }).collect();
        let band = if block_index == 0 { band } else { None };
        // Bevy Transparent2d sorts by the entity transform, independently of mesh vertex z.
        // Negative sort depths place all group fills below the transient overlay owner (z=0).
        let sort_z = -0.001 * (count - block_index) as f32 / (count + 1) as f32;
        if block.keys == keys
            && block.band == band
            && block.theme == theme.fingerprint()
            && block.sort_z == sort_z
        {
            if block.label_keys != label_keys {
                // 标签变化不触碰几何实体；重新取标签请求并沿用现有 mesh。
                let mut scratch = Geometry::default();
                let mut requests_only = Vec::new();
                for key in &keys {
                    let Some(input) = containers.iter().find(|input| input.index == key.index) else { continue };
                    let node = input.node.as_ref();
                    let z = super::draw_order::render_z(&scene.nodes, key.render);
                    let labels = if let Some(group) = &node.group {
                        vec![super::group::draw_group(&mut scratch, theme, node, group, key.selected, z)]
                    } else if key.panel.is_none() {
                        super::film_set::draw_film_set_scope(&mut scratch, theme, node, key.selected, key.hovered, z).unwrap_or_default()
                    } else { Vec::new() };
                    requests_only.push(LabelRequest { owner: input.entity, labels, z: z + 0.02, style: LabelStyle::Node });
                }
                block.labels = requests_only.clone();
                block.label_keys = label_keys;
                for request in requests_only { requests.push_request(CanvasLabelRole::Container, request); }
            }
            requests.extend(CanvasLabelRole::Container, &block.labels);
            continue;
        }
        if keys.is_empty() && band.is_none() {
            block.clear(commands, meshes);
            block.theme = theme.fingerprint().to_owned();
            block.sort_z = sort_z;
            continue;
        }
        let mut geometry = Geometry::default();
        if band.is_some() {
            let all_nodes: Vec<&GraphNode> = scene.nodes.iter().collect();
            super::aggregate::draw_aggregate_selection_band(
                &mut geometry,
                theme,
                &all_nodes,
                &scene.selection.nodes,
                super::group::GROUP_Z,
            );
        }
        let mut block_requests = Vec::with_capacity(keys.len());
        for key in &keys {
            let Some(input) = containers
                .iter()
                .find(|input| input.index == key.index)
            else {
                continue;
            };
            let node = input.node.as_ref();
            let z = super::draw_order::render_z(&scene.nodes, key.render);
            let mut labels = if let Some(group) = &node.group {
                vec![super::group::draw_group(
                    &mut geometry,
                    theme,
                    node,
                    group,
                    key.selected,
                    z,
                )]
            } else if key.panel.is_some() {
                // 有模型内容的子容器同样走范围面板：它复用 3D 世界呈现链路，模型由 3D
                // 相机（order 0）画在画布之下，2D 相机（order 1）只能透出未绘制区域。
                // 普通卡片会铺不透明的 `canvasNodeSurface`，把模型整块盖住。
                super::scope_panel::draw(&mut geometry, theme, node, key.selected, z)
            } else {
                super::film_set::draw_film_set_scope(
                    &mut geometry,
                    theme,
                    node,
                    key.selected,
                    key.hovered,
                    z,
                )
                .unwrap_or_default()
            };
            if !node.group.as_ref().is_some_and(|group| group.collapsed)
                && let Some(label) = super::group::draw_run_status(&mut geometry, theme, node, z)
            {
                labels.push(label);
            }
            // 聚合节点运行遮罩：覆盖整个范围（change: 2026-10-12-unify-generation-history-strip，
            // design D5）。半透明遮罩写入 blend 层，被上层不透明卡片正确遮挡。
            if let Some(feedback) = &key.film_run {
                super::film_set::draw_film_set_run_mask(&mut geometry, theme, node, z + 0.02);
                let scope = super::scope::node_scope(node);
                if scope.aabb.width.max(scope.aabb.height) * scene.viewport.zoom >= 48. {
                    let label = match feedback.label_code.as_str() {
                        "submitting" => "提交中",
                        "queued" => "排队中",
                        "generating" => "生成中",
                        "modifying" => "修改中",
                        "saving" => "保存中",
                        "verifying" => "待确认",
                        _ => "运行中",
                    };
                    let zoom = scene.viewport.zoom.max(0.1);
                    let center = Vec2::new(
                        scope.aabb.x + scope.aabb.width / 2.,
                        scope.aabb.y + scope.aabb.height + 14. / zoom,
                    );
                    geometry.rounded_rect_alpha(
                        center.x - 27. / zoom,
                        center.y - 10. / zoom,
                        54. / zoom,
                        20. / zoom,
                        5. / zoom,
                        z + 0.02,
                        theme.token_u32("canvasNodeContent"),
                        0.9,
                    );
                    labels.push((
                        label.to_owned(),
                        center,
                        12. / zoom,
                        theme.token_u32(if feedback.phase == "verifying" {
                            "statusWarning"
                        } else {
                            "interactionAccent"
                        }),
                    ));
                }
            }
            if key.aggregate_run {
                let scope = super::scope::node_scope(node);
                let bounds = (
                    scope.aabb.x,
                    scope.aabb.y,
                    scope.aabb.width,
                    scope.aabb.height,
                );
                let label = super::history_strip::draw_aggregate_run_overlay(
                    &mut geometry,
                    theme,
                    bounds,
                    z + 0.02,
                );
                labels.push((
                    label,
                    Vec2::new(bounds.0 + bounds.2 / 2.0, bounds.1 + bounds.3 / 2.0),
                    14.,
                    theme.token_u32("interactionAccent"),
                ));
            }
            let request = LabelRequest {
                owner: input.entity,
                labels,
                z: z + 0.02,
                style: LabelStyle::Node,
            };
            requests.push_request(CanvasLabelRole::Container, request.clone());
            block_requests.push(request);
        }
        let (mut opaque, mut blend) = geometry.into_layers();
        let opaque_depth = 0.0002 * block_index as f32 / (count + 1) as f32;
        shift_depth(&mut opaque, opaque_depth);
        // The shared blend mesh retains overlays such as run masks and the aggregate band.
        shift_depth(&mut blend, -sort_z);
        for (layer, built) in [opaque, blend].into_iter().enumerate() {
            let handle = meshes.add(built);
            if let Some(old) = block.meshes[layer].replace(handle.clone()) {
                meshes.remove(old.id());
            }
            let transform = Transform::from_xyz(0., 0., if layer == 1 { sort_z } else { 0. });
            if let Some(entity) = block.entities[layer] {
                commands.entity(entity).insert((Mesh2d(handle), transform));
            } else {
                let material = if layer == 1 {
                    materials.blend.clone()
                } else {
                    materials.solid.clone()
                };
                block.entities[layer] = Some(
                    commands
                        .spawn((
                            Mesh2d(handle),
                            MeshMaterial2d(material),
                            transform,
                            NoFrustumCulling,
                        ))
                        .id(),
                );
            }
        }
        block.keys = keys;
        block.label_keys = label_keys;
        block.band = band;
        block.theme = theme.fingerprint().to_owned();
        block.sort_z = sort_z;
        block.labels = block_requests;
        rebuilt += 1;
    }
    visuals.blocks = blocks;
    rebuilt
}
fn shift_depth(mesh: &mut Mesh, delta: f32) {
    if let Some(VertexAttributeValues::Float32x3(positions)) =
        mesh.attribute_mut(Mesh::ATTRIBUTE_POSITION)
    {
        for p in positions {
            p[2] += delta;
        }
    }
}
#[cfg(test)]
pub(super) fn clear(commands: &mut Commands, meshes: &mut Assets<Mesh>, blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        block.clear(commands, meshes);
    }
    blocks.clear();
}
