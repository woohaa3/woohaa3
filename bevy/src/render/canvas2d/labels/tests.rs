//! 标签 owner/role/slot 生命周期回归
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，任务 4.1）。
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

fn owner(world: &mut World) -> Entity {
    world.spawn(Transform::IDENTITY).id()
}

fn owner_key(entity: Entity) -> LabelOwner {
    LabelOwner::Node(format!("{:x}", entity.to_bits()))
}

fn writer_for(role: CanvasLabelRole) -> LabelWriter {
    match role {
        CanvasLabelRole::Card | CanvasLabelRole::Container => LabelWriter::Card,
        CanvasLabelRole::Edge => LabelWriter::Edge,
        CanvasLabelRole::Attach => LabelWriter::Attach,
        CanvasLabelRole::Running => LabelWriter::Running,
        CanvasLabelRole::NodeAction => LabelWriter::NodeAction,
    }
}

fn stage(
    world: &mut World,
    role: CanvasLabelRole,
    entity: Entity,
    labels: Vec<Label>,
    z: f32,
    style: LabelStyle,
) {
    let owner = owner_key(entity);
    let mut requests = world.resource_mut::<LabelRequests>();
    requests.bind(owner.clone(), entity);
    let mut txn = requests.transaction(writer_for(role));
    txn.replace_owner(role, owner, labels, z, style);
    txn.commit().unwrap();
}

fn replace_role_empty(world: &mut World, writer: LabelWriter, role: CanvasLabelRole) {
    let mut requests = world.resource_mut::<LabelRequests>();
    let mut txn = requests.transaction(writer);
    txn.replace_role(role, Vec::new());
    txn.commit().unwrap();
}

fn push(world: &mut World, owner: Entity, labels: Vec<Label>) {
    stage(
        world,
        CanvasLabelRole::Card,
        owner,
        labels,
        5.0,
        LabelStyle::Node,
    );
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
}

fn labels_of_role(world: &mut World, owner: Entity, role: CanvasLabelRole) -> Vec<Entity> {
    let mut rows: Vec<_> = world
        .query::<(Entity, &CanvasLabel, &ChildOf)>()
        .iter(world)
        .filter(|(_, label, child)| child.parent() == owner && label.role == role)
        .map(|(entity, label, _)| (label.slot, entity))
        .collect();
    rows.sort_by_key(|(slot, _)| *slot);
    rows.into_iter().map(|(_, entity)| entity).collect()
}

fn labels_of(world: &mut World, owner: Entity) -> Vec<Entity> {
    let mut rows: Vec<_> = world
        .query::<(Entity, &CanvasLabel, &ChildOf)>()
        .iter(world)
        .filter(|(_, _, child)| child.parent() == owner)
        .map(|(entity, label, _)| (label.slot, entity))
        .collect();
    rows.sort_by_key(|(slot, _)| *slot);
    rows.into_iter().map(|(_, entity)| entity).collect()
}

fn glyph(world: &World, entity: Entity) -> (f32, f32) {
    let font = world.get::<TextFont>(entity).unwrap().font_size;
    let size = match font {
        FontSize::Px(size) => size,
        other => panic!("unexpected font size {other:?}"),
    };
    (size, world.get::<Transform>(entity).unwrap().scale.x)
}

#[test]
fn reused_label_keeps_logical_font_size_and_lets_strategy_rasterize() {
    let mut world = world();
    let node = owner(&mut world);
    push(
        &mut world,
        node,
        vec![("标题".to_owned(), Vec2::new(10.0, 20.0), 12.0, 0xFFFFFF)],
    );
    let entity = labels_of(&mut world, node)[0];
    world.run_system_once(text_presentation::sync).unwrap();
    let (font, scale) = glyph(&world, entity);
    assert!((font * scale - 12.0).abs() <= 1.0e-3, "100% 档显示逻辑字号");

    push(
        &mut world,
        node,
        vec![("新标题".to_owned(), Vec2::new(10.0, 20.0), 16.0, 0xFFFFFF)],
    );
    assert_eq!(world.get::<LogicalText>(entity).unwrap().size, 16.0);
    assert_eq!(world.get::<Text2d>(entity).unwrap().0, "新标题");
    world.run_system_once(text_presentation::sync).unwrap();
    let (font, scale) = glyph(&world, entity);
    assert!((font * scale - 16.0).abs() <= 1.0e-3, "按新逻辑字号显示");

    for _ in 0..3 {
        push(
            &mut world,
            node,
            vec![("新标题".to_owned(), Vec2::new(10.0, 20.0), 16.0, 0xFFFFFF)],
        );
        world.run_system_once(text_presentation::sync).unwrap();
    }
    let after = glyph(&world, entity);
    assert!((after.1 - scale).abs() <= 1.0e-6);
    assert_eq!(after.0, font);
}

#[test]
fn hide_then_show_rebuilds_and_selects_current_step() {
    let mut world = world();
    let node = owner(&mut world);
    push(
        &mut world,
        node,
        vec![("标题".to_owned(), Vec2::ZERO, 12.0, 0xFFFFFF)],
    );
    let first = labels_of(&mut world, node)[0];
    push(&mut world, node, Vec::new());
    assert!(world.get_entity(first).is_err(), "隐藏必须回收实体");

    world.resource_mut::<CurrentScene>().0.viewport.zoom = 8.0;
    world.resource_mut::<crate::app::SurfaceState>().pixel_ratio = 2.0;
    push(
        &mut world,
        node,
        vec![("标题".to_owned(), Vec2::ZERO, 12.0, 0xFFFFFF)],
    );
    let second = labels_of(&mut world, node)[0];
    assert_ne!(second, first, "隐藏后必须新建实体");
    world.run_system_once(text_presentation::sync).unwrap();
    let (font, scale) = glyph(&world, second);
    assert!((font - 96.0).abs() <= 1.0e-3);
    assert!((font * scale - 12.0).abs() <= 1.0e-3);
}

#[test]
fn step_changes_keep_text_content_and_logical_layout() {
    let mut world = world();
    let node = owner(&mut world);
    let long =
        "这是一段会被业务逻辑截断的较长中文标题，用来验证栅格档位不影响文案与分行".to_owned();
    push(
        &mut world,
        node,
        vec![(long.clone(), Vec2::new(24.0, 56.0), 12.0, 0xFFFFFF)],
    );
    let entity = labels_of(&mut world, node)[0];
    world.run_system_once(text_presentation::sync).unwrap();
    let baseline_text = world.get::<Text2d>(entity).unwrap().0.clone();
    let baseline_translation = world.get::<Transform>(entity).unwrap().translation;
    for zoom in [2.0, 4.0, 8.0, 12.0, 4.0, 1.0] {
        world.resource_mut::<CurrentScene>().0.viewport.zoom = zoom;
        world.run_system_once(text_presentation::sync).unwrap();
        assert_eq!(
            world.get::<Text2d>(entity).unwrap().0,
            baseline_text,
            "zoom={zoom} 文案必须不变"
        );
        assert_eq!(
            world.get::<Transform>(entity).unwrap().translation,
            baseline_translation
        );
        let (font, scale) = glyph(&world, entity);
        assert!(
            (font * scale - 12.0).abs() <= 1.0e-3,
            "zoom={zoom} 逻辑字号必须不变"
        );
        let bounds = world.get::<TextBounds>(entity).unwrap();
        let width = bounds.width.expect("标签有界");
        assert!((width * scale - LABEL_BOUNDS.x).abs() <= 1.0e-3);
    }
}

#[test]
fn label_index_isolates_owner_role_and_restores_empty_request() {
    let mut world = world();
    let a = owner(&mut world);
    let b = owner(&mut world);
    let card = |text: &str| (text.to_owned(), Vec2::ZERO, 12.0, 0xFFFFFFu32);
    stage(
        &mut world,
        CanvasLabelRole::Card,
        a,
        vec![card("a0"), card("a1"), card("a2")],
        5.0,
        LabelStyle::Node,
    );
    stage(
        &mut world,
        CanvasLabelRole::Running,
        a,
        vec![("run".into(), Vec2::ZERO, 13.0, 0xFFFFFF)],
        6.0,
        LabelStyle::Running,
    );
    stage(
        &mut world,
        CanvasLabelRole::Card,
        b,
        vec![card("b0"), card("b1")],
        5.0,
        LabelStyle::Node,
    );
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();

    let a_cards = labels_of_role(&mut world, a, CanvasLabelRole::Card);
    let a_running = labels_of_role(&mut world, a, CanvasLabelRole::Running);
    let b_cards = labels_of_role(&mut world, b, CanvasLabelRole::Card);
    assert_eq!(a_cards.len(), 3);
    assert_eq!(a_running.len(), 1);
    assert_eq!(b_cards.len(), 2);

    stage(
        &mut world,
        CanvasLabelRole::Card,
        a,
        vec![card("a0")],
        5.0,
        LabelStyle::Node,
    );
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(
        labels_of_role(&mut world, a, CanvasLabelRole::Card),
        vec![a_cards[0]]
    );
    assert!(world.get_entity(a_cards[1]).is_err());
    assert!(world.get_entity(a_cards[2]).is_err());
    assert_eq!(
        labels_of_role(&mut world, a, CanvasLabelRole::Running),
        a_running
    );
    assert_eq!(
        labels_of_role(&mut world, b, CanvasLabelRole::Card),
        b_cards
    );

    stage(
        &mut world,
        CanvasLabelRole::Card,
        a,
        Vec::new(),
        5.0,
        LabelStyle::Node,
    );
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert!(labels_of_role(&mut world, a, CanvasLabelRole::Card).is_empty());
    assert!(world.get_entity(a_cards[0]).is_err());
    assert_eq!(
        labels_of_role(&mut world, a, CanvasLabelRole::Running),
        a_running
    );
    assert_eq!(
        labels_of_role(&mut world, b, CanvasLabelRole::Card),
        b_cards
    );

    stage(
        &mut world,
        CanvasLabelRole::Card,
        a,
        vec![card("a0-again")],
        5.0,
        LabelStyle::Node,
    );
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    let restored = labels_of_role(&mut world, a, CanvasLabelRole::Card);
    assert_eq!(restored.len(), 1);
    assert_ne!(restored[0], a_cards[0]);
    assert_eq!(world.get::<Text2d>(restored[0]).unwrap().0, "a0-again");
    assert_eq!(
        labels_of_role(&mut world, a, CanvasLabelRole::Running),
        a_running
    );
    assert_eq!(
        labels_of_role(&mut world, b, CanvasLabelRole::Card),
        b_cards
    );
}

#[test]
fn pool_shrink_and_grow_reclaim_entities() {
    let mut world = world();
    let node = owner(&mut world);
    let rows = |count: usize| -> Vec<Label> {
        (0..count)
            .map(|index| (format!("行{index}"), Vec2::ZERO, 12.0, 0xFFFFFF))
            .collect()
    };
    push(&mut world, node, rows(3));
    let three = labels_of(&mut world, node);
    assert_eq!(three.len(), 3);
    push(&mut world, node, rows(1));
    assert_eq!(labels_of(&mut world, node), vec![three[0]]);
    assert!(world.get_entity(three[1]).is_err());
    assert!(world.get_entity(three[2]).is_err());
    push(&mut world, node, rows(2));
    let two = labels_of(&mut world, node);
    assert_eq!(two.len(), 2);
    assert_eq!(two[0], three[0], "复用重叠部分");
    assert_ne!(two[1], three[1], "被回收的槽位必须补建新实体");
}

#[test]
fn deleting_owner_reclaims_labels_and_roles_are_independent() {
    let mut world = world();
    let node = owner(&mut world);
    push(
        &mut world,
        node,
        vec![("卡片".to_owned(), Vec2::ZERO, 12.0, 0xFFFFFF)],
    );
    stage(
        &mut world,
        CanvasLabelRole::Running,
        node,
        vec![("50%".to_owned(), Vec2::ZERO, 13.0, 0xFFFFFF)],
        6.0,
        LabelStyle::Running,
    );
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    assert_eq!(labels_of(&mut world, node).len(), 2, "不同角色各自独立");
    world.despawn(node);
    world.flush();
    assert!(world.query::<&CanvasLabel>().iter(&world).next().is_none());
}

#[test]
fn unchanged_requests_keep_labels_without_marking_text_components_changed() {
    let mut world = world();
    let mut schedule = Schedule::default();
    schedule.add_systems(sync_canvas_labels);
    for i in 0..1000 {
        let entity = owner(&mut world);
        stage(
            &mut world,
            CanvasLabelRole::Card,
            entity,
            vec![(format!("label {i}"), Vec2::new(i as f32, 0.), 12., 0xffffff)],
            5.,
            LabelStyle::Node,
        );
    }
    schedule.run(&mut world);
    world.flush();
    assert_eq!(world.query::<&CanvasLabel>().iter(&world).count(), 1000);
    world.clear_trackers();
    schedule.run(&mut world);
    world.flush();
    assert_eq!(world.query_filtered::<Entity, Or<(Changed<Text2d>, Changed<Transform>, Changed<TextColor>)>>()
        .iter(&world).count(), 0);
    // An externally removed slot must be rebuilt even if its request is unchanged.
    let lost = world
        .query_filtered::<Entity, With<CanvasLabel>>()
        .iter(&world)
        .next()
        .unwrap();
    world.despawn(lost);
    schedule.run(&mut world);
    world.flush();
    assert_eq!(world.query::<&CanvasLabel>().iter(&world).count(), 1000);
    replace_role_empty(&mut world, LabelWriter::Card, CanvasLabelRole::Card);
    schedule.run(&mut world);
    world.flush();
    assert_eq!(world.query::<&CanvasLabel>().iter(&world).count(), 0);
}

/// CPU-only scaling probe; does not initialise the renderer or claim hardware FPS.
#[test]
#[ignore = "manual CPU scaling probe"]
fn large_canvas_label_cpu_scaling() {
    for count in [1000, 3000, 6000] {
        let mut world = world();
        let mut schedule = Schedule::default();
        schedule.add_systems(sync_canvas_labels);
        for i in 0..count {
            let entity = owner(&mut world);
            stage(
                &mut world,
                CanvasLabelRole::Card,
                entity,
                vec![(format!("image {i}"), Vec2::new(i as f32, 0.), 12., 0xffffff)],
                5.,
                LabelStyle::Node,
            );
        }
        schedule.run(&mut world);
        world.flush();
        let mut samples = Vec::new();
        for _ in 0..25 {
            let start = std::time::Instant::now();
            schedule.run(&mut world);
            world.flush();
            samples.push(start.elapsed().as_secs_f64() * 1000.);
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "CPU labels nodes={count} median_ms={:.3} max_ms={:.3}",
            samples[12], samples[24]
        );
    }
}

#[test]
fn one_changed_owner_keeps_other_labels_untouched_and_reparenting_repairs_slots() {
    let mut world = world();
    let owners: Vec<_> = (0..1000)
        .map(|i| {
            let entity = owner(&mut world);
            stage(
                &mut world,
                CanvasLabelRole::Card,
                entity,
                vec![(format!("label {i}"), Vec2::ZERO, 12., 0xffffff)],
                5.,
                LabelStyle::Node,
            );
            entity
        })
        .collect();
    let mut schedule = Schedule::default();
    schedule.add_systems(sync_canvas_labels);
    schedule.run(&mut world);
    world.flush();
    let original = labels_of(&mut world, owners[17])[0];
    world.clear_trackers();
    stage(
        &mut world,
        CanvasLabelRole::Card,
        owners[17],
        vec![("changed".into(), Vec2::ZERO, 12., 0xffffff)],
        5.,
        LabelStyle::Node,
    );
    schedule.run(&mut world);
    world.flush();
    assert_eq!(
        world
            .query_filtered::<Entity, Changed<Text2d>>()
            .iter(&world)
            .collect::<Vec<_>>(),
        vec![original]
    );
    let other = owner(&mut world);
    world.entity_mut(original).insert(ChildOf(other));
    schedule.run(&mut world);
    world.flush();
    let repaired = labels_of(&mut world, owners[17]);
    assert_eq!(repaired.len(), 1);
    assert_ne!(repaired[0], original);
    assert!(
        world.get_entity(original).is_err(),
        "unrequested reparented role must be reclaimed"
    );
    world.resource_mut::<LabelRequests>().clear();
    schedule.run(&mut world);
    world.flush();
    assert_eq!(world.query::<&CanvasLabel>().iter(&world).count(), 0);
}

#[test]
fn label_colors_keep_linear_value_across_creation_reuse_and_theme_change() {
    let mut world = world();
    let node = owner(&mut world);
    for rgb in [0x84A1C3, 0x84A1C3, 0xEF6721] {
        push(
            &mut world,
            node,
            vec![("color".into(), Vec2::ZERO, 12., rgb)],
        );
        let entity = labels_of(&mut world, node)[0];
        let color = world.get::<TextColor>(entity).unwrap().0;
        assert!(matches!(color, Color::LinearRgba(_)));
        assert_eq!(
            color.to_linear(),
            super::super::layout::hex(rgb).to_linear()
        );
    }
}

#[test]
fn begin_replaces_one_role_empty_push_deletes_that_owner_and_unrun_role_stays() {
    let mut world = world();
    let card = owner(&mut world);
    let other_card = owner(&mut world);
    let running = owner(&mut world);
    let edge = owner(&mut world);
    let edge_kept = owner(&mut world);
    stage(
        &mut world,
        CanvasLabelRole::Card,
        card,
        vec![("card".into(), Vec2::ZERO, 12.0, 0xFFFFFF)],
        5.0,
        LabelStyle::Node,
    );
    stage(
        &mut world,
        CanvasLabelRole::Card,
        other_card,
        vec![("other".into(), Vec2::ZERO, 12.0, 0xFFFFFF)],
        5.0,
        LabelStyle::Node,
    );
    stage(
        &mut world,
        CanvasLabelRole::Running,
        running,
        vec![("50%".into(), Vec2::ZERO, 13.0, 0xFFFFFF)],
        6.0,
        LabelStyle::Running,
    );
    stage(
        &mut world,
        CanvasLabelRole::Edge,
        edge,
        vec![("edge".into(), Vec2::ZERO, 11.0, 0xFFFFFF)],
        4.0,
        LabelStyle::Edge,
    );
    stage(
        &mut world,
        CanvasLabelRole::Edge,
        edge_kept,
        vec![("kept-edge".into(), Vec2::ZERO, 11.0, 0xFFFFFF)],
        4.0,
        LabelStyle::Edge,
    );
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();

    {
        let card_owner = owner_key(card);
        let mut requests = world.resource_mut::<LabelRequests>();
        let mut txn = requests.transaction(LabelWriter::Card);
        txn.replace_role(
            CanvasLabelRole::Card,
            vec![(
                card_owner.clone(),
                0,
                LabelSpec::from_label(
                    ("stale".into(), Vec2::ZERO, 12.0, 0xFFFFFF),
                    5.0,
                    LabelStyle::Node,
                ),
            )],
        );
        txn.upsert(
            CanvasLabelRole::Card,
            card_owner.clone(),
            0,
            LabelSpec::from_label(
                ("replaced".into(), Vec2::ZERO, 12.0, 0xFFFFFF),
                5.0,
                LabelStyle::Node,
            ),
        );
        txn.commit().unwrap();
    }
    stage(
        &mut world,
        CanvasLabelRole::Edge,
        edge,
        Vec::new(),
        4.0,
        LabelStyle::Edge,
    );
    assert_eq!(
        world.resource::<LabelRequests>().spec_text(
            LabelWriter::Card,
            CanvasLabelRole::Card,
            &owner_key(card),
            0,
        ),
        Some("replaced")
    );
    assert!(
        !world.resource::<LabelRequests>().contains(
            LabelWriter::Card,
            CanvasLabelRole::Card,
            &owner_key(other_card),
            0,
        ),
        "整角色替换必须删掉该 writer 缺席的 owner"
    );
    assert!(
        world.resource::<LabelRequests>().contains(
            LabelWriter::Running,
            CanvasLabelRole::Running,
            &owner_key(running),
            0,
        ),
        "未运行 writer 必须保留"
    );
    assert!(
        !world.resource::<LabelRequests>().contains(
            LabelWriter::Edge,
            CanvasLabelRole::Edge,
            &owner_key(edge),
            0,
        ),
        "空集合必须删掉该 owner"
    );
    assert!(
        world.resource::<LabelRequests>().contains(
            LabelWriter::Edge,
            CanvasLabelRole::Edge,
            &owner_key(edge_kept),
            0,
        ),
        "空集合不得清空同角色的其他 owner"
    );

    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
    let card_labels = labels_of_role(&mut world, card, CanvasLabelRole::Card);
    assert_eq!(card_labels.len(), 1);
    assert_eq!(world.get::<Text2d>(card_labels[0]).unwrap().0, "replaced");
    assert!(labels_of_role(&mut world, other_card, CanvasLabelRole::Card).is_empty());
    assert_eq!(
        labels_of_role(&mut world, running, CanvasLabelRole::Running).len(),
        1
    );
    assert!(labels_of_role(&mut world, edge, CanvasLabelRole::Edge).is_empty());
    assert_eq!(
        labels_of_role(&mut world, edge_kept, CanvasLabelRole::Edge).len(),
        1
    );
}
