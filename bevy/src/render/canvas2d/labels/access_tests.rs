//! 阶段 1 访问量与静止帧。
//!
//! `request_clones` 只计这些 `LabelSpec` / 保留标签向量克隆：
//! - 期望集 `work` / `dirty_view` / `spec_at` 的规格克隆
//! - 同步再克隆一份脏规格
//! - 边块把保留的标签切片克隆进事务
//!
//! 不计 owner、键克隆，也不计写进 `Text2d` 的字符串。`contains` 只判断存在。
//! 墓碑不克隆规格。相同内容不入脏队列、不写组件。

use super::*;
use crate::app::{CurrentScene, NodeIndex};
use crate::canvas_ecs::components::{
    CanvasDepth, CanvasLabel, CanvasLabelRole, CanvasLayout, CanvasNodeId, NodeActionBar,
};
use crate::canvas2d::text_presentation;
use crate::protocol::{GraphNode, NodeAction, NodeActions, NodeChrome};
use crate::theme::ThemeResource;
use bevy::ecs::system::RunSystemOnce;

const OWNERS: usize = 3000;

fn world() -> World {
    let mut world = World::new();
    world.insert_resource(CurrentScene(crate::protocol::Scene {
        viewport: crate::protocol::Viewport {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        },
        ..Default::default()
    }));
    world.insert_resource(crate::app::SurfaceState::with_size(Vec2::new(800.0, 600.0)));
    world.insert_resource(text_presentation::PresentationCache::default());
    world.insert_resource(LabelRequests::default());
    world.insert_resource(CanvasOverlayCache::default_for_test());
    world
}

fn spec(text: &str) -> LabelSpec {
    LabelSpec::from_label(
        (text.into(), Vec2::ZERO, 12.0, 0xFFFFFF),
        5.0,
        LabelStyle::Node,
    )
}

fn labels_of(world: &mut World, owner: Entity) -> Vec<Entity> {
    world
        .query::<(Entity, &ChildOf)>()
        .iter(world)
        .filter(|(_, child)| child.parent() == owner)
        .map(|(entity, _)| entity)
        .collect()
}

fn sync(world: &mut World) {
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
}

/// 几何消费者在渲染路径确认。Labels 单独确认不能丢掉脏键。
fn ack_geometry(world: &mut World) {
    world.resource_mut::<LabelRequests>().ack_geometry();
}

fn commit_one(world: &mut World, owner: LabelOwner, parent: Entity, text: &str) {
    let mut requests = world.resource_mut::<LabelRequests>();
    requests.bind(owner.clone(), parent);
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.upsert(CanvasLabelRole::Card, owner, 0, spec(text));
    txn.commit().unwrap();
}

#[test]
fn stable_frame_does_not_scan_live_bindings() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    commit_one(
        &mut world,
        LabelOwner::Node("stable".into()),
        parent,
        "keep",
    );
    sync(&mut world);
    let before = world.resource::<LabelRequests>().binding_visits();
    let clones = world.resource::<LabelRequests>().request_clones();
    let writes = world.resource::<LabelRequests>().component_writes();

    sync(&mut world);

    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.binding_visits(), before);
    assert_eq!(requests.full_scans(), 0);
    assert_eq!(requests.request_clones(), clones);
    assert_eq!(requests.component_writes(), writes);
    assert_eq!(requests.binding_len(), 1);
}

#[test]
fn deleting_one_of_many_owners_visits_only_that_owner() {
    let mut world = world();
    // 移除游标属于系统实例。每次 `run_system_once` 都是新系统，会把同一次移除再投递一遍。
    let mut schedule = Schedule::default();
    schedule.add_systems(sync_canvas_labels);
    let mut parents = Vec::with_capacity(OWNERS);
    for index in 0..OWNERS {
        let parent = world.spawn(Transform::IDENTITY).id();
        commit_one(
            &mut world,
            LabelOwner::Node(format!("n{index}")),
            parent,
            "row",
        );
        parents.push(parent);
    }
    schedule.run(&mut world);
    world.flush();
    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.binding_len(), OWNERS);
    assert_eq!(requests.full_scans(), 0);
    let visits = requests.binding_visits();
    let index_visits = requests.index_visits();
    let clones = requests.request_clones();
    let victim = parents[OWNERS / 2];
    let victim_owner = LabelOwner::Node(format!("n{}", OWNERS / 2));

    world.despawn(victim);
    world.flush();
    schedule.run(&mut world);
    world.flush();

    let requests = world.resource::<LabelRequests>();
    let slots = 1u64;
    assert_eq!(
        requests.binding_visits() - visits,
        1 + slots,
        "one removal event plus that owner's applied slots, not every live binding"
    );
    assert_eq!(requests.index_visits(), index_visits);
    assert_eq!(
        requests.request_clones(),
        clones,
        "a dead parent is not cloned"
    );
    assert_eq!(requests.full_scans(), 0);
    assert_eq!(requests.binding_len(), OWNERS - 1);
    assert!(requests.binding(&victim_owner).is_none());
    assert_eq!(requests.applied_len(), OWNERS - 1);
    assert!(labels_of(&mut world, victim).is_empty());

    let recycled = world.spawn(Transform::IDENTITY).id();
    let before = world.resource::<LabelRequests>().binding_visits();
    schedule.run(&mut world);
    world.flush();
    assert_eq!(world.resource::<LabelRequests>().binding_visits(), before);
    assert!(
        world
            .resource::<LabelRequests>()
            .applied_key(recycled)
            .is_none()
    );
    assert!(
        world
            .resource::<LabelRequests>()
            .applied_key(victim)
            .is_none()
    );
    assert!(labels_of(&mut world, recycled).is_empty());
    assert_eq!(world.resource::<LabelRequests>().binding_len(), OWNERS - 1);
}

#[test]
fn external_label_removal_rebinds_without_scanning_bindings() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("external".into());
    commit_one(&mut world, owner.clone(), parent, "back");
    sync(&mut world);
    let label = labels_of(&mut world, parent)[0];
    let visits = world.resource::<LabelRequests>().binding_visits();
    let clones = world.resource::<LabelRequests>().request_clones();

    world.despawn(label);
    world.flush();
    sync(&mut world);

    let restored = labels_of(&mut world, parent);
    assert_eq!(restored.len(), 1);
    assert_ne!(restored[0], label);
    assert_eq!(world.get::<Text2d>(restored[0]).unwrap().0, "back");
    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.binding_visits(), visits);
    assert_eq!(requests.full_scans(), 0);
    assert_eq!(
        requests.request_clones(),
        clones + 1,
        "repair clones via spec_at once"
    );
    assert_eq!(requests.binding(&owner), Some(parent));
    assert!(requests.applied_key(label).is_none());
    assert!(requests.applied_key(restored[0]).is_some());
}

#[test]
fn request_clone_counter_counts_spec_paths_and_ignores_existence_checks() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("clone".into());
    commit_one(&mut world, owner.clone(), parent, "once");
    assert_eq!(world.resource::<LabelRequests>().request_clones(), 0);

    sync(&mut world);
    assert_eq!(
        world.resource::<LabelRequests>().pending_len(),
        1,
        "Labels ack alone must not drop the key"
    );
    ack_geometry(&mut world);

    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.request_clones(), 2, "dirty view once, apply once");
    assert!(requests.component_writes() > 0);
    assert_eq!(requests.pending_len(), 0);
    let clones = requests.request_clones();
    let writes = requests.component_writes();
    let commits = requests.commits();

    commit_one(&mut world, owner.clone(), parent, "once");
    sync(&mut world);
    let requests = world.resource::<LabelRequests>();
    assert_eq!(
        requests.commits(),
        commits,
        "identical content is not a new commit"
    );
    assert_eq!(requests.pending_len(), 0);
    assert_eq!(requests.request_clones(), clones);
    assert_eq!(requests.component_writes(), writes);
    let label = labels_of(&mut world, parent)[0];
    assert_eq!(world.get::<Text2d>(label).unwrap().0, "once");

    {
        let mut requests = world.resource_mut::<LabelRequests>();
        assert!(requests.contains(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0));
        assert_eq!(requests.request_clones(), clones, "contains does not clone");
        assert_eq!(
            requests
                .spec_at(CanvasLabelRole::Card, &owner, 0)
                .unwrap()
                .text,
            "once"
        );
        assert_eq!(requests.request_clones(), clones + 1);
    }

    let clones = world.resource::<LabelRequests>().request_clones();
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.remove(CanvasLabelRole::Card, owner, 0);
        txn.commit().unwrap();
    }
    sync(&mut world);
    assert_eq!(
        world.resource::<LabelRequests>().request_clones(),
        clones,
        "tombstone does not clone a spec"
    );
    assert!(labels_of(&mut world, parent).is_empty());
}

#[test]
fn edge_producer_counts_retained_label_clones_and_identical_submit_does_not_dirty() {
    let mut requests = LabelRequests::default();
    let owner = LabelOwner::Block(16);
    let labels = vec![("edge".into(), Vec2::ZERO, 11.0, 0xABCDEF_u32)];
    super::super::edge_cache::submit_edge_labels_for_test(
        &mut requests,
        owner.clone(),
        &labels,
        2.1,
    );
    assert_eq!(
        requests.request_clones(),
        1,
        "the retained slice clone is counted"
    );
    assert_eq!(requests.commits(), 1);
    assert_eq!(requests.pending_len(), 1);

    super::super::edge_cache::submit_edge_labels_for_test(&mut requests, owner, &labels, 2.1);
    assert_eq!(
        requests.request_clones(),
        2,
        "a repeated slice clone is still a clone"
    );
    assert_eq!(
        requests.commits(),
        1,
        "identical edge content is not committed again"
    );
    assert_eq!(requests.pending_len(), 1);
}

fn card(id: &str, busy: bool) -> GraphNode {
    GraphNode {
        edit_scope: None,
        chrome: NodeChrome::Card,
        shared_world_instance: None,
        world_camera: None,
        history_strip: None,
        id: id.into(),
        kind: "image".into(),
        x: 0.0,
        y: 0.0,
        width: 200.0,
        height: 120.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        progress_started_at: None,
        busy,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        model: None,
    }
}

fn overlay_materials() -> super::super::CanvasMaterials {
    super::super::CanvasMaterials {
        solid: default(),
        blend: default(),
        font: default(),
    }
}

fn running_world(node: GraphNode) -> World {
    let mut world = world();
    let mut scene = world.resource::<CurrentScene>().0.clone();
    scene.nodes = vec![node.clone()];
    let mut index = NodeIndex::default();
    index.rebuild(&scene);
    world.spawn((
        CanvasNodeId(node.id),
        CanvasDepth {
            index: 0,
            render: 0,
            z: 10.0,
        },
        Transform::IDENTITY,
    ));
    world.insert_resource(CurrentScene(scene));
    world.insert_resource(index);
    world.insert_resource(Time::<()>::default());
    world.insert_resource(ThemeResource::default());
    world.insert_resource(overlay_materials());
    world.insert_resource(super::super::generation::GenerationClock::default());
    world.insert_resource(Assets::<Mesh>::default());
    world
}

fn run_running(world: &mut World) {
    let mut schedule = Schedule::default();
    schedule.add_systems(
        (
            super::super::generation::sync_generation,
            sync_canvas_labels,
        )
            .chain(),
    );
    schedule.run(world);
    world.flush();
    schedule.run(world);
    world.flush();
}

#[test]
fn idle_running_does_not_submit_an_empty_role_replace() {
    let mut world = running_world(card("idle", false));
    run_running(&mut world);
    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.commits(), 0);
    assert_eq!(requests.request_clones(), 0);
    assert_eq!(requests.component_writes(), 0);
    assert_eq!(requests.pending_len(), 0);
    assert!(!requests.writer_role_occupied(LabelWriter::Running, CanvasLabelRole::Running));
}

#[test]
fn running_static_frame_keeps_percent_without_cloning_or_writing() {
    let mut world = running_world(card("busy", true));
    let mut schedule = Schedule::default();
    schedule.add_systems(
        (
            super::super::generation::sync_generation,
            sync_canvas_labels,
        )
            .chain(),
    );
    schedule.run(&mut world);
    world.flush();
    let texts: Vec<_> = world
        .query::<&Text2d>()
        .iter(&world)
        .map(|text| text.0.clone())
        .collect();
    assert_eq!(texts, vec!["1%".to_owned()]);
    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.request_clones(), 2);
    assert!(requests.component_writes() > 0);
    assert_eq!(requests.pending_len(), 1);
    ack_geometry(&mut world);
    assert_eq!(world.resource::<LabelRequests>().pending_len(), 0);
    let clones = world.resource::<LabelRequests>().request_clones();
    let writes = world.resource::<LabelRequests>().component_writes();
    let commits = world.resource::<LabelRequests>().commits();

    schedule.run(&mut world);
    world.flush();

    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.request_clones(), clones);
    assert_eq!(requests.component_writes(), writes);
    assert_eq!(requests.commits(), commits);
    assert_eq!(requests.pending_len(), 0);
    let texts: Vec<_> = world
        .query::<&Text2d>()
        .iter(&world)
        .map(|text| text.0.clone())
        .collect();
    assert_eq!(texts, vec!["1%".to_owned()]);
}

/// Value summary of the accepted scene, written before the bars run (as `app` does).
fn refresh_stamp(world: &mut World) {
    world
        .run_system_once(super::super::overlay_stamp::refresh)
        .unwrap();
}

fn action_world(with_bar: bool) -> World {
    let node = card("a", false);
    let mut world = world();
    let scene = crate::protocol::Scene {
        nodes: vec![node.clone()],
        viewport: crate::protocol::Viewport {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        },
        ..Default::default()
    };
    let mut index = NodeIndex::default();
    index.rebuild(&scene);
    let actions = NodeActions {
        actions: vec![
            NodeAction {
                id: "download".into(),
                label: "下载".into(),
                enabled: true,
                menu: false,
                ..Default::default()
            },
            NodeAction {
                id: "convert".into(),
                label: "转为片场".into(),
                enabled: true,
                menu: true,
                ..Default::default()
            },
        ],
        summary: Some("gpt-5".into()),
    };
    let mut bar = None;
    if with_bar {
        bar = Some((node.id.clone(), actions));
        world.spawn((
            CanvasNodeId(node.id.clone()),
            CanvasLayout::from_node(&node),
            CanvasDepth {
                index: 0,
                render: 0,
                z: 10.0,
            },
            NodeActionBar {
                actions: NodeActions {
                    actions: Vec::new(),
                    summary: None,
                },
                summary: None,
            },
            Transform::IDENTITY,
        ));
    }
    world.insert_resource(CurrentScene(scene));
    world.insert_resource(index);
    world.insert_resource(ThemeResource::default());
    world.insert_resource(overlay_materials());
    world.insert_resource(Assets::<Mesh>::default());
    world.init_resource::<super::super::OverlayStamp>();
    // The bar node carries its actions; the scene carries the same declaration so the stamp sees
    // the inputs the producer derives from, as the real accepted frame does.
    world.insert_resource(crate::app::SurfaceState::with_size(Vec2::new(800.0, 600.0)));
    if let Some((id, actions)) = bar {
        world
            .resource_mut::<CurrentScene>()
            .0
            .node_actions
            .insert(id, actions);
    }
    refresh_stamp(&mut world);
    world
}

fn run_actions(world: &mut World) {
    let mut schedule = Schedule::default();
    schedule.add_systems(
        (
            super::super::overlay_stamp::refresh,
            super::super::node_action::sync_node_action_bars,
            sync_canvas_labels,
        )
            .chain(),
    );
    schedule.run(world);
    world.flush();
}

#[test]
fn idle_node_action_does_not_submit_an_empty_role_replace() {
    let mut world = action_world(false);
    run_actions(&mut world);
    run_actions(&mut world);
    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.commits(), 0);
    assert_eq!(requests.request_clones(), 0);
    assert_eq!(requests.component_writes(), 0);
    assert_eq!(requests.pending_len(), 0);
    assert!(!requests.writer_role_occupied(LabelWriter::NodeAction, CanvasLabelRole::NodeAction));
}

#[test]
fn node_action_static_frame_does_not_clone_or_write() {
    let mut world = action_world(true);
    let mut schedule = Schedule::default();
    schedule.add_systems(
        (
            super::super::overlay_stamp::refresh,
            super::super::node_action::sync_node_action_bars,
            sync_canvas_labels,
        )
            .chain(),
    );
    schedule.run(&mut world);
    world.flush();
    let labels: Vec<_> = world
        .query::<(&CanvasLabel, &Text2d)>()
        .iter(&world)
        .filter(|(label, _)| label.role == CanvasLabelRole::NodeAction)
        .map(|(_, text)| text.0.clone())
        .collect();
    assert_eq!(labels.len(), 3);
    let requests = world.resource::<LabelRequests>();
    assert_eq!(
        requests.request_clones(),
        6,
        "three new labels, two spec clones each"
    );
    assert!(requests.component_writes() > 0);
    assert_eq!(requests.pending_len(), 3);
    ack_geometry(&mut world);
    assert_eq!(world.resource::<LabelRequests>().pending_len(), 0);
    let clones = world.resource::<LabelRequests>().request_clones();
    let writes = world.resource::<LabelRequests>().component_writes();
    let commits = world.resource::<LabelRequests>().commits();

    schedule.run(&mut world);
    world.flush();

    let requests = world.resource::<LabelRequests>();
    assert_eq!(requests.request_clones(), clones);
    assert_eq!(requests.component_writes(), writes);
    assert_eq!(requests.commits(), commits);
    assert_eq!(requests.pending_len(), 0);
}

/// The camera snapshot rewrites `CurrentScene` every frame, which used to reseed the node-action
/// overlay (full node scan + label resubmission) on a still canvas. With the value stamp the
/// still frame must not scan the bar nodes at all.
#[test]
fn node_action_still_frame_skips_the_full_rescan_even_when_scene_is_touched() {
    let mut world = action_world(true);
    let mut schedule = Schedule::default();
    schedule.add_systems(
        (
            super::super::overlay_stamp::refresh,
            super::super::node_action::sync_node_action_bars,
            sync_canvas_labels,
        )
            .chain(),
    );
    schedule.run(&mut world);
    world.flush();
    ack_geometry(&mut world);
    let commits = world.resource::<LabelRequests>().commits();

    // Same values, fresh resource touch: what the camera snapshot does every frame.
    world.resource_mut::<CurrentScene>().0.viewport = crate::protocol::Viewport {
        x: 0.0,
        y: 0.0,
        zoom: 1.0,
    };
    schedule.run(&mut world);
    world.flush();

    let requests = world.resource::<LabelRequests>();
    assert_eq!(
        requests.commits(),
        commits,
        "still frame must not resubmit bars"
    );
    let layer_meshes = world.query::<&Mesh2d>().iter(&world).len();
    assert_eq!(layer_meshes, 1, "the bar layer keeps its single mesh");

    // A real value change (node moved) must refresh the overlay again.
    let moved = {
        let scene = &mut world.resource_mut::<CurrentScene>().0;
        scene.nodes[0].y += 40.0;
        scene.node_actions.get("a").cloned()
    };
    assert!(moved.is_some());
    schedule.run(&mut world);
    world.flush();
    assert!(world.resource::<LabelRequests>().commits() > commits);
}

/// Two bars far apart: moving one node must redraw only that bar, keep the untouched bar's
/// vertices exactly where they were, and drop the moved bar's old geometry.
#[test]
fn node_action_partial_redraw_leaves_untouched_bars_alone() {
    let mut left = card("a", false);
    left.x = 0.0;
    let mut right = card("b", false);
    right.x = 2000.0;
    let mut world = world();
    for (node, index) in [(&left, 0usize), (&right, 1usize)] {
        world.spawn((
            CanvasNodeId(node.id.clone()),
            CanvasLayout::from_node(node),
            CanvasDepth {
                index,
                render: index,
                z: 10.0 + index as f32 * 0.1,
            },
            NodeActionBar {
                actions: NodeActions {
                    actions: Vec::new(),
                    summary: None,
                },
                summary: None,
            },
            Transform::IDENTITY,
        ));
    }
    let actions = NodeActions {
        actions: vec![NodeAction {
            id: "download".into(),
            label: "下载".into(),
            enabled: true,
            ..Default::default()
        }],
        summary: None,
    };
    let mut scene = crate::protocol::Scene {
        nodes: vec![left.clone(), right.clone()],
        viewport: crate::protocol::Viewport {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        },
        ..Default::default()
    };
    scene.node_actions.insert("a".into(), actions.clone());
    scene.node_actions.insert("b".into(), actions);
    world.insert_resource(CurrentScene(scene));
    let mut index = NodeIndex::default();
    index.rebuild(&world.resource::<CurrentScene>().0);
    world.insert_resource(index);
    world.insert_resource(ThemeResource::default());
    world.insert_resource(overlay_materials());
    world.insert_resource(Assets::<Mesh>::default());
    world.init_resource::<super::super::OverlayStamp>();
    world.insert_resource(crate::app::SurfaceState::with_size(Vec2::new(
        4000.0, 1200.0,
    )));
    refresh_stamp(&mut world);

    let mut schedule = Schedule::default();
    schedule.add_systems(
        (
            super::super::overlay_stamp::refresh,
            super::super::node_action::sync_node_action_bars,
            sync_canvas_labels,
        )
            .chain(),
    );
    schedule.run(&mut world);
    world.flush();

    let bar_vertices = |world: &mut World| -> Vec<(f32, f32)> {
        let handle = world
            .query::<&Mesh2d>()
            .iter(world)
            .next()
            .map(|mesh| mesh.0.clone());
        let Some(handle) = handle else {
            return Vec::new();
        };
        world
            .resource::<Assets<Mesh>>()
            .get(&handle)
            .and_then(|mesh| {
                mesh.attribute(Mesh::ATTRIBUTE_POSITION)
                    .and_then(|v| v.as_float3())
            })
            .map(|values| values.iter().map(|p| (p[0], p[1])).collect())
            .unwrap_or_default()
    };
    let before = bar_vertices(&mut world);
    assert!(!before.is_empty(), "bars must draw a layer mesh");
    // 左横条整体落在 0..1000 世界单位内；右横条从 2000 起算。
    let left_vertices: Vec<(f32, f32)> = before
        .iter()
        .copied()
        .filter(|(x, _)| *x < 1500.0)
        .collect();
    let right_vertices: Vec<(f32, f32)> = before
        .iter()
        .copied()
        .filter(|(x, _)| *x >= 1500.0)
        .collect();
    assert_eq!(left_vertices.len(), right_vertices.len());
    assert!(!left_vertices.is_empty(), "two separate bars");

    // Move only the right bar 400 world units to the right.
    world.resource_mut::<CurrentScene>().0.nodes[1].x += 400.0;
    let scene = world.resource::<CurrentScene>().0.clone();
    world.resource_mut::<NodeIndex>().rebuild(&scene);
    refresh_stamp(&mut world);
    schedule.run(&mut world);
    world.flush();

    // The producer confirms the incremental path: one bar repainted, not a layer rebuild.
    assert_eq!(
        crate::canvas2d::bar_paint::last(),
        (1, false),
        "only the moved bar is repainted and the layer is spliced, not rebuilt"
    );

    let after = bar_vertices(&mut world);
    for vertex in &left_vertices {
        assert!(
            after.iter().any(|candidate| {
                (candidate.0 - vertex.0).abs() < 0.001 && (candidate.1 - vertex.1).abs() < 0.001
            }),
            "the untouched bar keeps vertex {vertex:?}"
        );
    }
    assert!(
        !after.iter().any(|(x, _)| (*x - 2068.0).abs() < 0.001),
        "the moved bar's old geometry is dropped"
    );
    assert!(
        after.iter().any(|(x, _)| (*x - 2468.0).abs() < 0.001),
        "the moved bar is drawn at its new position"
    );
}
