//! accepted snapshot → 画布节点实体投影
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，design D1 / 任务 1.3）。
//!
//! 投影是**唯一的快照遍历点**：其他 system 只通过 Query 与 `NodeIndex` 读取节点。实体按稳定
//! `nodeId` 复用；节点消失时连同 `ChildOf` 派生子实体一起回收；展示类型变化时移除旧
//! presentation 组件再插入新类型。
//!
//! 失败语义：非法布局、重复 id 或倒退的场景代数**不提交**本次投影，保留上一份合法实体集合，
//! 等待下一份 accepted snapshot。未知展示类型不是失败：节点保留为 `CustomPresentation`。

use bevy::ecs::component::Mutable;
use bevy::prelude::*;

use super::components::{
    CanvasDepth, CanvasHover, CanvasLayout, CanvasNodeId, CanvasSelection, CanvasVisibility,
    CardPresentation, CardVisual, ContainerVisual, CustomPresentation, FilmSetPresentation,
    GroupPresentation, NodeActionBar, OverviewCacheOwner,
};
use crate::app::{CurrentScene, FrameFlags};
use crate::protocol::{GraphNode, Scene};

/// 投影运行时状态：代数、实体数量与最近一次拒绝原因（诊断与回归断言）。
#[derive(Resource, Default, Debug)]
pub(crate) struct CanvasProjectionState {
    /// 最近一次成功投影的 accepted revision。
    pub(crate) applied_revision: Option<u32>,
    /// 最近一次成功投影的文档身份（画布 id）。
    ///
    /// `revision` 属于单个文档：身份变化时必须丢弃旧基线，否则切到 revision 更小的画布
    /// （新建画布）会把每一帧都判成「代数倒退」，卡片实体停在上一张画布的状态
    /// （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs）。
    pub(crate) applied_canvas_id: Option<String>,
    /// 最近一次成功投影的节点实体数（每个可呈现节点恰好一个）。
    pub(crate) nodes: usize,
    /// 成功投影次数（`0 → 1 → 0 → 1` 生命周期断言用）。
    pub(crate) generation: u64,
    /// 最近一次失败原因；`None` 表示最近一次输入被接受。
    pub(crate) rejected: Option<&'static str>,
    /// 本次投影是否新建/删除了实体（诊断）。
    pub(crate) structure_changed: bool,
    entities: std::collections::HashMap<String, Entity>,
}

impl CanvasProjectionState {
    /// Same-generation lookup; entity handles never survive a renderer instance.
    pub(crate) fn entity(&self, id: &str) -> Option<Entity> {
        self.entities.get(id).copied()
    }
}

/// 只在该帧可能改变节点集合或布局时运行。
pub(crate) fn projection_requested(flags: Res<FrameFlags>) -> bool {
    flags.scene_received || flags.positions_received || !flags.resource_nodes.is_empty()
}

type LayoutQuery<'w, 's> = Query<
    'w,
    's,
    (
        &'static mut CanvasLayout,
        &'static mut CanvasDepth,
        &'static mut CanvasSelection,
        &'static mut CanvasHover,
        &'static mut CanvasVisibility,
    ),
>;
type PresentationQuery<'w, 's> = Query<
    'w,
    's,
    (
        Option<&'static mut CardPresentation>,
        Option<&'static mut GroupPresentation>,
        Option<&'static mut FilmSetPresentation>,
        Option<&'static mut CustomPresentation>,
        Option<&'static mut OverviewCacheOwner>,
    ),
    With<CanvasNodeId>,
>;

/// 按 accepted snapshot 更新节点实体与通用组件。
pub(crate) fn project_canvas_nodes(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    mut state: ResMut<CanvasProjectionState>,
    flags: Res<FrameFlags>,
    mut layouts: LayoutQuery,
    mut presentations: PresentationQuery,
    existing: Query<(Entity, &CanvasNodeId)>,
    mut render_inputs: Query<(
        Option<&mut CardVisual>,
        Option<&mut ContainerVisual>,
        Option<&mut NodeActionBar>,
    )>,
) {
    if !flags.scene_received && !flags.positions_received && !flags.resource_nodes.is_empty() {
        for &slot in &flags.resource_nodes {
            let node = &scene.0.nodes[slot];
            let Some(entity) = state.entities.get(&node.id).copied() else {
                continue;
            };
            if let Ok((Some(mut card), _, _, _, _)) = presentations.get_mut(entity) {
                if card.texture != node.texture || card.media_loading != node.media_loading {
                    card.texture = node.texture;
                    card.media_loading = node.media_loading;
                }
            }
            if let Ok((Some(mut visual), _, _)) = render_inputs.get_mut(entity) {
                let desired = CardVisual::from_node(node);
                if *visual != desired {
                    *visual = desired;
                }
            }
        }
        return;
    }
    let source = &scene.0;
    let overlay = crate::canvas_query::focus_context::overlay(source);
    let projected = &overlay;
    state.structure_changed = false;
    state.rejected = None;
    // 代数单调保护只在**同一份文档**内有意义：`revision` 是每张画布各自累加的版本号，
    // 切画布（桌面端整页重载但原生渲染进程不重启）后新画布的 revision 往往更小。
    // 身份变化即丢弃旧基线；身份缺失（旧客户端/测试）沿用进程内单调语义。
    let identity = (!source.canvas_id.is_empty()).then_some(source.canvas_id.as_str());
    let same_document = match (&state.applied_canvas_id, identity) {
        (Some(applied), Some(current)) => applied == current,
        _ => true,
    };
    if same_document {
        if let Some(last) = state.applied_revision {
            if projected.revision < last {
                state.rejected = Some("scene generation regressed");
                return;
            }
        }
    }
    if let Some(reason) = validate(projected) {
        state.rejected = Some(reason);
        return;
    }

    let mut live: std::collections::HashMap<&str, Entity> = existing
        .iter()
        .map(|(entity, id)| (id.0.as_str(), entity))
        .collect();
    let render_indices = crate::canvas2d::draw_order::render_indices(&projected.nodes);
    for (node_index, node) in projected.nodes.iter().enumerate() {
        let render_index = render_indices[node_index];
        let depth = CanvasDepth {
            index: node_index,
            render: render_index,
            z: 10.0 + render_index as f32 * 0.1,
        };
        let layout = CanvasLayout::from_node(node);
        let selection = selection_of(projected, node);
        let hover = hover_of(projected, node);
        let visibility = CanvasVisibility { hidden: false };
        let entity = match live.remove(node.id.as_str()) {
            Some(entity) => {
                if let Ok((
                    mut current_layout,
                    mut current_depth,
                    mut current_selection,
                    mut current_hover,
                    mut current_visibility,
                )) = layouts.get_mut(entity)
                {
                    current_layout.set_if_neq(layout);
                    current_depth.set_if_neq(depth);
                    current_selection.set_if_neq(selection);
                    current_hover.set_if_neq(hover);
                    current_visibility.set_if_neq(visibility);
                } else {
                    commands
                        .entity(entity)
                        .insert((layout, depth, selection, hover, visibility));
                }
                entity
            }
            None => {
                state.structure_changed = true;
                let entity = commands
                    .spawn((
                        CanvasNodeId(node.id.clone()),
                        layout,
                        depth,
                        selection,
                        hover,
                        visibility,
                        Transform::IDENTITY,
                        GlobalTransform::IDENTITY,
                        Visibility::Inherited,
                        Name::new(format!("canvas-node:{}", node.id)),
                    ))
                    .id();
                entity
            }
        };
        state.entities.insert(node.id.clone(), entity);
        apply_presentation(&mut commands, &mut presentations, entity, projected, node);
        apply_render_inputs(&mut commands, &mut render_inputs, entity, projected, node);
    }
    // 不再可呈现的节点连同派生子实体（标签/纹理/面板/细节）一起回收。
    for (id, entity) in live {
        state.entities.remove(id);
        state.structure_changed = true;
        commands.entity(entity).despawn();
    }
    state.applied_revision = Some(projected.revision);
    if let Some(identity) = identity {
        state.applied_canvas_id = Some(identity.to_owned());
    }
    state.nodes = projected.nodes.len();
    state.generation = state.generation.wrapping_add(1);
}

fn apply_render_inputs(
    commands: &mut Commands,
    render_inputs: &mut Query<(
        Option<&mut CardVisual>,
        Option<&mut ContainerVisual>,
        Option<&mut NodeActionBar>,
    )>,
    entity: Entity,
    scene: &Scene,
    node: &GraphNode,
) {
    let desired_card = ContainerVisual::from_node(node)
        .is_none()
        .then(|| CardVisual::from_node(node));
    let desired_container = ContainerVisual::from_node(node);
    let desired_action = crate::canvas_query::action_bar_enabled(scene, node)
        .then(|| scene.node_actions.get(&node.id).cloned())
        .flatten()
        .map(|actions| NodeActionBar {
            summary: actions.summary.clone(),
            actions,
        });
    if let Ok((mut card, mut container, mut action)) = render_inputs.get_mut(entity) {
        if let Some(desired) = desired_card {
            if let Some(current) = card.as_mut() {
                current.set_if_neq(desired);
            } else {
                commands.entity(entity).insert(desired);
            }
        } else if card.is_some() {
            commands.entity(entity).remove::<CardVisual>();
        }
        if let Some(desired) = desired_container {
            if let Some(current) = container.as_mut() {
                current.set_if_neq(desired);
            } else {
                commands.entity(entity).insert(desired);
            }
        } else if container.is_some() {
            commands.entity(entity).remove::<ContainerVisual>();
        }
        if let Some(desired) = desired_action {
            if let Some(current) = action.as_mut() {
                current.set_if_neq(desired);
            } else {
                commands.entity(entity).insert(desired);
            }
        } else if action.is_some() {
            commands.entity(entity).remove::<NodeActionBar>();
        }
        return;
    }
    if let Some(container) = ContainerVisual::from_node(node) {
        commands.entity(entity).insert(container);
        commands.entity(entity).remove::<CardVisual>();
    } else {
        commands.entity(entity).insert(CardVisual::from_node(node));
        commands.entity(entity).remove::<ContainerVisual>();
    }
    if crate::canvas_query::action_bar_enabled(scene, node) {
        if let Some(actions) = scene.node_actions.get(&node.id) {
            commands.entity(entity).insert(NodeActionBar {
                actions: actions.clone(),
                summary: actions.summary.clone(),
            });
        }
    } else {
        commands.entity(entity).remove::<NodeActionBar>();
    }
}

// Existing components are updated in place, without structural commands or false
// Changed<T> flags. Only presentation transitions need deferred insert/remove.
fn sync_component<T: Component<Mutability = Mutable> + PartialEq>(
    commands: &mut Commands,
    entity: Entity,
    current: Option<Mut<T>>,
    desired: Option<T>,
) {
    match (current, desired) {
        (Some(mut current), Some(desired)) => {
            current.set_if_neq(desired);
        }
        (None, Some(desired)) => {
            commands.entity(entity).insert(desired);
        }
        (Some(_), None) => {
            commands.entity(entity).remove::<T>();
        }
        (None, None) => {}
    }
}

fn apply_presentation(
    commands: &mut Commands,
    presentations: &mut PresentationQuery,
    entity: Entity,
    scene: &Scene,
    node: &GraphNode,
) {
    let (card, group, film, custom, owner) = presentations
        .get_mut(entity)
        .unwrap_or((None, None, None, None, None));
    let previous = owner.as_deref().copied();
    let mut desired_card = None;
    let mut desired_group = None;
    let mut desired_film = None;
    let mut desired_custom = None;
    let mut desired_owner = OverviewCacheOwner::default();
    if let Some(presentation) = &node.group {
        desired_group = Some(GroupPresentation {
            drop_target: presentation.drop_target,
            collapsed: presentation.collapsed,
            member_count: presentation.member_count.max(0) as u32,
            running: crate::canvas2d::group_is_running(node),
            resizable: node.resizable,
        });
        let declared = presentation.overview_cache.is_some();
        let carried = previous.filter(|owner| owner.enabled);
        desired_owner = OverviewCacheOwner {
            enabled: declared,
            input_fingerprint: declared
                .then(|| {
                    crate::canvas_ecs::overview_cache::subject::presentation_fingerprint(
                        node,
                        crate::canvas_ecs::overview_cache::subject::preparation(scene, &node.id),
                    )
                })
                .unwrap_or(0),
            tier: carried.and_then(|owner| owner.tier),
            fallback: carried.and_then(|owner| owner.fallback),
        };
    } else if let Some(asset) = &node.composite_asset {
        desired_film = Some(FilmSetPresentation {
            panel: asset.panel.is_some(),
            has_model: node.model.is_some(),
            diamond: crate::canvas_query::scope::is_diamond(
                crate::canvas_query::scope::node_scope(node).shape,
            ),
        });
    } else {
        desired_card = Some(CardPresentation {
            resizable: node.resizable,
            texture: node.texture,
            busy: node.busy,
            media_loading: node.media_loading,
            ghost: node.ghost,
            model: node.model.is_some(),
            model_preview: node.model_preview.is_some(),
            history: crate::canvas_query::layout::has_history_strip(node),
            shot_preview: crate::canvas_query::shot_preview::is_shot_preview_node(node),
        });
        if node.kind.is_empty() {
            desired_custom = Some(CustomPresentation {
                kind: node.kind.clone(),
            });
        }
    }
    sync_component(commands, entity, card, desired_card);
    sync_component(commands, entity, group, desired_group);
    sync_component(commands, entity, film, desired_film);
    sync_component(commands, entity, custom, desired_custom);
    sync_component(commands, entity, owner, Some(desired_owner));
}

fn selection_of(scene: &Scene, node: &GraphNode) -> CanvasSelection {
    CanvasSelection {
        selected: scene.selection.nodes.iter().any(|id| id == &node.id),
        running: node.busy
            || node
                .group
                .as_ref()
                .is_some_and(|_| crate::canvas2d::group_is_running(node)),
        drop_target: node
            .group
            .as_ref()
            .is_some_and(|presentation| presentation.drop_target),
    }
}

/// 绘制用节点：按 id 从同代快照取原始节点，聚焦投影下套用同一只读布局变换。
pub(crate) fn node_for_draw<'a>(
    scene: &'a Scene,
    index: &crate::app::NodeIndex,
    id: &str,
) -> Option<std::borrow::Cow<'a, GraphNode>> {
    let (_, node) = index.node(scene, id)?;
    Some(crate::canvas_query::focus_context::node(scene, node))
}

fn hover_of(scene: &Scene, node: &GraphNode) -> CanvasHover {
    let hover = scene
        .hover
        .as_ref()
        .filter(|hover| hover.node_id.as_deref() == Some(node.id.as_str()));
    CanvasHover {
        hovered: hover.is_some(),
        port: hover.and_then(|hover| hover.port.clone()),
    }
}

/// 投影输入守卫：只拒绝无法建立稳定实体集合的输入。
fn validate(scene: &Scene) -> Option<&'static str> {
    let mut seen = std::collections::HashSet::with_capacity(scene.nodes.len());
    for node in &scene.nodes {
        if node.id.is_empty() {
            return Some("empty node id");
        }
        if !seen.insert(node.id.as_str()) {
            return Some("duplicate node id");
        }
        if ![node.x, node.y, node.width, node.height]
            .iter()
            .all(|value| value.is_finite())
        {
            return Some("non-finite node layout");
        }
        if node.width < 0. || node.height < 0. {
            return Some("negative node layout");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::CurrentScene;
    use bevy::ecs::system::RunSystemOnce;

    fn world() -> World {
        let mut world = World::new();
        world.insert_resource(CurrentScene::default());
        world.insert_resource(FrameFlags::default());
        world.init_resource::<CanvasProjectionState>();
        world
    }

    fn scene(nodes: &[(&str, f32, f32)]) -> Scene {
        Scene {
            nodes: nodes
                .iter()
                .map(|(id, x, y)| {
                    serde_json::from_value(serde_json::json!({
                        "id": id, "type": "text", "x": x, "y": y, "width": 200, "height": 120
                    }))
                    .unwrap()
                })
                .collect(),
            ..Scene::default()
        }
    }

    fn project(world: &mut World, scene: Scene, received: bool) {
        world.resource_mut::<CurrentScene>().0 = scene;
        world.resource_mut::<FrameFlags>().scene_received = received;
        let _ = world.run_system_once(project_canvas_nodes);
        world.flush();
    }

    fn nodes(world: &mut World) -> Vec<(String, f32, f32)> {
        world
            .query::<(&CanvasNodeId, &CanvasLayout)>()
            .iter(world)
            .map(|(id, layout)| (id.0.clone(), layout.x, layout.y))
            .collect()
    }

    /// Native CPU system cost only, with no GPU or browser timing claims.
    #[test]
    #[ignore = "manual CPU scaling probe"]
    fn large_canvas_projection_cpu_scaling() {
        for count in [1000, 3000, 6000] {
            let mut world = world();
            let source = Scene {
                nodes: (0..count)
                    .map(|i| {
                        serde_json::from_value(serde_json::json!({
                "id": format!("image-{i}"), "type":"image", "x": i, "y":0, "width":180, "height":160
            })).unwrap()
                    })
                    .collect(),
                ..Scene::default()
            };
            project(&mut world, source, true);
            let mut samples = Vec::new();
            for _ in 0..25 {
                let start = std::time::Instant::now();
                world.run_system_once(project_canvas_nodes).unwrap();
                world.flush();
                samples.push(start.elapsed().as_secs_f64() * 1000.);
            }
            samples.sort_by(f64::total_cmp);
            println!(
                "CPU projection nodes={count} median_ms={:.3} max_ms={:.3}",
                samples[12], samples[24]
            );
        }
    }

    #[test]
    fn identical_full_projection_keeps_component_ticks_and_only_changes_moved_node() {
        let mut world = world();
        let source = scene(
            &(0..3000)
                .map(|i| (format!("node-{i}"), i as f32, 0.))
                .collect::<Vec<_>>()
                .iter()
                .map(|(id, x, y)| (id.as_str(), *x, *y))
                .collect::<Vec<_>>(),
        );
        project(&mut world, source.clone(), true);
        world.clear_trackers();
        project(&mut world, source.clone(), true);
        let changed = world
            .query_filtered::<Entity, Or<(
                Changed<CanvasLayout>,
                Changed<CanvasDepth>,
                Changed<CanvasSelection>,
                Changed<CanvasHover>,
                Changed<CanvasVisibility>,
                Changed<CardPresentation>,
                Changed<CardVisual>,
                Changed<CustomPresentation>,
                Changed<OverviewCacheOwner>,
            )>>()
            .iter(&world)
            .count();
        assert_eq!(
            changed, 0,
            "unchanged full scenes must not invalidate downstream systems"
        );

        world.clear_trackers();
        let mut moved = source;
        moved.nodes[17].x += 10.;
        project(&mut world, moved, true);
        let changed: Vec<_> = world
            .query_filtered::<&CanvasNodeId, Changed<CanvasLayout>>()
            .iter(&world)
            .map(|id| id.0.as_str())
            .collect();
        assert_eq!(changed, ["node-17"]);
    }

    #[test]
    fn resource_rows_update_only_affected_cards_and_preserve_projection_generation() {
        let mut world = world();
        project(&mut world, scene(&[("a", 0., 0.), ("b", 100., 0.)]), true);
        let generation = world.resource::<CanvasProjectionState>().generation;
        world.resource_mut::<CurrentScene>().0.nodes[0].texture = true;
        world.resource_mut::<CurrentScene>().0.nodes[0].media_loading = true;
        {
            let mut flags = world.resource_mut::<FrameFlags>();
            flags.scene_received = false;
            flags.resource_nodes = vec![0];
        }
        world.run_system_once(project_canvas_nodes).unwrap();
        world.flush();
        assert_eq!(
            world.resource::<CanvasProjectionState>().generation,
            generation
        );
        for (id, card) in world
            .query::<(&CanvasNodeId, &CardPresentation)>()
            .iter(&world)
        {
            assert_eq!(card.texture, id.0 == "a");
            assert_eq!(card.media_loading, id.0 == "a");
        }
    }

    #[test]
    fn stable_ids_reuse_entities_and_recreate_after_removal() {
        let mut world = world();
        project(&mut world, scene(&[("a", 1., 2.), ("b", 3., 4.)]), true);
        let first: Vec<Entity> = world
            .query_filtered::<Entity, With<CanvasNodeId>>()
            .iter(&world)
            .collect();
        assert_eq!(first.len(), 2);
        let a = world
            .query::<(&CanvasNodeId, Entity)>()
            .iter(&world)
            .find(|(id, _)| id.0 == "a")
            .unwrap()
            .1;
        project(&mut world, scene(&[("b", 3., 4.), ("c", 5., 6.)]), true);
        let second = nodes(&mut world);
        assert_eq!(second.len(), 2);
        assert!(
            second
                .iter()
                .any(|(id, x, y)| id == "c" && *x == 5. && *y == 6.)
        );
        assert!(!second.iter().any(|(id, _, _)| id == "a"));
        assert!(world.get_entity(a).is_err());
        let b = world
            .query::<(&CanvasNodeId, Entity)>()
            .iter(&world)
            .find(|(id, _)| id.0 == "b")
            .unwrap()
            .1;
        assert!(first.contains(&b), "same id must reuse its entity");
        project(&mut world, scene(&[]), true);
        assert!(nodes(&mut world).is_empty());
        project(&mut world, scene(&[("a", 1., 2.)]), true);
        assert_eq!(nodes(&mut world).len(), 1);
    }

    #[test]
    fn invalid_projection_keeps_last_valid_entity_set() {
        let mut world = world();
        project(&mut world, scene(&[("a", 0., 0.)]), true);
        let mut bad = scene(&[("a", 0., 0.)]);
        bad.nodes.push(bad.nodes[0].clone());
        project(&mut world, bad, true);
        let kept = nodes(&mut world);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].0, "a");
        assert_eq!(
            world.resource::<CanvasProjectionState>().rejected,
            Some("duplicate node id")
        );
        project(&mut world, scene(&[("a", 0., 0.), ("b", 1., 1.)]), true);
        assert_eq!(nodes(&mut world).len(), 2);
        assert!(world.resource::<CanvasProjectionState>().rejected.is_none());
    }

    #[test]
    fn presentations_replace_on_kind_change_and_unknown_kinds_keep_node_entity() {
        let mut world = world();
        let group: GraphNode = serde_json::from_value(serde_json::json!({
            "id":"g","type":"group","x":0,"y":0,"width":100,"height":100,
            "group":{"title":"g","memberCount":1}
        }))
        .unwrap();
        let mut current = Scene {
            nodes: vec![group],
            ..Scene::default()
        };
        project(&mut world, current.clone(), true);
        assert!(
            world
                .query::<&GroupPresentation>()
                .iter(&world)
                .next()
                .is_some()
        );
        current.nodes[0].group = None;
        current.nodes[0].kind = String::new();
        project(&mut world, current, true);
        assert!(
            world
                .query::<&GroupPresentation>()
                .iter(&world)
                .next()
                .is_none()
        );
        assert!(
            world
                .query::<&CustomPresentation>()
                .iter(&world)
                .next()
                .is_some()
        );
        assert!(
            world
                .query::<&CardPresentation>()
                .iter(&world)
                .next()
                .is_some()
        );
    }

    #[test]
    fn scene_generation_regression_is_rejected() {
        let mut world = world();
        let mut newer = scene(&[("a", 0., 0.)]);
        newer.revision = 7;
        project(&mut world, newer, true);
        let mut older = scene(&[("b", 0., 0.)]);
        older.revision = 3;
        project(&mut world, older, true);
        assert_eq!(nodes(&mut world).len(), 1);
        assert_eq!(nodes(&mut world)[0].0, "a");
        assert_eq!(
            world.resource::<CanvasProjectionState>().rejected,
            Some("scene generation regressed")
        );
    }

    /// 切画布（桌面端整页重载、原生渲染进程不重启）时新画布的 revision 更小，
    /// 必须按文档身份重置基线而不是判成倒退（回归：新建画布后卡片整帧不更新）。
    #[test]
    fn lower_revision_of_another_document_is_accepted() {
        let mut world = world();
        let mut first = scene(&[("a", 0., 0.)]);
        first.canvas_id = "canvas-a".to_owned();
        first.revision = 7;
        project(&mut world, first, true);
        assert_eq!(nodes(&mut world).len(), 1);

        let mut second = scene(&[("b", 0., 0.), ("c", 10., 0.)]);
        second.canvas_id = "canvas-b".to_owned();
        second.revision = 3;
        project(&mut world, second, true);
        assert_eq!(nodes(&mut world).len(), 2);
        assert_eq!(
            world.resource::<CanvasProjectionState>().rejected,
            None::<&'static str>
        );
        let state = world.resource::<CanvasProjectionState>();
        assert_eq!(state.applied_revision, Some(3));
        assert_eq!(state.applied_canvas_id.as_deref(), Some("canvas-b"));

        // 新文档内仍然保持代数单调。
        let mut regressed = scene(&[("d", 0., 0.)]);
        regressed.canvas_id = "canvas-b".to_owned();
        regressed.revision = 2;
        project(&mut world, regressed, true);
        assert_eq!(
            world.resource::<CanvasProjectionState>().rejected,
            Some("scene generation regressed")
        );
        assert_eq!(nodes(&mut world).len(), 2);
    }
}
