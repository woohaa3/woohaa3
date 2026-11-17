//! 分块几何缓存回归（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs）。
//!
//! 这里按真实帧顺序驱动 ECS 画布管线：投影 → presentation → 分类型几何 → 选中描边 → 标签。
//! 标签断言改为查询 `CanvasLabel(role, slot) + ChildOf(owner)`，不再读取 `CanvasOverlayCache` 里的实体表。
use super::*;
mod baseline;
mod selection;
mod third_party;
use crate::app::{CurrentScene, FrameFlags};
use crate::canvas_ecs::components::{CanvasLabel, CanvasLabelRole, CanvasNodeId};
use crate::canvas_ecs::{
    CanvasProjectionState, SelectionOutlineBatch, SelectionOutlineLayer, flush_selection_outlines,
    project_canvas_nodes,
};
use crate::canvas2d::CanvasOverlayCache;
use crate::canvas2d::{
    begin_selection_outlines, observe_label_epoch, produce_card_geometry, produce_card_hover,
    produce_card_selection, produce_edges, sync_canvas_labels, sync_canvas_overlay,
};
use bevy::{asset::AssetId, ecs::system::RunSystemOnce};

fn world() -> World {
    let mut world = World::new();
    world.insert_resource(Assets::<Mesh>::default());
    world.insert_resource(Assets::<Image>::default());
    world.insert_resource(ThemeResource::default());
    world.insert_resource(FrameFlags::default());
    // 纹理/预览定位走同代节点索引（design D7 / 任务 7.2）。
    world.insert_resource(crate::app::NodeIndex::default());
    world.insert_resource(crate::app::ModelAssetTable::default());
    world.insert_resource(CanvasProjectionState::default());
    world.insert_resource(LabelRequests::default());
    world.insert_resource(SelectionOutlineBatch::default());
    world.insert_resource(SelectionOutlineLayer::default());
    world.insert_resource(crate::canvas2d::CanvasMaterials {
        solid: default(),
        blend: default(),
        font: default(),
    });
    world.insert_resource(crate::canvas2d::CardBlockCache::default());
    world.insert_resource(crate::canvas2d::CardDecorationCache::default());
    world.insert_resource(crate::canvas2d::EdgeBlockCache::default());
    world.insert_resource(crate::app::SurfaceState::with_size(Vec2::new(800.0, 600.0)));
    world.insert_resource(CanvasOverlayCache {
        mesh: default(),
        material: default(),
        mesh_entity: None,
        blend_mesh: default(),
        blend_material: default(),
        blend_mesh_entity: None,
        static_blend: crate::canvas2d::geometry::Geometry::default(),
        font: default(),
    });
    let nodes = (0..33)
        .map(|index| {
            serde_json::json!({
                "id":index.to_string(), "type":"text", "x":index * 10, "y":0,
                "title":format!("Card {index}"), "body":"Sample body", "width":240, "height":180,
            })
        })
        .collect::<Vec<_>>();
    world.insert_resource(CurrentScene(Scene {
        nodes: serde_json::from_value(serde_json::Value::Array(nodes)).unwrap(),
        ..default()
    }));
    world
}

fn rebuild_index(world: &mut World) {
    let scene = world.resource::<CurrentScene>().0.clone();
    world
        .resource_mut::<crate::app::NodeIndex>()
        .rebuild(&scene);
}

fn geometry_frame(world: &mut World) {
    world.run_system_once(produce_card_geometry).unwrap();
    world.run_system_once(produce_card_hover).unwrap();
    world.run_system_once(produce_edges).unwrap();
    world.run_system_once(sync_canvas_overlay).unwrap();
    world.flush();
}

fn render(world: &mut World) -> u64 {
    {
        let mut flags = world.resource_mut::<FrameFlags>();
        flags.changed = true;
        flags.scene_received = true;
        flags.positions_received = true;
        flags.card_blocks_rebuilt = 0;
        flags.card_decorations_rebuilt = 0;
        flags.edge_blocks_rebuilt = 0;
        flags.mesh_rebuilt = false;
    }
    rebuild_index(world);
    world.run_system_once(project_canvas_nodes).unwrap();
    world.flush();
    world.run_system_once(observe_label_epoch).unwrap();
    world.flush();
    geometry_frame(world);
    world.run_system_once(begin_selection_outlines).unwrap();
    world.run_system_once(produce_card_selection).unwrap();
    world.run_system_once(flush_selection_outlines).unwrap();
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    world.resource::<FrameFlags>().card_blocks_rebuilt
}

fn node_entity(world: &mut World, id: &str) -> Option<Entity> {
    world
        .query::<(Entity, &CanvasNodeId)>()
        .iter(world)
        .find(|(_, node_id)| node_id.0 == id)
        .map(|(entity, _)| entity)
}

fn labels_of(world: &mut World, id: &str) -> Vec<Entity> {
    let Some(owner) = node_entity(world, id) else {
        return Vec::new();
    };
    let mut rows: Vec<(u16, Entity)> = world
        .query::<(Entity, &CanvasLabel, &ChildOf)>()
        .iter(world)
        .filter(|(_, _, child)| child.parent() == owner)
        .map(|(entity, label, _)| (label.slot, entity))
        .collect();
    rows.sort_by_key(|(slot, _)| *slot);
    rows.into_iter().map(|(_, entity)| entity).collect()
}

#[test]
fn position_frame_rebuilds_only_incident_edge_block() {
    use bevy::ecs::system::{IntoSystem, System};
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.edges = (0..32)
        .map(|i| {
            serde_json::from_value(serde_json::json!({
                "id": format!("e{i}"), "source": i.to_string(), "target": (i + 1).to_string()
            }))
            .unwrap()
        })
        .collect();
    render(&mut world);
    let mut producer = IntoSystem::into_system(produce_edges);
    producer.initialize(&mut world);
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    let before: Vec<_> = world
        .resource::<crate::canvas2d::EdgeBlockCache>()
        .blocks
        .iter()
        .map(|block| block.state().0)
        .collect();
    let node = node_entity(&mut world, "17").unwrap();
    world.resource_mut::<CurrentScene>().0.nodes[17].x += 50.;
    world
        .get_mut::<crate::canvas_ecs::components::CanvasLayout>(node)
        .unwrap()
        .x += 50.;
    let mut changes = crate::app::RuntimeChanges::default();
    changes.has_scene = true;
    changes.edges =
        crate::canvas_runtime::EdgeIndex::build(&world.resource::<CurrentScene>().0.edges);
    changes.current.add_positions(
        &["17".into()],
        &*world.resource::<crate::app::NodeIndex>(),
        &changes.edges,
    );
    assert_eq!(
        changes
            .current
            .edge_blocks
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        vec![1]
    );
    world.insert_resource(changes);
    {
        let mut flags = world.resource_mut::<FrameFlags>();
        flags.scene_received = false;
        flags.positions_received = true;
        flags.theme_changed = false;
        flags.surface_changed = false;
        flags.resource_nodes.clear();
    }
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    let after: Vec<_> = world
        .resource::<crate::canvas2d::EdgeBlockCache>()
        .blocks
        .iter()
        .map(|block| block.state().0)
        .collect();
    assert_eq!(before.len(), 2);
    assert_eq!(before[0], after[0]);
    assert_ne!(before[1], after[1]);
    assert_eq!(world.resource::<FrameFlags>().edge_blocks_rebuilt, 1);
    assert_eq!(world.resource::<FrameFlags>().edge_layout_visits, 17);
    let stale = node_entity(&mut world, "16").unwrap();
    world.get_mut::<CanvasNodeId>(stale).unwrap().0 = "detached".into();
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    assert_eq!(
        world.resource::<FrameFlags>().edge_layout_visits,
        33,
        "stale endpoint identity must fall back to the full query"
    );
}

#[test]
fn position_frame_reads_only_dirty_card_block_and_falls_back_for_stale_entity() {
    use bevy::ecs::system::{IntoSystem, System};
    let mut world = world();
    render(&mut world);
    let mut producer = IntoSystem::into_system(produce_card_geometry);
    producer.initialize(&mut world);
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    let before: Vec<_> = world
        .resource::<CardBlockCache>()
        .blocks
        .iter()
        .map(|block| block.mesh.as_ref().unwrap().id())
        .collect();
    world.resource_mut::<CurrentScene>().0.nodes[17].x += 50.;
    let mut changes = crate::app::RuntimeChanges::default();
    changes.has_scene = true;
    changes.current.add_positions(
        &["17".into()],
        &*world.resource::<crate::app::NodeIndex>(),
        &changes.edges,
    );
    world.insert_resource(changes);
    {
        let mut flags = world.resource_mut::<FrameFlags>();
        flags.scene_received = false;
        flags.positions_received = true;
        flags.theme_changed = false;
        flags.surface_changed = false;
        flags.observer_changed = false;
        flags.resource_nodes.clear();
    }
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    let after: Vec<_> = world
        .resource::<CardBlockCache>()
        .blocks
        .iter()
        .map(|block| block.mesh.as_ref().unwrap().id())
        .collect();
    assert_eq!(before[0], after[0]);
    assert_ne!(before[1], after[1]);
    assert_eq!(before[2], after[2]);
    assert_eq!(world.resource::<FrameFlags>().card_blocks_rebuilt, 1);
    assert_eq!(world.resource::<FrameFlags>().card_input_visits, 16);

    let incremental = world
        .resource::<Assets<Mesh>>()
        .get(after[1])
        .unwrap()
        .attribute(Mesh::ATTRIBUTE_POSITION)
        .unwrap()
        .clone();
    // Force the reference path, including a rebuild, and compare actual vertices.
    world.resource_mut::<CardBlockCache>().blocks[1]
        .theme
        .clear();
    world.resource_mut::<FrameFlags>().scene_received = true;
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    let reference = world.resource::<CardBlockCache>().blocks[1]
        .mesh
        .as_ref()
        .unwrap()
        .id();
    assert_eq!(
        world
            .resource::<Assets<Mesh>>()
            .get(reference)
            .unwrap()
            .attribute(Mesh::ATTRIBUTE_POSITION)
            .unwrap(),
        &incremental
    );
    world.resource_mut::<FrameFlags>().scene_received = false;

    world
        .resource_mut::<crate::app::RuntimeChanges>()
        .current
        .card_blocks
        .clear();
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    assert_eq!(world.resource::<FrameFlags>().card_input_visits, 0);
    assert_eq!(world.resource::<FrameFlags>().card_blocks_rebuilt, 0);
    world
        .resource_mut::<crate::app::RuntimeChanges>()
        .current
        .card_blocks
        .insert(1);

    world.resource_mut::<CardBlockCache>().invalidate_labels();
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    assert_eq!(
        world.resource::<FrameFlags>().card_input_visits,
        33,
        "label invalidation must use the full query"
    );

    let stale = node_entity(&mut world, "16").unwrap();
    world.get_mut::<CanvasNodeId>(stale).unwrap().0 = "detached".into();
    producer.run((), &mut world).unwrap();
    producer.apply_deferred(&mut world);
    assert_eq!(
        world.resource::<FrameFlags>().card_input_visits,
        32,
        "stale identity must use the full query"
    );
}

#[test]
fn workset_only_writes_entered_left_and_new_block_visibility() {
    let mut world = world();
    for (index, node) in world
        .resource_mut::<CurrentScene>()
        .0
        .nodes
        .iter_mut()
        .enumerate()
    {
        node.x = (index / 16) as f32 * 5000.;
    }
    render(&mut world);
    let entities: Vec<_> = world
        .resource::<CardBlockCache>()
        .blocks
        .iter()
        .map(|block| block.entity.unwrap())
        .collect();
    assert_eq!(
        *world.get::<Visibility>(entities[0]).unwrap(),
        Visibility::Visible
    );
    assert_eq!(
        *world.get::<Visibility>(entities[1]).unwrap(),
        Visibility::Hidden
    );
    assert_eq!(
        *world.get::<Visibility>(entities[2]).unwrap(),
        Visibility::Hidden
    );
    world
        .run_system_once(
            |mut commands: Commands, mut cache: ResMut<CardBlockCache>| {
                cache.sync_workset(
                    &mut commands,
                    crate::protocol::Viewport {
                        x: -4600.,
                        y: 0.,
                        zoom: 1.,
                    },
                    Vec2::new(800., 600.),
                );
            },
        )
        .unwrap();
    world.flush();
    assert_eq!(world.resource::<CardBlockCache>().visibility_writes, 2);
    assert_eq!(
        *world.get::<Visibility>(entities[0]).unwrap(),
        Visibility::Hidden
    );
    assert_eq!(
        *world.get::<Visibility>(entities[1]).unwrap(),
        Visibility::Visible
    );
    assert_eq!(
        *world.get::<Visibility>(entities[2]).unwrap(),
        Visibility::Hidden
    );
    world
        .run_system_once(
            |mut commands: Commands, mut cache: ResMut<CardBlockCache>| {
                cache.sync_workset(
                    &mut commands,
                    crate::protocol::Viewport {
                        x: -4600.,
                        y: 0.,
                        zoom: 1.,
                    },
                    Vec2::new(800., 600.),
                );
            },
        )
        .unwrap();
    assert_eq!(world.resource::<CardBlockCache>().visibility_writes, 0);
}

#[cfg(feature = "canvas-reference")]
#[test]
fn reference_mode_rebuilds_all_blocks_and_keeps_offscreen_geometry_visible() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.nodes[32].x = 10000.;
    world.resource_mut::<CurrentScene>().0.edges = serde_json::from_value(serde_json::json!([{
        "id": "edge", "source": "31", "target": "32", "label": "reference"
    }]))
    .unwrap();
    assert_eq!(render(&mut world), 3);
    world
        .run_system_once(crate::canvas2d::sync_workset)
        .unwrap();
    world.flush();
    let card = world.resource::<CardBlockCache>().blocks[2].entity.unwrap();
    let edge = world.resource::<crate::canvas2d::EdgeBlockCache>().blocks[0].entity();
    assert_eq!(*world.get::<Visibility>(card).unwrap(), Visibility::Visible);
    assert_eq!(*world.get::<Visibility>(edge).unwrap(), Visibility::Visible);
    let before = world.resource::<crate::canvas2d::EdgeBlockCache>().blocks[0]
        .state()
        .0;
    assert_eq!(render(&mut world), 3);
    assert_ne!(
        before,
        world.resource::<crate::canvas2d::EdgeBlockCache>().blocks[0]
            .state()
            .0
    );
}

#[test]
fn workset_updates_only_changed_card_labels_and_initializes_new_ones() {
    use bevy::ecs::system::{IntoSystem, System};
    let mut world = world();
    for (index, node) in world
        .resource_mut::<CurrentScene>()
        .0
        .nodes
        .iter_mut()
        .enumerate()
    {
        node.x = (index / 16) as f32 * 5000.;
    }
    render(&mut world);
    let first = labels_of(&mut world, "0");
    let second = labels_of(&mut world, "16");
    let third = labels_of(&mut world, "32");
    assert!(!first.is_empty() && !second.is_empty() && !third.is_empty());
    let mut system = IntoSystem::into_system(crate::canvas2d::sync_workset);
    system.initialize(&mut world);
    system.run((), &mut world).unwrap();
    system.apply_deferred(&mut world);
    assert_eq!(
        *world.get::<Visibility>(first[0]).unwrap(),
        Visibility::Visible
    );
    assert_eq!(
        *world.get::<Visibility>(second[0]).unwrap(),
        Visibility::Hidden
    );
    assert_eq!(
        *world.get::<Visibility>(third[0]).unwrap(),
        Visibility::Hidden
    );
    world.resource_mut::<CurrentScene>().0.viewport.x = -4600.;
    {
        let mut flags = world.resource_mut::<FrameFlags>();
        flags.scene_received = false;
        flags.positions_received = false;
        flags.camera_changed = true;
    }
    system.run((), &mut world).unwrap();
    system.apply_deferred(&mut world);
    assert_eq!(
        *world.get::<Visibility>(first[0]).unwrap(),
        Visibility::Hidden
    );
    assert_eq!(
        *world.get::<Visibility>(second[0]).unwrap(),
        Visibility::Visible
    );
    assert_eq!(
        *world.get::<Visibility>(third[0]).unwrap(),
        Visibility::Hidden
    );
    let total = world
        .query::<&CanvasLabel>()
        .iter(&world)
        .filter(|label| label.role == CanvasLabelRole::Card)
        .count();
    assert!(world.resource::<FrameFlags>().card_visibility_label_visits < total);
    world.resource_mut::<FrameFlags>().camera_changed = false;
    system.run((), &mut world).unwrap();
    assert_eq!(
        world.resource::<FrameFlags>().card_visibility_label_visits,
        0
    );

    let owner = node_entity(&mut world, "32").unwrap();
    let new_label = world
        .spawn((
            CanvasLabel {
                role: CanvasLabelRole::Card,
                slot: 900,
            },
            ChildOf(owner),
            Visibility::Visible,
        ))
        .id();
    world.resource_mut::<LabelRequests>().note_applied(
        CanvasLabelRole::Card,
        LabelOwner::Node("32".into()),
        900,
        new_label,
    );
    system.run((), &mut world).unwrap();
    assert_eq!(
        *world.get::<Visibility>(new_label).unwrap(),
        Visibility::Hidden
    );
}

#[test]
fn edge_workset_keeps_cross_viewport_curves_and_hides_block_labels_with_parent() {
    use bevy::ecs::system::{IntoSystem, System};
    let mut world = world();
    {
        let mut scene = world.resource_mut::<CurrentScene>();
        scene.0.nodes[0].x = -5000.;
        scene.0.nodes[1].x = 5000.;
        scene.0.nodes[2].x = 10000.;
        scene.0.nodes[3].x = 10200.;
        scene.0.edges = (0..17)
            .map(|i| {
                serde_json::from_value(serde_json::json!({
                    "id": format!("edge-{i}"), "source": if i < 16 { "0" } else { "2" },
                    "target": if i < 16 { "1" } else { "3" }, "label": "edge"
                }))
                .unwrap()
            })
            .collect();
    }
    render(&mut world);
    let blocks: Vec<_> = world
        .resource::<crate::canvas2d::EdgeBlockCache>()
        .blocks
        .iter()
        .map(|block| block.entity())
        .collect();
    let mut system = IntoSystem::into_system(crate::canvas2d::sync_workset);
    system.initialize(&mut world);
    system.run((), &mut world).unwrap();
    system.apply_deferred(&mut world);
    assert_eq!(
        *world.get::<Visibility>(blocks[0]).unwrap(),
        Visibility::Visible,
        "curve crossing the viewport remains visible"
    );
    assert_eq!(
        *world.get::<Visibility>(blocks[1]).unwrap(),
        Visibility::Hidden
    );
    let labels: Vec<_> = world
        .query::<(&CanvasLabel, &ChildOf, &Visibility)>()
        .iter(&world)
        .filter(|(label, child, _)| {
            label.role == CanvasLabelRole::Edge && child.parent() == blocks[1]
        })
        .map(|(_, _, visibility)| *visibility)
        .collect();
    assert!(!labels.is_empty());
    assert!(
        labels
            .iter()
            .all(|visibility| *visibility == Visibility::Inherited)
    );
    world.resource_mut::<CurrentScene>().0.viewport.x = -9600.;
    world.resource_mut::<FrameFlags>().camera_changed = true;
    system.run((), &mut world).unwrap();
    system.apply_deferred(&mut world);
    assert_eq!(
        *world.get::<Visibility>(blocks[0]).unwrap(),
        Visibility::Hidden
    );
    assert_eq!(
        *world.get::<Visibility>(blocks[1]).unwrap(),
        Visibility::Visible
    );
}

#[test]
fn edge_lock_changes_invalidate_geometry_and_duplicate_ids_match_any_locked_node() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.edges = serde_json::from_value(serde_json::json!([{
        "id": "edge", "source": "0", "target": "1"
    }]))
    .unwrap();
    render(&mut world);
    let before = world.resource::<crate::canvas2d::EdgeBlockCache>().blocks[0]
        .state()
        .0;
    world.resource_mut::<CurrentScene>().0.nodes[0].edit_scope = Some(
        serde_json::from_value(serde_json::json!({"category": "canvas", "mode": "locked"}))
            .unwrap(),
    );
    render(&mut world);
    let after = world.resource::<crate::canvas2d::EdgeBlockCache>().blocks[0]
        .state()
        .0;
    assert_ne!(
        before, after,
        "a lock change must rebuild the edge's colors"
    );
    assert!(world.resource::<crate::app::NodeIndex>().is_locked("0"));

    let mut scene = world.resource::<CurrentScene>().0.clone();
    let mut duplicate = scene.nodes[0].clone();
    scene.nodes[0].edit_scope = None;
    duplicate.id = scene.nodes[0].id.clone();
    scene.nodes.push(duplicate);
    let mut index = crate::app::NodeIndex::default();
    index.rebuild(&scene);
    assert!(
        index.is_locked("0"),
        "any locked duplicate must mute the edge"
    );
    scene.nodes.pop();
    index.rebuild(&scene);
    assert!(
        !index.is_locked("0"),
        "rebuild must discard stale lock state"
    );
}

#[test]
fn warm_geometry_does_not_resubmit_cached_labels() {
    let mut world = world();
    assert!(render(&mut world) > 0);
    let commits = world
        .resource::<crate::canvas2d::labels::LabelRequests>()
        .commits();
    assert!(commits > 0, "首帧必须提交变化过的标签");
    assert_eq!(render(&mut world), 0);
    assert_eq!(
        world
            .resource::<crate::canvas2d::labels::LabelRequests>()
            .commits(),
        commits,
        "缓存命中不得再次提交"
    );
}

#[test]
fn static_frame_does_not_clone_label_requests_or_write_components() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.edges = serde_json::from_value(serde_json::json!([{
        "id": "e0",
        "source": "0",
        "target": "1",
        "label": "Edge 0"
    }]))
    .unwrap();
    assert!(render(&mut world) > 0);
    let requests = world.resource::<crate::canvas2d::labels::LabelRequests>();
    let clones = requests.request_clones();
    let writes = requests.component_writes();
    assert!(clones > 0, "首帧必须克隆脏标签规格，计数器才算接上");
    assert!(writes > 0, "首帧必须写入文字组件，计数器才算接上");
    assert!(
        !labels_with_role(&mut world, CanvasLabelRole::Edge).is_empty(),
        "带标签的边必须在首帧建出来"
    );
    assert_eq!(render(&mut world), 0, "卡片和边缓存命中不得重建");
    let requests = world.resource::<crate::canvas2d::labels::LabelRequests>();
    assert_eq!(
        requests.request_clones() - clones,
        0,
        "静止帧 label request clones"
    );
    assert_eq!(
        requests.component_writes() - writes,
        0,
        "静止帧 component writes"
    );
    assert!(
        !labels_with_role(&mut world, CanvasLabelRole::Edge).is_empty(),
        "边缓存命中不得丢掉已有标签"
    );
}

fn has_labels(world: &mut World, id: &str) -> bool {
    !labels_of(world, id).is_empty()
}

fn texts_of(world: &mut World, id: &str) -> Vec<String> {
    labels_of(world, id)
        .into_iter()
        .filter_map(|entity| world.get::<Text2d>(entity).map(|text| text.0.clone()))
        .collect()
}

fn edge_texts(world: &mut World) -> Vec<String> {
    labels_with_role(world, CanvasLabelRole::Edge)
        .into_iter()
        .filter_map(|entity| world.get::<Text2d>(entity).map(|text| text.0.clone()))
        .collect()
}

fn labels_with_role(world: &mut World, role: CanvasLabelRole) -> Vec<Entity> {
    world
        .query::<(Entity, &CanvasLabel)>()
        .iter(world)
        .filter(|(_, label)| label.role == role)
        .map(|(entity, _)| entity)
        .collect()
}

fn handles(world: &World) -> Vec<AssetId<Mesh>> {
    world
        .resource::<crate::canvas2d::CardBlockCache>()
        .blocks
        .iter()
        .filter_map(|b| b.mesh.as_ref().map(Handle::id))
        .collect()
}

fn changed(before: &[AssetId<Mesh>], after: &[AssetId<Mesh>]) -> Vec<usize> {
    before
        .iter()
        .zip(after)
        .enumerate()
        .filter_map(|(i, (a, b))| (a != b).then_some(i))
        .collect()
}

#[test]
fn local_move_selection_hover_and_theme_rebuild_only_their_blocks() {
    let mut world = world();
    assert_eq!(render(&mut world), 3);
    let initial = handles(&world);
    assert_eq!(render(&mut world), 0);
    assert_eq!(handles(&world), initial);
    world.resource_mut::<CurrentScene>().0.nodes[17].x += 50.;
    assert_eq!(render(&mut world), 1);
    assert_eq!(changed(&initial, &handles(&world)), [1]);
    let moved = handles(&world);
    world.resource_mut::<CurrentScene>().0.selection.nodes = vec!["0".into()];
    let labels = labels_of(&mut world, "0");
    assert!(!labels.is_empty());
    assert_eq!(render(&mut world), 0);
    assert_eq!(handles(&world), moved);
    assert_eq!(labels_of(&mut world, "0"), labels);
    // 选中描边走独立批次，不再混进卡片几何或装饰块。
    assert!(
        world.resource::<SelectionOutlineLayer>().entity().is_some(),
        "选中描边必须有独立批次实体"
    );
    world.resource_mut::<CurrentScene>().0.hover =
        Some(serde_json::from_value(serde_json::json!({"nodeId":"17", "port":"input"})).unwrap());
    assert_eq!(render(&mut world), 0);
    let hovered = handles(&world);
    let hover_decor = world
        .resource::<crate::canvas2d::CardDecorationCache>()
        .blocks[1]
        .handle()
        .unwrap();
    world
        .resource_mut::<CurrentScene>()
        .0
        .hover
        .as_mut()
        .unwrap()
        .node_id = Some("32".into());
    assert_eq!(render(&mut world), 0);
    assert_eq!(handles(&world), hovered);
    assert!(
        world
            .resource::<crate::canvas2d::CardDecorationCache>()
            .blocks[1]
            .handle()
            .is_none()
    );
    assert!(
        world
            .resource::<crate::canvas2d::CardDecorationCache>()
            .blocks[2]
            .handle()
            .is_some()
    );
    assert!(!world.resource::<Assets<Mesh>>().contains(hover_decor));
    // Progress and camera data are not static-card draw inputs.
    world.resource_mut::<CurrentScene>().0.nodes[0].progress = 50.;
    world.resource_mut::<CurrentScene>().0.viewport.x += 100.;
    assert_eq!(render(&mut world), 0);
    world.resource_mut::<ThemeResource>().0.fingerprint = "new-theme".into();
    assert_eq!(render(&mut world), 3);
}

#[test]
fn block_partition_keeps_exact_vertex_positions_colors_and_document_z() {
    use bevy::render::mesh::VertexAttributeValues;
    let mut world = world();
    render(&mut world);
    let scene = &world.resource::<CurrentScene>().0;
    let theme = world.resource::<ThemeResource>();
    let mut original = Geometry::default();
    for (index, node) in scene.nodes.iter().enumerate() {
        super::super::cards::draw(&mut original, theme, node, false, None, index);
    }
    let (expected, blend) = original.into_layers();
    assert_eq!(
        blend.attribute(Mesh::ATTRIBUTE_POSITION).unwrap().len(),
        3,
        "ordinary cards must remain opaque when drawn with the shared opaque material"
    );
    for attribute in [Mesh::ATTRIBUTE_POSITION, Mesh::ATTRIBUTE_COLOR] {
        let buffers: Vec<_> = handles(&world)
            .into_iter()
            .map(|id| {
                world
                    .resource::<Assets<Mesh>>()
                    .get(id)
                    .unwrap()
                    .attribute(attribute)
                    .unwrap()
                    .clone()
            })
            .collect();
        match expected.attribute(attribute).unwrap() {
            VertexAttributeValues::Float32x3(expected) => {
                let actual: Vec<_> = buffers
                    .into_iter()
                    .flat_map(|b| match b {
                        VertexAttributeValues::Float32x3(v) => v,
                        _ => panic!(),
                    })
                    .collect();
                assert_eq!(&actual, expected);
            }
            VertexAttributeValues::Float32x4(expected) => {
                let actual: Vec<_> = buffers
                    .into_iter()
                    .flat_map(|b| match b {
                        VertexAttributeValues::Float32x4(v) => v,
                        _ => panic!(),
                    })
                    .collect();
                assert_eq!(&actual, expected);
            }
            _ => panic!(),
        }
    }
}

#[test]
fn media_focus_keeps_background_cards_and_restores_current_card() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.selection.nodes = vec!["0".into()];
    render(&mut world);
    let initial = handles(&world);
    world.resource_mut::<CurrentScene>().0.image_focus = Some(
        serde_json::from_value(
            serde_json::json!({"version":"woohaa-image-focus-v1", "nodeId":"0",
            "viewport":{"x":0,"y":0,"zoom":1}, "sourceWidth":640,"sourceHeight":480}),
        )
        .unwrap(),
    );
    assert_eq!(render(&mut world), 1);
    assert_eq!(handles(&world).len(), initial.len());
    assert_eq!(changed(&initial, &handles(&world)), [0]);
    assert!(!world.resource::<Assets<Mesh>>().contains(initial[0]));
    assert!(!has_labels(&mut world, "0"));
    assert!(has_labels(&mut world, "17"));
    world.resource_mut::<CurrentScene>().0.nodes[17].title = "Remote change while focused".into();
    assert_eq!(render(&mut world), 0);
    world.resource_mut::<CurrentScene>().0.image_focus = None;
    assert_eq!(render(&mut world), 1);
    let label = labels_of(&mut world, "17")[0];
    assert!(world.get::<Text2d>(label).unwrap().0.starts_with("Remote"));
}

#[test]
fn workset_uses_the_media_focus_camera_instead_of_document_viewport() {
    let mut world = world();
    let mut scene = world.resource_mut::<CurrentScene>();
    scene.0.viewport.x = 1234.;
    scene.0.viewport.zoom = 0.25;
    scene.0.image_focus = Some(
        serde_json::from_value(serde_json::json!({
            "version": "woohaa-image-focus-v1", "nodeId": "0",
            "viewport": {"x": 20, "y": 30, "zoom": 2}, "sourceWidth": 640, "sourceHeight": 480
        }))
        .unwrap(),
    );
    let expected = crate::canvas2d::image_focus::camera_view(&scene.0).unwrap();
    let actual = crate::canvas2d::render::workset_viewport(&scene.0);
    assert_eq!((actual.x, actual.y, actual.zoom), expected);
    assert_ne!(actual.x, scene.0.viewport.x);
}

/// 纯视口跨档只更新文字呈现：不重建静态 2D mesh（change: 2026-10-22-improve-canvas-text-clarity，
/// design D4「纯视口跨档仍复用主场景 mesh、空间索引与媒体纹理」）。
#[test]
fn viewport_only_step_change_updates_text_without_rebuilding_meshes() {
    use crate::canvas2d::text_presentation;
    let mut world = world();
    world.insert_resource(text_presentation::PresentationCache::default());
    world.insert_resource(crate::app::SurfaceState::with_size(Vec2::new(
        1200.0, 800.0,
    )));
    render(&mut world);
    let initial = handles(&world);
    let decorations: Vec<_> = world
        .resource::<crate::canvas2d::CardDecorationCache>()
        .blocks
        .iter()
        .filter_map(|block| block.handle())
        .collect();
    let label = labels_of(&mut world, "0")[0];
    // 纯视口增量：`flags.changed` 保持 false，只有相机需要跟随。
    {
        let mut flags = world.resource_mut::<FrameFlags>();
        flags.changed = false;
        flags.viewport_only = true;
        flags.camera_changed = true;
        flags.mesh_rebuilt = false;
        flags.card_blocks_rebuilt = 0;
        flags.edge_blocks_rebuilt = 0;
        flags.card_decorations_rebuilt = 0;
    }
    world.resource_mut::<CurrentScene>().0.viewport.zoom = 8.0;
    geometry_frame(&mut world);
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    world.run_system_once(text_presentation::sync).unwrap();
    // 静态几何完全未重建。
    let flags = world.resource::<FrameFlags>();
    assert!(!flags.mesh_rebuilt, "纯视口不得重建主场景 mesh");
    assert_eq!(flags.card_blocks_rebuilt, 0);
    assert_eq!(flags.edge_blocks_rebuilt, 0);
    assert_eq!(flags.card_decorations_rebuilt, 0);
    assert_eq!(handles(&world), initial);
    assert!(
        world
            .resource::<crate::canvas2d::CardDecorationCache>()
            .blocks
            .iter()
            .filter_map(|block| block.handle())
            .eq(decorations.iter().copied()),
        "装饰 mesh 也必须复用"
    );
    // 文字呈现已按新档位更新（zoom 8 → 档位 8）。
    let font = world.get::<TextFont>(label).unwrap().font_size;
    assert_eq!(font, FontSize::Px(96.0), "标题逻辑字号 12 × 档位 8");
    let scale = world.get::<Transform>(label).unwrap().scale.x;
    assert!((96.0 * scale - 12.0).abs() <= 1.0e-3);
}

#[test]
fn edge_blocks_retain_unaffected_meshes_and_labels_on_local_changes() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.edges =
        serde_json::from_value(serde_json::Value::Array(
            (0..33)
                .map(|i| {
                    serde_json::json!({"id":format!("e{i}"), "source":i.to_string(),
            "target":((i+1)%33).to_string(), "label":format!("Edge {i}")})
                })
                .collect(),
        ))
        .unwrap();
    render(&mut world);
    let snapshot = |world: &World| {
        world
            .resource::<crate::canvas2d::EdgeBlockCache>()
            .blocks
            .iter()
            .map(|b| b.state())
            .collect::<Vec<_>>()
    };
    let initial = snapshot(&world);
    assert_eq!(
        labels_with_role(&mut world, CanvasLabelRole::Edge).len(),
        33
    );
    render(&mut world);
    assert_eq!(snapshot(&world), initial);
    world.resource_mut::<CurrentScene>().0.nodes[17].x += 25.;
    render(&mut world);
    let moved = snapshot(&world);
    assert_eq!(moved[0], initial[0]);
    assert_ne!(moved[1].0, initial[1].0);
    assert_eq!(moved[2], initial[2]);
    assert!(!world.resource::<Assets<Mesh>>().contains(initial[1].0));
    // 标签请求按 owner+role+slot 复用实体；重建块后文案仍与当前边一致。
    let edge_labels = labels_with_role(&mut world, CanvasLabelRole::Edge);
    assert_eq!(edge_labels.len(), 33);
    assert!(
        edge_labels
            .iter()
            .any(|entity| world.get::<Text2d>(*entity).unwrap().0 == "Edge 17")
    );
    world.resource_mut::<CurrentScene>().0.nodes[0].title = "Only card text changed".into();
    world.resource_mut::<CurrentScene>().0.selection.nodes = vec!["0".into()];
    render(&mut world);
    assert_eq!(snapshot(&world), moved);
    world.resource_mut::<CurrentScene>().0.selection.edge = Some("e0".into());
    render(&mut world);
    let selected = snapshot(&world);
    assert_ne!(selected[0].0, moved[0].0);
    assert_eq!(selected[1..], moved[1..]);
    world.resource_mut::<CurrentScene>().0.hover =
        Some(serde_json::from_value(serde_json::json!({"edgeId":"e32"})).unwrap());
    render(&mut world);
    let hovered = snapshot(&world);
    assert_eq!(hovered[..2], selected[..2]);
    assert_ne!(hovered[2].0, selected[2].0);
    world.resource_mut::<CurrentScene>().0.edges.clear();
    render(&mut world);
    assert!(
        world
            .resource::<crate::canvas2d::EdgeBlockCache>()
            .blocks
            .is_empty()
    );
    assert!(
        labels_with_role(&mut world, CanvasLabelRole::Edge).is_empty(),
        "清空边后不得残留连线标签"
    );
    for (mesh, _labels) in hovered {
        assert!(!world.resource::<Assets<Mesh>>().contains(mesh));
    }
}

fn set_canvas(world: &mut World, canvas_id: &str) {
    world.resource_mut::<CurrentScene>().0.canvas_id = canvas_id.to_owned();
}

#[test]
fn switching_canvas_rebinds_same_node_and_does_not_leak_stale_labels() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.edges = serde_json::from_value(serde_json::json!([{
        "id": "e0",
        "source": "0",
        "target": "1",
        "label": "Edge 0"
    }]))
    .unwrap();
    set_canvas(&mut world, "canvas-a");
    render(&mut world);
    let parent = node_entity(&mut world, "0").expect("节点实体");
    let before = labels_of(&mut world, "0");
    assert!(!before.is_empty(), "A 必须有卡片标签");
    assert_eq!(edge_texts(&mut world), vec!["Edge 0".to_owned()]);

    set_canvas(&mut world, "canvas-b");
    render(&mut world);
    let after = labels_of(&mut world, "0");
    assert_eq!(
        node_entity(&mut world, "0"),
        Some(parent),
        "同 ID 节点应复用"
    );
    assert_eq!(
        after.len(),
        before.len(),
        "同内容切画布不得丢标签，也不得重复"
    );
    assert!(
        after.iter().all(|entity| !before.contains(entity)),
        "旧标签实体必须拆掉后重绑"
    );
    assert!(
        texts_of(&mut world, "0")
            .iter()
            .any(|text| text.contains("Card 0"))
    );
    assert_eq!(edge_texts(&mut world), vec!["Edge 0".to_owned()]);

    world.resource_mut::<CurrentScene>().0.nodes[0].title = "Renamed".into();
    render(&mut world);
    let renamed = texts_of(&mut world, "0");
    assert_eq!(renamed.len(), after.len());
    assert!(renamed.iter().any(|text| text.contains("Renamed")));
    assert!(renamed.iter().all(|text| !text.contains("Card 0")));
    assert_eq!(edge_texts(&mut world), vec!["Edge 0".to_owned()]);
}

#[test]
fn switching_canvas_drops_labels_when_the_new_canvas_has_empty_content() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.edges = serde_json::from_value(serde_json::json!([{
        "id": "e0",
        "source": "0",
        "target": "1",
        "label": "Edge 0"
    }]))
    .unwrap();
    set_canvas(&mut world, "canvas-a");
    render(&mut world);
    assert!(has_labels(&mut world, "0"));

    set_canvas(&mut world, "canvas-b");
    {
        let node = &mut world.resource_mut::<CurrentScene>().0.nodes[0];
        node.chrome = crate::protocol::NodeChrome::None;
        node.title.clear();
        node.body.clear();
    }
    world.resource_mut::<CurrentScene>().0.edges[0]
        .label
        .clear();
    render(&mut world);
    assert!(
        labels_of(&mut world, "0").is_empty(),
        "空内容不得留下 A 的卡片标签"
    );
    assert!(
        edge_texts(&mut world).is_empty(),
        "空边文案不得留下 A 的边标签"
    );
}
