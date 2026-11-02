//! 标签 owner/role/slot 生命周期回归
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，任务 4.1）。
use super::*;
use crate::app::CurrentScene;
use crate::canvas_ecs::components::{CanvasLabel, CanvasLabelRole};
use crate::canvas2d::text_presentation;
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

fn push(world: &mut World, owner: Entity, labels: Vec<Label>) {
    world
        .resource_mut::<LabelRequests>()
        .begin(CanvasLabelRole::Card);
    world.resource_mut::<LabelRequests>().push(
        CanvasLabelRole::Card,
        owner,
        labels,
        5.0,
        LabelStyle::Node,
    );
    world.run_system_once(sync_canvas_labels).unwrap();
    world.flush();
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
    world
        .resource_mut::<LabelRequests>()
        .begin(CanvasLabelRole::Running);
    world.resource_mut::<LabelRequests>().push(
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
        world.resource_mut::<LabelRequests>().push(
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
    world
        .resource_mut::<LabelRequests>()
        .begin(CanvasLabelRole::Card);
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
            world.resource_mut::<LabelRequests>().push(
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
            world.resource_mut::<LabelRequests>().push(
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
    world.resource_mut::<LabelRequests>().push(
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
