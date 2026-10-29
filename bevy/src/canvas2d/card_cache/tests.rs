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
use crate::canvas2d::{
    begin_selection_outlines, produce_card_geometry, produce_card_hover, produce_card_selection,
    produce_container_geometry, produce_edges, produce_film_set_selection, produce_group_selection,
    sync_canvas_labels, sync_canvas_overlay,
};
use crate::canvas_ecs::{
    flush_selection_outlines, project_canvas_nodes, sync_group_panels, CanvasProjectionState,
    SelectionOutlineBatch, SelectionOutlineLayer,
};
use bevy::{asset::AssetId, ecs::system::RunSystemOnce};
use crate::canvas2d::CanvasOverlayCache;

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
    world.insert_resource(crate::canvas2d::ContainerBlockCache::default());
    world.insert_resource(crate::canvas2d::EdgeBlockCache::default());
    world.insert_resource(CanvasOverlayCache {
        mesh: default(),
        material: default(),
        mesh_entity: None,
        blend_mesh: default(),
        blend_material: default(),
        blend_mesh_entity: None,
        font: default(),
        shared_key: None,
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
    world.resource_mut::<crate::app::NodeIndex>().rebuild(&scene);
}

fn geometry_frame(world: &mut World) {
    world.run_system_once(produce_card_geometry).unwrap();
    world.run_system_once(produce_card_hover).unwrap();
    world.run_system_once(produce_container_geometry).unwrap();
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
        flags.container_blocks_rebuilt = 0;
        flags.mesh_rebuilt = false;
    }
    rebuild_index(world);
    world.run_system_once(project_canvas_nodes).unwrap();
    world.flush();
    world.run_system_once(sync_group_panels).unwrap();
    world.flush();
    geometry_frame(world);
    world.run_system_once(begin_selection_outlines).unwrap();
    world.run_system_once(produce_card_selection).unwrap();
    world.run_system_once(produce_group_selection).unwrap();
    world.run_system_once(produce_film_set_selection).unwrap();
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

fn has_labels(world: &mut World, id: &str) -> bool {
    !labels_of(world, id).is_empty()
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
        world
            .resource::<SelectionOutlineLayer>()
            .entity()
            .is_some(),
        "选中描边必须有独立批次实体"
    );
    world.resource_mut::<CurrentScene>().0.hover =
        Some(serde_json::from_value(serde_json::json!({"nodeId":"17", "port":"input"})).unwrap());
    assert_eq!(render(&mut world), 0);
    let hovered = handles(&world);
    let hover_decor = world.resource::<crate::canvas2d::CardDecorationCache>().blocks[1]
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
        world.resource::<crate::canvas2d::CardDecorationCache>().blocks[1]
            .handle()
            .is_none()
    );
    assert!(
        world.resource::<crate::canvas2d::CardDecorationCache>().blocks[2]
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
fn deletion_kind_changes_and_clear_release_buffers_without_stale_labels() {
    let mut world = world();
    render(&mut world);
    let initial = handles(&world);
    // Converting an ordinary card to a group also trims its label pool.
    world.resource_mut::<CurrentScene>().0.nodes[0].group = Some(
        serde_json::from_value(serde_json::json!({"title":"Group", "memberCount":1})).unwrap(),
    );
    assert_eq!(render(&mut world), 1);
    assert_eq!(labels_of(&mut world, "0").len(), 1);
    world.resource_mut::<CurrentScene>().0.nodes.truncate(16);
    render(&mut world);
    assert_eq!(handles(&world).len(), 1);
    assert!(!world.resource::<Assets<Mesh>>().contains(initial[1]));
    assert!(!world.resource::<Assets<Mesh>>().contains(initial[2]));
    assert!(!has_labels(&mut world, "32"));
    let mut blocks = std::mem::take(&mut world.resource_mut::<crate::canvas2d::CardBlockCache>().blocks);
    let ids: Vec<_> = blocks.iter().map(|b| b.entity.unwrap()).collect();
    let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    clear(&mut world.commands(), &mut meshes, &mut blocks);
    world.flush();
    assert!(blocks.is_empty());
    assert!(ids.iter().all(|id| world.get_entity(*id).is_err()));
    // Restoring a cleared view recreates every block from current facts.
    world.insert_resource(meshes);
    assert_eq!(render(&mut world), 1);
    world.resource_mut::<CurrentScene>().0.nodes.clear();
    render(&mut world);
    assert!(handles(&world).is_empty());
    assert!(world.resource::<crate::canvas2d::CardDecorationCache>().blocks.is_empty());
    assert!(
        world
            .query::<&CanvasLabel>()
            .iter(&world)
            .next()
            .is_none(),
        "删除全部节点后不得残留标签实体"
    );
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
        flags.container_blocks_rebuilt = 0;
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
    assert_eq!(flags.container_blocks_rebuilt, 0);
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
    assert_eq!(labels_with_role(&mut world, CanvasLabelRole::Edge).len(), 33);
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
    assert!(edge_labels
        .iter()
        .any(|entity| world.get::<Text2d>(*entity).unwrap().0 == "Edge 17"));
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
    assert!(world.resource::<crate::canvas2d::EdgeBlockCache>().blocks.is_empty());
    assert!(
        labels_with_role(&mut world, CanvasLabelRole::Edge).is_empty(),
        "清空边后不得残留连线标签"
    );
    for (mesh, _labels) in hovered {
        assert!(!world.resource::<Assets<Mesh>>().contains(mesh));
    }
}

#[test]
fn shared_group_and_overlay_buffers_ignore_unrelated_card_changes() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.nodes[31].group = Some(
        serde_json::from_value(serde_json::json!({"title":"Container", "memberCount":3})).unwrap(),
    );
    render(&mut world);
    let shared = |world: &World| {
        let visuals = world.resource::<CanvasOverlayCache>();
        (visuals.mesh.id(), visuals.blend_mesh.id())
    };
    let initial = shared(&world);
    let label = labels_of(&mut world, "31");
    world.resource_mut::<CurrentScene>().0.selection.nodes = vec!["0".into()];
    world.resource_mut::<CurrentScene>().0.hover =
        Some(serde_json::from_value(serde_json::json!({"nodeId":"0"})).unwrap());
    world.resource_mut::<CurrentScene>().0.nodes[0].title = "New card title".into();
    world.resource_mut::<CurrentScene>().0.nodes[0].x += 50.;
    render(&mut world);
    assert_eq!(shared(&world), initial);
    assert!(!world.resource::<FrameFlags>().mesh_rebuilt);
    assert_eq!(labels_of(&mut world, "31"), label);
    let container = world.resource::<crate::canvas2d::ContainerBlockCache>().blocks[1].state();
    world.resource_mut::<CurrentScene>().0.nodes[31].x += 25.;
    render(&mut world);
    assert_eq!(shared(&world), initial);
    assert_ne!(
        world.resource::<crate::canvas2d::ContainerBlockCache>().blocks[1].state(),
        container
    );
    world.resource_mut::<CurrentScene>().0.drag_attach =
        Some(serde_json::from_value(serde_json::json!({"nodeId":"0"})).unwrap());
    render(&mut world);
    let attached = shared(&world);
    world.resource_mut::<CurrentScene>().0.nodes[17].x += 50.;
    render(&mut world);
    assert_eq!(shared(&world), attached);
    world.resource_mut::<CurrentScene>().0.nodes[0].x += 25.;
    render(&mut world);
    assert_ne!(shared(&world), attached);
    let moved = shared(&world);
    world.resource_mut::<CurrentScene>().0.drag_attach = None;
    render(&mut world);
    assert_ne!(
        shared(&world),
        moved,
        "cancel must remove old attach geometry"
    );
    assert!(labels_with_role(&mut world, CanvasLabelRole::Attach).is_empty());
}

#[test]
fn container_blocks_update_locally_and_keep_group_fill_out_of_overlays() {
    use bevy::mesh::VertexAttributeValues;
    let mut world = world();
    for node in &mut world.resource_mut::<CurrentScene>().0.nodes {
        node.group = Some(
            serde_json::from_value(serde_json::json!({
            "title":format!("Group {}",node.id), "memberCount":2}))
            .unwrap(),
        );
    }
    render(&mut world);
    let snapshot = |world: &World| {
        world
            .resource::<crate::canvas2d::ContainerBlockCache>()
            .blocks
            .iter()
            .map(|b| b.state())
            .collect::<Vec<_>>()
    };
    let initial = snapshot(&world);
    assert_eq!(world.resource::<FrameFlags>().container_blocks_rebuilt, 3);
    let mut previous = -1.0;
    for block in &world.resource::<crate::canvas2d::ContainerBlockCache>().blocks {
        let entity = block.blend_entity().unwrap();
        let sort_z = world.get::<Transform>(entity).unwrap().translation.z;
        assert!(
            sort_z > previous && sort_z < 0.,
            "groups must draw in document order before high overlays"
        );
        previous = sort_z;
        let mesh = world
            .resource::<Assets<Mesh>>()
            .get(block.state()[1].unwrap())
            .unwrap();
        let VertexAttributeValues::Float32x3(positions) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap()
        else {
            panic!()
        };
        // Group surfaces belong to the existing 3D camera, never this higher 2D overlay.
        // A group-only blend buffer therefore contains only the invisible empty-mesh sentinel.
        assert!(positions.iter().all(|p| p[0] < -100000.));
    }
    // Container title is a label-only input and must retain every range/frame mesh.
    world.resource_mut::<CurrentScene>().0.nodes[0].group.as_mut().unwrap().title = "Renamed".into();
    render(&mut world);
    assert_eq!(snapshot(&world), initial);
    assert_eq!(world.resource::<FrameFlags>().container_blocks_rebuilt, 0);
    world.resource_mut::<CurrentScene>().0.nodes[17].x += 25.;
    render(&mut world);
    let moved = snapshot(&world);
    assert_eq!(moved[0], initial[0]);
    assert_ne!(moved[1], initial[1]);
    assert_eq!(moved[2], initial[2]);
    assert_eq!(world.resource::<FrameFlags>().container_blocks_rebuilt, 1);
    world.resource_mut::<CurrentScene>().0.selection.nodes = vec!["32".into()];
    render(&mut world);
    let selected = snapshot(&world);
    assert_eq!(selected[..2], moved[..2]);
    assert_ne!(selected[2], moved[2]);
    world.resource_mut::<CurrentScene>().0.nodes.clear();
    render(&mut world);
    assert!(world.resource::<crate::canvas2d::ContainerBlockCache>().blocks.is_empty());
    for handle in selected.into_iter().flatten().flatten() {
        assert!(!world.resource::<Assets<Mesh>>().contains(handle));
    }
    assert!(world
        .query::<&CanvasLabel>()
        .iter(&world)
        .next()
        .is_none());
}

#[test]
fn film_run_mask_covers_exact_scope_in_every_active_phase_and_clears_at_terminal() {
    use bevy::mesh::VertexAttributeValues;
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.nodes = serde_json::from_value(serde_json::json!([{
        "id":"film", "type":"model", "x":100,"y":100,"width":200,"height":160,
        "compositeAsset":{"x":100,"y":100,"width":200,"height":160,"scopeShape":"isometric-diamond"},
        "aggregateRun":{"active":true,"filmSet":{"operationKey":"operation","phase":"running","source":"agent","labelCode":"generating"}}
    }])).unwrap();
    let expected =
        crate::canvas_query::scope::node_scope(&world.resource::<CurrentScene>().0.nodes[0])
            .vertices;
    let mask_vertices = |world: &World| {
        let id = world.resource::<crate::canvas2d::ContainerBlockCache>().blocks[0].state()[1].unwrap();
        let mesh = world.resource::<Assets<Mesh>>().get(id).unwrap();
        let VertexAttributeValues::Float32x3(positions) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap()
        else {
            panic!()
        };
        let VertexAttributeValues::Float32x4(colors) =
            mesh.attribute(Mesh::ATTRIBUTE_COLOR).unwrap()
        else {
            panic!()
        };
        positions
            .iter()
            .zip(colors)
            .filter(|(_, color)| (color[3] - 0.45).abs() < 1e-6)
            .map(|(p, _)| Vec2::new(p[0], -p[1]))
            .collect::<Vec<_>>()
    };
    for phase in ["submitting", "queued", "running", "committing", "verifying"] {
        world.resource_mut::<CurrentScene>().0.nodes[0]
            .aggregate_run
            .as_mut()
            .unwrap()
            .film_set
            .as_mut()
            .unwrap()
            .phase = phase.into();
        render(&mut world);
        assert_eq!(
            mask_vertices(&world),
            expected,
            "backdrop must stay visible in {phase}"
        );
        let handles = world.resource::<crate::canvas2d::ContainerBlockCache>().blocks[0].state();
        render(&mut world);
        assert_eq!(
            world.resource::<crate::canvas2d::ContainerBlockCache>().blocks[0].state(),
            handles
        );
    }
    // Ground geometry can change while the node and base rectangle remain unchanged.
    world.resource_mut::<CurrentScene>().0.nodes[0]
        .composite_asset
        .as_mut()
        .unwrap()
        .scope_ground = Some(
        serde_json::from_value(serde_json::json!({"cx":210,"cy":190,"hx":140,"hz":90})).unwrap(),
    );
    render(&mut world);
    let moved =
        crate::canvas_query::scope::node_scope(&world.resource::<CurrentScene>().0.nodes[0])
            .vertices;
    assert_ne!(moved, expected);
    assert_eq!(mask_vertices(&world), moved);
    world.resource_mut::<CurrentScene>().0.nodes[0].aggregate_run = None;
    render(&mut world);
    assert!(mask_vertices(&world).is_empty());
}
