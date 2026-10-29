//! 节点/group/片场标签实体的生命周期（change: refactor-bevy-rust-file-size 后续拆分）。
//!
//! 普通卡片、group 容器与片场标题共用同一 `Visuals.labels` 实体池：按节点 id keyed，长度可变。
//! 从 `render.rs` 抽出以保持在文件体积上限内（`tests/file_size.rs` 守卫）。
//!
//! 生命周期必须闭合支持 `0 → 1 → 0 → 1`（change:
//! 2026-10-10-improve-film-set-editing-and-inspector，design D2）：片场标题只在
//! hover/选中时出现，反复显隐不能丢失文字或残留实体。因此这里按位置更新已有实体、
//! 补建不足数量、回收多余数量，并在集合为空时删除池条目。只 zip 已存在实体会让
//! 「先隐藏再显示」丢失文字，是本次修复的根因。

use bevy::{
    prelude::*,
    sprite::Anchor,
    text::{LineBreak, TextBounds},
};

use super::Visuals;
use super::layout::{hex, label_pool_plan};
use super::text_presentation::{LogicalText, TextScaleMode};

/// 标签文案包：`(文案, 位置, 字号, 颜色 0xRRGGBB)`。
///
/// 「字号」是**逻辑字号**（世界单位）：实际 `TextFont` 由
/// [`super::text_presentation`] 按相机缩放与 DPR 派生，绘制侧不直接写栅格字号
/// （change: 2026-10-22-improve-canvas-text-clarity，design D1）。
pub(crate) type Label = (String, Vec2, f32, u32);

/// 标签逻辑 bounds（世界单位）。截断由调用方按逻辑宽度决定，栅格 bounds 按同一比例换算。
const LABEL_BOUNDS: Vec2 = Vec2::new(600.0, 48.0);

/// 更新/新增/回收某个节点的标签实体（普通卡片、group 容器与片场标题共用）。
///
/// 标签集合长度可变：group/片场只有 1 条标题标签，普通卡片有分类 + 多行正文。
/// 更新已有部分、补建新增部分、回收多余部分；集合为空时**移除池条目**，使下一次
/// 非空集合可以重新补建。内存中残留的旧实体（例如旧版本渲染留下的状态槽）必须回收，
/// 否则已废弃的文案会继续留在卡片上。
pub(crate) fn sync_labels(
    commands: &mut Commands,
    visuals: &mut Visuals,
    text_query: &mut Query<
        (
            &mut Text2d,
            &mut Transform,
            &mut TextColor,
            &mut LogicalText,
        ),
        Without<Sprite>,
    >,
    node_id: &str,
    labels: Vec<Label>,
    z: f32,
) {
    // 取出现有实体，避免在补建时同时持有池与 visuals 的可变借用。
    let mut entities = visuals.labels.remove(node_id).unwrap_or_default();
    let (_, _, despawn, retain) = label_pool_plan(entities.len(), labels.len());
    // 回收多余额度。
    for _ in 0..despawn {
        if let Some(entity) = entities.pop() {
            commands.entity(entity).despawn();
        }
    }
    for (index, (label, position, size, color)) in labels.into_iter().enumerate() {
        if let Some(entity) = entities.get(index).copied() {
            if let Ok((mut text, mut transform, mut text_color, mut meta)) =
                text_query.get_mut(entity)
            {
                if text.0 != label {
                    text.0 = label;
                }
                transform.translation = Vec3::new(position.x, -position.y, z);
                text_color.0 = hex(color);
                // 复用实体必须同步最新逻辑字号/bounds：栅格显示由策略系统按逻辑值重算，
                // 不把这里的逻辑值直接写进 `TextFont`（change: 2026-10-22-improve-canvas-text-clarity）。
                if !meta.matches(size, Some(LABEL_BOUNDS), TextScaleMode::World) {
                    meta.set(size, Some(LABEL_BOUNDS), TextScaleMode::World);
                }
            }
            continue;
        }
        entities.push(spawn_label(
            commands, visuals, label, position, size, color, z,
        ));
    }
    // 空集合不保留占位槽：下次非空调用走 `unwrap_or_default` 重新补建，
    // 这正是「先隐藏再显示」能恢复文字的关键。
    if retain {
        visuals.labels.insert(node_id.to_owned(), entities);
    }
}

/// 生成一条标签文字实体；由调用方决定何时进入/退出实体池。
///
/// `font_size` 只是初始逻辑字号：落位前由策略系统按当前相机/DPR 重算栅格表示，
/// 新实体首个可呈现帧即具有正确清晰度。
fn spawn_label(
    commands: &mut Commands,
    visuals: &Visuals,
    label: String,
    position: Vec2,
    size: f32,
    color: u32,
    z: f32,
) -> Entity {
    commands
        .spawn((
            Text2d::new(label),
            TextFont {
                font: visuals.font.clone().into(),
                font_size: FontSize::Px(size),
                ..default()
            },
            TextColor(hex(color)),
            TextLayout::new(Justify::Left, LineBreak::NoWrap),
            TextBounds {
                width: Some(LABEL_BOUNDS.x),
                height: Some(LABEL_BOUNDS.y),
            },
            Anchor::TOP_LEFT,
            Transform::from_xyz(position.x, -position.y, z),
            LogicalText::world(size, Some(LABEL_BOUNDS)),
        ))
        .id()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{CurrentScene, SurfaceState};
    use crate::canvas2d::text_presentation;
    use bevy::ecs::system::RunSystemOnce;

    /// 测试入口：把「要应用的标签集合」放进资源，由真实系统签名调用 `sync_labels`。
    #[derive(Resource, Default)]
    struct Pending {
        node_id: String,
        labels: Vec<Label>,
        z: f32,
    }

    fn apply(
        mut commands: Commands,
        mut visuals: ResMut<Visuals>,
        mut query: Query<
            (
                &mut Text2d,
                &mut Transform,
                &mut TextColor,
                &mut LogicalText,
            ),
            Without<Sprite>,
        >,
        mut pending: ResMut<Pending>,
    ) {
        let node_id = pending.node_id.clone();
        let z = pending.z;
        let labels = std::mem::take(&mut pending.labels);
        sync_labels(&mut commands, &mut visuals, &mut query, &node_id, labels, z);
    }

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
        world.insert_resource(SurfaceState::with_size(Vec2::new(800.0, 600.0)));
        world.insert_resource(text_presentation::PresentationCache::default());
        world.insert_resource(Pending {
            node_id: "n1".to_owned(),
            labels: Vec::new(),
            z: 5.0,
        });
        world.insert_resource(Visuals {
            card_blocks: Vec::new(),
            card_decorations: Vec::new(),
            container_blocks: Vec::new(),
            mesh: default(),
            material: default(),
            mesh_entity: None,
            blend_mesh: default(),
            blend_material: default(),
            blend_mesh_entity: None,
            font: default(),
            labels: default(),
            textures: default(),
            texture_store: default(),
            edge_blocks: default(),
            shared_key: None,
            attach_labels: default(),
            attach_probe_mesh: default(),
            attach_probe_entity: None,
            attach_probe_active: false,
            media_alpha_checker: None,
            running_mesh: default(),
            running_mesh_entity: None,
            running_labels: default(),
            running_active: false,
            node_action_mesh: default(),
            node_action_entity: None,
            node_action_labels: default(),
            node_action_active: false,
        });
        world
    }

    fn sync(world: &mut World, labels: Vec<Label>) {
        {
            let mut pending = world.resource_mut::<Pending>();
            pending.node_id = "n1".to_owned();
            pending.z = 5.0;
            pending.labels = labels;
        }
        world.run_system_once(apply).unwrap();
        world.flush();
    }

    fn glyph(world: &World, entity: Entity) -> (f32, f32) {
        let font = world.get::<TextFont>(entity).unwrap().font_size;
        let size = match font {
            FontSize::Px(size) => size,
            other => panic!("unexpected font size {other:?}"),
        };
        (size, world.get::<Transform>(entity).unwrap().scale.x)
    }

    /// 只改逻辑字号/文案的池复用：元数据更新，栅格由策略系统按逻辑值派生（不累乘尺度）。
    #[test]
    fn reused_label_keeps_logical_font_size_and_lets_strategy_rasterize() {
        let mut world = world();
        sync(
            &mut world,
            vec![("标题".to_owned(), Vec2::new(10.0, 20.0), 12.0, 0xFFFFFF)],
        );
        let entity = world.resource::<Visuals>().labels["n1"][0];
        world.run_system_once(text_presentation::sync).unwrap();
        let (font, scale) = glyph(&world, entity);
        assert!((font * scale - 12.0).abs() <= 1.0e-3, "100% 档显示逻辑字号");

        sync(
            &mut world,
            vec![("新标题".to_owned(), Vec2::new(10.0, 20.0), 16.0, 0xFFFFFF)],
        );
        assert_eq!(
            world.get::<LogicalText>(entity).unwrap().size,
            16.0,
            "复用实体必须同步最新逻辑字号"
        );
        assert_eq!(world.get::<Text2d>(entity).unwrap().0, "新标题");
        world.run_system_once(text_presentation::sync).unwrap();
        let (font, scale) = glyph(&world, entity);
        assert!((font * scale - 16.0).abs() <= 1.0e-3, "按新逻辑字号显示");

        // 重复应用同一状态不累乘尺度。
        for _ in 0..3 {
            sync(
                &mut world,
                vec![("新标题".to_owned(), Vec2::new(10.0, 20.0), 16.0, 0xFFFFFF)],
            );
            world.run_system_once(text_presentation::sync).unwrap();
        }
        let after = glyph(&world, entity);
        assert!((after.1 - scale).abs() <= 1.0e-6);
        assert_eq!(after.0, font);
    }

    /// 先隐藏再显示：实体池重新补建并按当前倍率直接选档，不复用旧累积状态。
    #[test]
    fn hide_then_show_rebuilds_and_selects_current_step() {
        let mut world = world();
        sync(
            &mut world,
            vec![("标题".to_owned(), Vec2::ZERO, 12.0, 0xFFFFFF)],
        );
        let first = world.resource::<Visuals>().labels["n1"][0];
        sync(&mut world, Vec::new());
        assert!(!world.resource::<Visuals>().labels.contains_key("n1"));
        assert!(world.get_entity(first).is_err(), "隐藏必须回收实体");

        // 隐藏期间改变倍率与 DPR。
        world.resource_mut::<CurrentScene>().0.viewport.zoom = 8.0;
        world.resource_mut::<SurfaceState>().pixel_ratio = 2.0;
        sync(
            &mut world,
            vec![("标题".to_owned(), Vec2::ZERO, 12.0, 0xFFFFFF)],
        );
        let second = world.resource::<Visuals>().labels["n1"][0];
        assert_ne!(second, first, "隐藏后必须新建实体");
        world.run_system_once(text_presentation::sync).unwrap();
        let (font, scale) = glyph(&world, second);
        // zoom 8 → 档位 8；DPR 2 → 物理 192px，写回逻辑字号 96。
        assert!((font - 96.0).abs() <= 1.0e-3);
        assert!((font * scale - 12.0).abs() <= 1.0e-3);
    }

    /// 跨档往返不改变文案与业务截断，只改变栅格表示。
    #[test]
    fn step_changes_keep_text_content_and_logical_layout() {
        let mut world = world();
        let long =
            "这是一段会被业务逻辑截断的较长中文标题，用来验证栅格档位不影响文案与分行".to_owned();
        sync(
            &mut world,
            vec![(long.clone(), Vec2::new(24.0, 56.0), 12.0, 0xFFFFFF)],
        );
        let entity = world.resource::<Visuals>().labels["n1"][0];
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
                baseline_translation,
                "zoom={zoom} 锚点必须不变"
            );
            let (font, scale) = glyph(&world, entity);
            assert!(
                (font * scale - 12.0).abs() <= 1.0e-3,
                "zoom={zoom} 逻辑字号必须不变"
            );
            // 栅格 bounds 与字体同比例换算，逻辑宽度仍是 LABEL_BOUNDS。
            let bounds = world.get::<TextBounds>(entity).unwrap();
            let width = bounds.width.expect("标签有界");
            assert!(
                (width * scale - LABEL_BOUNDS.x).abs() <= 1.0e-3,
                "zoom={zoom} 逻辑 bounds 必须不变"
            );
        }
    }

    /// 池缩容回收多余实体，扩容补建；复用重叠部分。
    #[test]
    fn pool_shrink_and_grow_reclaim_entities() {
        let mut world = world();
        let rows = |count: usize| -> Vec<Label> {
            (0..count)
                .map(|index| (format!("行{index}"), Vec2::ZERO, 12.0, 0xFFFFFF))
                .collect()
        };
        sync(&mut world, rows(3));
        let three = world.resource::<Visuals>().labels["n1"].clone();
        sync(&mut world, rows(1));
        assert_eq!(world.resource::<Visuals>().labels["n1"], vec![three[0]]);
        assert!(world.get_entity(three[1]).is_err());
        assert!(world.get_entity(three[2]).is_err());
        sync(&mut world, rows(2));
        let two = world.resource::<Visuals>().labels["n1"].clone();
        assert_eq!(two.len(), 2);
        assert_eq!(two[0], three[0], "复用重叠部分");
        assert_ne!(two[1], three[1], "被回收的槽位必须补建新实体");
    }
}
