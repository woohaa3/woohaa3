//! 阶段 1：writer 隔离、脏键和实体代数。
use super::store::MAX_PENDING_DIRTY_KEYS;
use super::*;
use crate::app::CurrentScene;
use crate::canvas2d::text_presentation;
use crate::canvas_ecs::components::{CanvasLabel, CanvasLabelRole};
use bevy::ecs::system::RunSystemOnce;

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

fn spec(text: &str, color: u32) -> LabelSpec {
    LabelSpec::from_label(
        (text.into(), Vec2::ZERO, 12.0, color),
        5.0,
        LabelStyle::Node,
    )
}

fn labels_of(world: &mut World, owner: Entity) -> Vec<Entity> {
    let mut rows: Vec<_> = world
        .query::<(Entity, &CanvasLabel, &ChildOf)>()
        .iter(world)
        .filter(|(_, _, child)| child.parent() == owner)
        .map(|(entity, label, _)| (label.role, label.slot, entity))
        .collect();
    rows.sort_by_key(|(role, slot, _)| (*role as u8, *slot));
    rows.into_iter().map(|(_, _, entity)| entity).collect()
}

#[test]
fn same_role_keeps_distinct_writers_and_rejects_a_shared_slot() {
    let mut requests = LabelRequests::default();
    let owner = LabelOwner::Node("node".into());
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.upsert(
        CanvasLabelRole::Card,
        owner.clone(),
        0,
        spec("card", 0xFFFFFF),
    );
    txn.commit().unwrap();
    let mut txn = requests.transaction(LabelWriter::Running);
    txn.upsert(
        CanvasLabelRole::Card,
        owner.clone(),
        1,
        spec("other", 0xFFFFFF),
    );
    txn.commit().unwrap();
    let mut txn = requests.transaction(LabelWriter::Running);
    txn.upsert(
        CanvasLabelRole::Card,
        owner.clone(),
        0,
        spec("steal", 0xFFFFFF),
    );
    assert!(txn.commit().is_err());
    assert_eq!(
        requests.spec_text(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0),
        Some("card")
    );
    assert!(requests.contains(LabelWriter::Running, CanvasLabelRole::Card, &owner, 1));
}

#[test]
fn role_replace_keeps_other_writer_and_skipped_writer_stays() {
    let mut requests = LabelRequests::default();
    let owner = LabelOwner::Node("node".into());
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.upsert(
        CanvasLabelRole::Card,
        owner.clone(),
        0,
        spec("card", 0xFFFFFF),
    );
    txn.commit().unwrap();
    let mut txn = requests.transaction(LabelWriter::Running);
    txn.upsert(
        CanvasLabelRole::Card,
        owner.clone(),
        1,
        spec("running", 0xFFFFFF),
    );
    txn.upsert(
        CanvasLabelRole::Running,
        owner.clone(),
        0,
        spec("50%", 0xFFFFFF),
    );
    txn.commit().unwrap();

    let mut txn = requests.transaction(LabelWriter::Card);
    txn.replace_role(CanvasLabelRole::Card, Vec::new());
    txn.commit().unwrap();
    assert!(!requests.contains(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0));
    assert!(requests.contains(LabelWriter::Running, CanvasLabelRole::Card, &owner, 1));
    assert!(requests.contains(LabelWriter::Running, CanvasLabelRole::Running, &owner, 0));
}

#[test]
fn single_key_upsert_remove_and_empty_owner_do_not_touch_neighbors() {
    let mut requests = LabelRequests::default();
    let owner = LabelOwner::Node("node".into());
    let other = LabelOwner::Node("other".into());
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.upsert(CanvasLabelRole::Card, owner.clone(), 0, spec("a", 0xFFFFFF));
    txn.upsert(CanvasLabelRole::Card, owner.clone(), 1, spec("b", 0xFFFFFF));
    txn.upsert(CanvasLabelRole::Card, other.clone(), 0, spec("c", 0xFFFFFF));
    txn.commit().unwrap();

    let mut txn = requests.transaction(LabelWriter::Card);
    txn.remove(CanvasLabelRole::Card, owner.clone(), 1);
    txn.commit().unwrap();
    assert!(requests.tombstone(LabelWriter::Card, CanvasLabelRole::Card, &owner, 1));
    assert!(requests.contains(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0));

    let mut txn = requests.transaction(LabelWriter::Card);
    txn.replace_owner(
        CanvasLabelRole::Card,
        owner.clone(),
        Vec::new(),
        5.0,
        LabelStyle::Node,
    );
    txn.commit().unwrap();
    assert!(!requests.contains(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0));
    assert!(requests.contains(LabelWriter::Card, CanvasLabelRole::Card, &other, 0));
}

#[test]
fn failed_commit_and_overflow_keep_unacked_tombstones() {
    let mut requests = LabelRequests::default();
    let owner = LabelOwner::Node("kept".into());
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.upsert(
        CanvasLabelRole::Card,
        owner.clone(),
        0,
        spec("keep", 0xFFFFFF),
    );
    txn.commit().unwrap();
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.remove(CanvasLabelRole::Card, owner.clone(), 0);
    txn.commit().unwrap();
    assert!(requests.tombstone(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0));

    let mut txn = requests.transaction(LabelWriter::Running);
    txn.upsert(
        CanvasLabelRole::Card,
        owner.clone(),
        0,
        spec("conflict", 0xFFFFFF),
    );
    // 键已删除，占用已释放，这里改成占用另一个仍在的键。
    drop(txn);
    let live = LabelOwner::Node("live".into());
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.upsert(
        CanvasLabelRole::Card,
        live.clone(),
        0,
        spec("live", 0xFFFFFF),
    );
    txn.commit().unwrap();
    let before = requests.pending_len();
    let mut txn = requests.transaction(LabelWriter::Running);
    txn.upsert(
        CanvasLabelRole::Card,
        live.clone(),
        0,
        spec("nope", 0xFFFFFF),
    );
    assert!(txn.commit().is_err());
    assert_eq!(requests.pending_len(), before);
    assert!(requests.tombstone(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0));
    assert_eq!(
        requests.spec_text(LabelWriter::Card, CanvasLabelRole::Card, &live, 0),
        Some("live")
    );

    let mut txn = requests.transaction(LabelWriter::Edge);
    for index in 0..MAX_PENDING_DIRTY_KEYS {
        txn.upsert(
            CanvasLabelRole::Edge,
            LabelOwner::Block(index as u32),
            0,
            spec("edge", 0xFFFFFF),
        );
    }
    txn.commit().unwrap();
    let mut txn = requests.transaction(LabelWriter::Edge);
    txn.replace_role(CanvasLabelRole::Edge, Vec::new());
    txn.commit().unwrap();
    assert!(requests.barrier() || requests.pending_len() <= MAX_PENDING_DIRTY_KEYS);
    assert!(requests.tombstone(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0));
}

#[test]
fn position_and_theme_changes_write_only_the_changed_component() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("node".into());
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        requests.bind(owner.clone(), parent);
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.upsert(
            CanvasLabelRole::Card,
            owner.clone(),
            0,
            spec("title", 0x112233),
        );
        txn.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    let entity = labels_of(&mut world, parent)[0];
    assert!(matches!(
        world.get::<TextColor>(entity).unwrap().0,
        Color::LinearRgba(_)
    ));

    world.clear_trackers();
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        let mut txn = requests.transaction(LabelWriter::Card);
        let mut moved = spec("title", 0x112233);
        moved.position = Vec2::new(4.0, 8.0);
        txn.upsert(CanvasLabelRole::Card, owner.clone(), 0, moved);
        txn.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(
        world.get::<Transform>(entity).unwrap().translation,
        Vec3::new(4.0, -8.0, 5.0)
    );
    assert_eq!(
        world
            .query_filtered::<Entity, Changed<Text2d>>()
            .iter(&world)
            .count(),
        0
    );

    world.clear_trackers();
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.upsert(CanvasLabelRole::Card, owner, 0, spec("title", 0xEF6721));
        txn.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    let color = world.get::<TextColor>(entity).unwrap().0;
    assert_eq!(
        color.to_linear(),
        super::super::layout::hex(0xEF6721).to_linear()
    );
    assert!(matches!(color, Color::LinearRgba(_)));
}

#[test]
fn despawn_and_rebind_do_not_attach_labels_to_an_unrelated_entity() {
    let mut world = world();
    let first = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("stable".into());
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        requests.bind(owner.clone(), first);
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.replace_owner(
            CanvasLabelRole::Card,
            owner.clone(),
            vec![("a".into(), Vec2::ZERO, 12.0, 0xFFFFFF)],
            5.0,
            LabelStyle::Node,
        );
        txn.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(labels_of(&mut world, first).len(), 1);

    world.despawn(first);
    world.flush();
    let second = world.spawn(Transform::IDENTITY).id();
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert!(
        labels_of(&mut world, second).is_empty(),
        "未重绑时新实体不得命中旧键"
    );

    world.resource_mut::<LabelRequests>().bind(owner, second);
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(labels_of(&mut world, second).len(), 1);
    assert!(world.get_entity(first).is_err());
}

#[test]
fn same_entity_roles_stay_isolated_when_one_writer_is_skipped() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("node".into());
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        requests.bind(owner.clone(), parent);
        let mut card = requests.transaction(LabelWriter::Card);
        card.replace_owner(
            CanvasLabelRole::Card,
            owner.clone(),
            vec![("card".into(), Vec2::ZERO, 12.0, 0xFFFFFF)],
            5.0,
            LabelStyle::Node,
        );
        card.commit().unwrap();
        let mut running = requests.transaction(LabelWriter::Running);
        running.replace_owner(
            CanvasLabelRole::Running,
            owner,
            vec![("50%".into(), Vec2::ZERO, 13.0, 0xFFFFFF)],
            6.0,
            LabelStyle::Running,
        );
        running.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(labels_of(&mut world, parent).len(), 2);
    replace_only_card(&mut world);
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    let roles: Vec<_> = world
        .query::<(&CanvasLabel, &ChildOf)>()
        .iter(&world)
        .filter(|(_, child)| child.parent() == parent)
        .map(|(label, _)| label.role)
        .collect();
    assert_eq!(roles, vec![CanvasLabelRole::Running]);
}

fn replace_only_card(world: &mut World) {
    let mut requests = world.resource_mut::<LabelRequests>();
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.replace_role(CanvasLabelRole::Card, Vec::new());
    txn.commit().unwrap();
}

fn commit_upsert(
    requests: &mut LabelRequests,
    writer: LabelWriter,
    owner: &LabelOwner,
    text: &str,
) {
    let mut txn = requests.transaction(writer);
    txn.upsert(
        CanvasLabelRole::Card,
        owner.clone(),
        0,
        spec(text, 0xFFFFFF),
    );
    txn.commit().unwrap();
}

#[test]
fn slow_consumer_keeps_entries_the_fast_consumer_already_acked() {
    let mut requests = LabelRequests::default();
    let first = LabelOwner::Node("first".into());
    let second = LabelOwner::Node("second".into());
    commit_upsert(&mut requests, LabelWriter::Card, &first, "one");
    let mid = requests.label_work();
    commit_upsert(&mut requests, LabelWriter::Card, &second, "two");
    let later = requests.label_work();

    requests.ack(LabelConsumer::Labels, mid.through, mid.epoch);
    assert!(
        requests.pending_len() >= 1,
        "Geometry 还没 ack 时，Labels 不能把日志丢掉"
    );
    assert!(
        requests.tombstone(LabelWriter::Card, CanvasLabelRole::Card, &first, 0)
            || requests.contains(LabelWriter::Card, CanvasLabelRole::Card, &first, 0)
    );

    requests.ack(LabelConsumer::Geometry, mid.through, mid.epoch);
    let still = requests.label_work();
    assert!(
        still.dirty.iter().any(|item| item.owner == second),
        "只 ack 到旧水位时，后写入的键必须还在"
    );
    requests.ack(LabelConsumer::Labels, later.through, later.epoch);
    requests.ack(LabelConsumer::Geometry, later.through, later.epoch);
    assert_eq!(requests.pending_len(), 0);
}

#[test]
fn stale_ack_does_not_clear_a_newer_version_of_the_same_key() {
    let mut requests = LabelRequests::default();
    let owner = LabelOwner::Node("node".into());
    commit_upsert(&mut requests, LabelWriter::Card, &owner, "old");
    let stale = requests.label_work();
    commit_upsert(&mut requests, LabelWriter::Card, &owner, "new");

    requests.ack(LabelConsumer::Labels, stale.through, stale.epoch);
    requests.ack(LabelConsumer::Geometry, stale.through, stale.epoch);

    let fresh = requests.label_work();
    assert!(
        fresh.dirty.iter().any(|item| {
            item.owner == owner && item.spec.as_ref().is_some_and(|spec| spec.text == "new")
        }),
        "旧水位 ack 不能把同键的新版本清掉"
    );
    assert_eq!(
        requests.spec_text(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0),
        Some("new")
    );
    requests.ack(LabelConsumer::Labels, fresh.through, fresh.epoch);
    requests.ack(LabelConsumer::Geometry, fresh.through, fresh.epoch);
    assert_eq!(requests.pending_len(), 0);
}

#[test]
fn replace_and_bind_do_not_scan_the_committed_table() {
    let mut requests = LabelRequests::default();
    let mut txn = requests.transaction(LabelWriter::Card);
    for index in 0..3000 {
        txn.upsert(
            CanvasLabelRole::Card,
            LabelOwner::Node(format!("n{index}")),
            0,
            spec("title", 0xFFFFFF),
        );
    }
    txn.commit().unwrap();
    let mut edges = requests.transaction(LabelWriter::Edge);
    for index in 0..3000 {
        edges.upsert(
            CanvasLabelRole::Edge,
            LabelOwner::Block(index),
            0,
            spec("edge", 0xFFFFFF),
        );
    }
    edges.commit().unwrap();

    let before = requests.index_visits();
    assert_eq!(requests.full_scans(), 0);
    let owner = LabelOwner::Node("n10".into());
    let mut txn = requests.transaction(LabelWriter::Card);
    txn.replace_owner(
        CanvasLabelRole::Card,
        owner.clone(),
        vec![("changed".into(), Vec2::ZERO, 12.0, 0xFFFFFF)],
        5.0,
        LabelStyle::Node,
    );
    txn.commit().unwrap();
    requests.bind(owner, Entity::from_bits(1));
    let visited = requests.index_visits() - before;
    assert_eq!(requests.full_scans(), 0);
    assert!(
        visited <= 4,
        "3000 owner 里替换并重绑一个，槽位索引访问应是 O(1)，实际 {visited}"
    );
}

#[test]
fn overflow_tombstone_is_consumed_and_the_entity_is_recycled() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("gone".into());
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        requests.bind(owner.clone(), parent);
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.upsert(
            CanvasLabelRole::Card,
            owner.clone(),
            0,
            spec("gone", 0xFFFFFF),
        );
        txn.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    let label = labels_of(&mut world, parent)[0];
    assert_eq!(world.resource::<LabelRequests>().applied_len(), 1);

    {
        let mut requests = world.resource_mut::<LabelRequests>();
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.remove(CanvasLabelRole::Card, owner.clone(), 0);
        txn.commit().unwrap();
        assert!(requests.tombstone(LabelWriter::Card, CanvasLabelRole::Card, &owner, 0));
        let mut txn = requests.transaction(LabelWriter::Edge);
        for index in 0..MAX_PENDING_DIRTY_KEYS {
            txn.upsert(
                CanvasLabelRole::Edge,
                LabelOwner::Block(index as u32),
                0,
                spec("fill", 0xFFFFFF),
            );
        }
        txn.upsert(
            CanvasLabelRole::Edge,
            LabelOwner::Block(MAX_PENDING_DIRTY_KEYS as u32),
            0,
            spec("overflow", 0xFFFFFF),
        );
        txn.commit().unwrap();
        assert!(
            requests.barrier(),
            "超出上限必须进入 full-resync，而不是丢掉 tombstone"
        );
    }

    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert!(
        world.get_entity(label).is_err(),
        "tombstone 必须被消费并拆掉实体"
    );
    assert_eq!(world.resource::<LabelRequests>().applied_len(), 0);
    assert_eq!(world.resource::<LabelRequests>().entity_index_len(), 0);
    assert_eq!(world.resource::<LabelRequests>().binding_len(), 0);

    let recycled = world.spawn(Transform::IDENTITY).id();
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert!(labels_of(&mut world, recycled).is_empty());
    assert!(world
        .resource::<LabelRequests>()
        .applied_key(recycled)
        .is_none());
    let epoch = world.resource::<LabelRequests>().queue_epoch();
    world
        .resource_mut::<LabelRequests>()
        .ack(LabelConsumer::Geometry, u64::MAX, epoch);
    assert!(
        !world.resource::<LabelRequests>().barrier(),
        "两边都 ack 之后 barrier 才能丢"
    );
}

#[test]
fn deleting_an_owner_clears_binding_and_applied_indexes() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("node".into());
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        requests.bind(owner.clone(), parent);
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.replace_owner(
            CanvasLabelRole::Card,
            owner.clone(),
            vec![("a".into(), Vec2::ZERO, 12.0, 0xFFFFFF)],
            5.0,
            LabelStyle::Node,
        );
        txn.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(world.resource::<LabelRequests>().binding_len(), 1);
    assert_eq!(world.resource::<LabelRequests>().applied_len(), 1);

    {
        let mut requests = world.resource_mut::<LabelRequests>();
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.replace_owner(
            CanvasLabelRole::Card,
            owner,
            Vec::new(),
            0.0,
            LabelStyle::Node,
        );
        txn.commit().unwrap();
        assert_eq!(requests.binding_len(), 0, "没有 live 键时绑定必须摘掉");
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(world.resource::<LabelRequests>().applied_len(), 0);
    assert_eq!(world.resource::<LabelRequests>().entity_index_len(), 0);
    assert!(labels_of(&mut world, parent).is_empty());
}

#[test]
fn despawned_parent_does_not_leave_an_index_for_a_recycled_entity() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("stable".into());
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        requests.bind(owner.clone(), parent);
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.upsert(CanvasLabelRole::Card, owner, 0, spec("keep", 0xFFFFFF));
        txn.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    world.despawn(parent);
    world.flush();
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(world.resource::<LabelRequests>().binding_len(), 0);
    assert_eq!(world.resource::<LabelRequests>().applied_len(), 0);
    assert_eq!(world.resource::<LabelRequests>().entity_index_len(), 0);

    let recycled = world.spawn(Transform::IDENTITY).id();
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert!(labels_of(&mut world, recycled).is_empty());
    assert!(world
        .resource::<LabelRequests>()
        .applied_key(recycled)
        .is_none());
    assert!(world
        .resource::<LabelRequests>()
        .applied_key(parent)
        .is_none());
}

#[test]
fn epoch_change_drops_the_queue_and_rejects_a_stale_ack() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("node".into());
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        requests.observe_canvas("canvas-a");
        requests.bind(owner.clone(), parent);
        commit_upsert(&mut requests, LabelWriter::Card, &owner, "old");
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    let issued = world.resource::<LabelRequests>().queue_epoch();
    assert!(world.resource::<LabelRequests>().applied_len() > 0);

    world
        .resource_mut::<LabelRequests>()
        .observe_canvas("canvas-b");
    assert_eq!(world.resource::<LabelRequests>().pending_len(), 0);
    assert_eq!(world.resource::<LabelRequests>().binding_len(), 0);
    assert_eq!(world.resource::<LabelRequests>().applied_len(), 0);
    assert_eq!(world.resource::<LabelRequests>().entity_index_len(), 0);
    assert!(!world.resource::<LabelRequests>().contains(
        LabelWriter::Card,
        CanvasLabelRole::Card,
        &owner,
        0
    ));

    {
        let mut requests = world.resource_mut::<LabelRequests>();
        commit_upsert(&mut requests, LabelWriter::Card, &owner, "fresh");
        let fresh = requests.label_work();
        requests.ack(LabelConsumer::Labels, u64::MAX, issued);
        requests.ack(LabelConsumer::Geometry, u64::MAX, issued);
        assert!(
            requests
                .label_work()
                .dirty
                .iter()
                .any(|item| item.owner == owner),
            "旧 epoch 的 ack 不能清掉新队列"
        );
        assert_ne!(fresh.epoch, issued);
    }
}

#[test]
fn same_frame_running_attach_and_node_action_commits_are_applied() {
    let mut world = world();
    let parent = world.spawn(Transform::IDENTITY).id();
    let owner = LabelOwner::Node("node".into());
    {
        let mut requests = world.resource_mut::<LabelRequests>();
        requests.bind(owner.clone(), parent);
        let mut running = requests.transaction(LabelWriter::Running);
        running.upsert(
            CanvasLabelRole::Running,
            owner.clone(),
            0,
            LabelSpec::from_label(
                ("50%".into(), Vec2::ZERO, 13.0, 0xFFFFFF),
                6.0,
                LabelStyle::Running,
            ),
        );
        running.commit().unwrap();
        let mut attach = requests.transaction(LabelWriter::Attach);
        attach.upsert(
            CanvasLabelRole::Attach,
            owner.clone(),
            0,
            LabelSpec::from_label(
                ("link".into(), Vec2::ZERO, 12.0, 0xFFFFFF),
                7.0,
                LabelStyle::Attach,
            ),
        );
        attach.commit().unwrap();
        let mut action = requests.transaction(LabelWriter::NodeAction);
        action.upsert(
            CanvasLabelRole::NodeAction,
            owner,
            0,
            LabelSpec::from_label(
                ("add".into(), Vec2::ZERO, 12.0, 0xFFFFFF),
                8.0,
                LabelStyle::NodeAction,
            ),
        );
        action.commit().unwrap();
    }
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    let roles: Vec<_> = world
        .query::<(&CanvasLabel, &ChildOf)>()
        .iter(&world)
        .filter(|(_, child)| child.parent() == parent)
        .map(|(label, _)| label.role)
        .collect();
    assert!(roles.contains(&CanvasLabelRole::Running));
    assert!(roles.contains(&CanvasLabelRole::Attach));
    assert!(roles.contains(&CanvasLabelRole::NodeAction));
}
