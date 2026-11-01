//! accepted snapshot → 画布节点实体投影
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，design D1 / 任务 1.3）。
//!
//! 投影是**唯一的快照遍历点**：其他 system 只通过 Query 与 `NodeIndex` 读取节点。实体按稳定
//! `nodeId` 复用；节点消失时连同 `ChildOf` 派生子实体一起回收；展示类型变化时移除旧
//! presentation 组件再插入新类型。
//!
//! 失败语义：非法布局、重复 id 或倒退的场景代数**不提交**本次投影，保留上一份合法实体集合，
//! 等待下一份 accepted snapshot。未知展示类型不是失败：节点保留为 `CustomPresentation`。

use bevy::prelude::*;

use super::components::{
    CanvasDepth, CanvasHover, CanvasLayout, CanvasNodeId, CanvasSelection, CanvasVisibility,
    CardPresentation, CardVisual, CustomPresentation, NodeActionBar,
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
}

/// 只在该帧可能改变节点集合或布局时运行。
pub(crate) fn projection_requested(flags: Res<FrameFlags>) -> bool {
    flags.scene_received || flags.positions_received
}

/// 按 accepted snapshot 更新节点实体与通用组件。
pub(crate) fn project_canvas_nodes(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    mut state: ResMut<CanvasProjectionState>,
    existing: Query<(Entity, &CanvasNodeId)>,
    mut render_inputs: Query<(Option<&mut CardVisual>, Option<&mut NodeActionBar>)>,
) {
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
    for (node_index, node) in projected.nodes.iter().enumerate() {
        let render_index = crate::canvas2d::draw_order::render_index(&projected.nodes, node_index);
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
                commands
                    .entity(entity)
                    .insert((layout, depth, selection, hover, visibility));
                entity
            }
            None => {
                state.structure_changed = true;
                commands
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
                    .id()
            }
        };
        apply_presentation(&mut commands, entity, node);
        apply_render_inputs(&mut commands, &mut render_inputs, entity, projected, node);
    }
    // 不再可呈现的节点连同派生子实体（标签/纹理/面板/细节）一起回收。
    for (_, entity) in live {
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
    render_inputs: &mut Query<(Option<&mut CardVisual>, Option<&mut NodeActionBar>)>,
    entity: Entity,
    scene: &Scene,
    node: &GraphNode,
) {
    let desired_card = CardVisual::from_node(node);
    let desired_action = crate::canvas_query::action_bar_visible(scene, node)
        .then(|| scene.node_actions.get(&node.id).cloned())
        .flatten()
        .map(|actions| NodeActionBar {
            summary: actions.summary.clone(),
            actions,
        });
    if let Ok((mut card, mut action)) = render_inputs.get_mut(entity) {
        if let Some(current) = card.as_deref_mut() {
            if *current != desired_card {
                *current = desired_card;
            }
        } else {
            commands.entity(entity).insert(desired_card);
        }
        if let Some(desired) = desired_action {
            if let Some(current) = action.as_deref_mut() {
                if *current != desired {
                    *current = desired;
                }
            } else {
                commands.entity(entity).insert(desired);
            }
        } else if action.is_some() {
            commands.entity(entity).remove::<NodeActionBar>();
        }
        return;
    }
    commands.entity(entity).insert(desired_card);
    if let Some(actions) = desired_action {
        commands.entity(entity).insert(actions);
    } else {
        commands.entity(entity).remove::<NodeActionBar>();
    }
}

fn apply_presentation(commands: &mut Commands, entity: Entity, node: &GraphNode) {
    commands.entity(entity).insert(CardPresentation {
        resizable: node.resizable,
        texture: node.texture,
        busy: node.busy,
        media_loading: node.media_loading,
        ghost: node.ghost,
        model: node.model.is_some(),
        model_preview: node.model_preview.is_some(),
        history: crate::canvas_query::layout::has_history_strip(node),
    });
    if node.kind.is_empty() {
        commands.entity(entity).insert(CustomPresentation {
            kind: node.kind.clone(),
        });
    } else {
        commands.entity(entity).remove::<CustomPresentation>();
    }
}

fn selection_of(scene: &Scene, node: &GraphNode) -> CanvasSelection {
    CanvasSelection {
        selected: scene.selection.nodes.iter().any(|id| id == &node.id),
        running: node.busy,
        drop_target: false,
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
