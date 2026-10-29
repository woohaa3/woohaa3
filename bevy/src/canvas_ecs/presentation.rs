//! 展示语义子实体的创建/回收：per-group 透明面板
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，design D2 / 任务 2.1）。
//!
//! group 面板是「一个容器一个独立透明实体」：Bevy 按实体 transform 排序 Transparent2d，
//! 因此面板实体自己的 z 才是真正排序键。面板不再存在 16 节点 block 的 `panels` 向量里，
//! 而是带 `GroupPanel { owner }` 组件、由 owner Query 维护；节点删除/类型替换时本系统回收
//! 实体与独占 mesh。
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

use super::components::{CanvasDepth, CanvasLayout, CanvasNodeId, GroupPresentation};
use crate::app::{CurrentScene, NodeIndex};
use crate::canvas2d::CanvasOverlayCache;
use crate::theme::ThemeResource;

const BLOCK_SIZE: usize = 16;

/// group 面板 key：矩形、drop 目标与主题变化才重建 mesh。
///
/// mesh 是组本地坐标，所以只有宽高参与重建判定；位置只更新实体 transform。
#[derive(Clone, Copy, Debug, PartialEq)]
struct PanelKey {
    rect: [f32; 4],
    drop_target: bool,
    theme: u64,
    sort_z: f32,
}

/// 把组本地 mesh 放到画布位置：协议 y 向下，世界 y 向上，因此取反。
fn placement(rect: [f32; 4], sort_z: f32) -> Transform {
    Transform::from_xyz(rect[0], -rect[1], sort_z)
}

/// group 面板实体：owner 节点 + 当前 key + 独占 mesh。
#[derive(Component)]
pub(crate) struct GroupPanel {
    pub(crate) owner: Entity,
    key: PanelKey,
    mesh: Handle<Mesh>,
}

/// 按 group 节点集合创建/更新/回收面板实体。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_group_panels(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    visuals: Res<CanvasOverlayCache>,
    mut meshes: ResMut<Assets<Mesh>>,
    nodes: Query<(
        Entity,
        &CanvasNodeId,
        &CanvasLayout,
        &CanvasDepth,
        &GroupPresentation,
    )>,
    mut panels: Query<(Entity, &mut GroupPanel)>,
) {
    let count = scene.0.nodes.len().div_ceil(BLOCK_SIZE);
    let theme_key = fingerprint(&theme);
    let mut by_owner: std::collections::HashMap<Entity, Entity> = panels
        .iter()
        .map(|(entity, panel)| (panel.owner, entity))
        .collect();
    let mut live = std::collections::HashSet::new();
    for (entity, id, layout, depth, presentation) in &nodes {
        live.insert(entity);
        let Some(node) = index
            .node(&scene.0, &id.0)
            .map(|(_, node)| crate::canvas_query::focus_context::node(&scene.0, node))
        else {
            continue;
        };
        let block_index = depth.index / BLOCK_SIZE;
        let sort_z = -0.001 * (count.saturating_sub(block_index)) as f32 / (count + 1) as f32;
        let key = PanelKey {
            rect: [layout.x, layout.y, layout.width, layout.height],
            drop_target: presentation.drop_target,
            theme: theme_key,
            sort_z,
        };
        match by_owner.get(&entity).copied() {
            Some(panel_entity) => {
                let Ok((_, mut panel)) = panels.get_mut(panel_entity) else {
                    continue;
                };
                if panel.key == key {
                    continue;
                }
                let rebuilt = panel.key.rect[2..] != key.rect[2..]
                    || panel.key.drop_target != key.drop_target
                    || panel.key.theme != key.theme;
                if rebuilt {
                    let group = node.group.as_ref().expect("group presentation");
                    let handle = meshes.add(crate::canvas2d::group::draw_group_panel(
                        &theme, &node, group,
                    ));
                    meshes.remove(panel.mesh.id());
                    panel.mesh = handle.clone();
                    commands.entity(panel_entity).insert(Mesh2d(handle));
                }
                commands
                    .entity(panel_entity)
                    .insert(placement(key.rect, key.sort_z));
                panel.key = key;
            }
            None => {
                let group = node.group.as_ref().expect("group presentation");
                let handle = meshes.add(crate::canvas2d::group::draw_group_panel(
                    &theme, &node, group,
                ));
                let panel_entity = commands
                    .spawn((
                        Mesh2d(handle.clone()),
                        MeshMaterial2d(visuals.blend_visuals().1),
                        placement(key.rect, key.sort_z),
                        NoFrustumCulling,
                        GroupPanel {
                            owner: entity,
                            key,
                            mesh: handle,
                        },
                        Name::new(format!("canvas-group-panel:{}", id.0)),
                    ))
                    .id();
                by_owner.insert(entity, panel_entity);
            }
        }
    }
    // 节点删除、类型改为卡片/片场或聚焦隔离后，面板实体与独占 mesh 一并回收。
    for (panel_entity, panel) in &mut panels {
        if !live.contains(&panel.owner) {
            meshes.remove(panel.mesh.id());
            commands.entity(panel_entity).despawn();
        }
    }
}

fn fingerprint(theme: &ThemeResource) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in theme.fingerprint().as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{CurrentScene, FrameFlags, NodeIndex};
    use bevy::ecs::system::RunSystemOnce;

    fn node() -> crate::protocol::GraphNode {
        serde_json::from_value(serde_json::json!({
            "id":"g","type":"group","x":10,"y":20,"width":300,"height":200,
            "group":{"title":"g","memberCount":2}
        }))
        .unwrap()
    }

    fn world() -> World {
        let mut world = World::new();
        world.insert_resource(CurrentScene(crate::protocol::Scene {
            nodes: vec![node()],
            ..default()
        }));
        world.insert_resource(NodeIndex::default());
        world.insert_resource(ThemeResource::default());
        world.init_resource::<Assets<Mesh>>();
        world.insert_resource(FrameFlags::default());
        world.insert_resource(CanvasOverlayCache::default_for_test());
        world
    }

    fn panel_count(world: &mut World) -> usize {
        world.query::<&GroupPanel>().iter(world).count()
    }

    #[test]
    fn panel_follows_owner_node_and_reclaims_mesh() {
        let mut world = world();
        world
            .resource_mut::<CurrentScene>()
            .0
            .nodes
            .iter_mut()
            .for_each(|node| node.group.as_mut().unwrap().drop_target = false);
        {
            let scene = world.resource::<CurrentScene>().0.clone();
            world.resource_mut::<NodeIndex>().rebuild(&scene);
        }
        // 投影节点实体 + 组件（本系统只消费组件，不建立节点）。
        let entity = world
            .spawn((
                CanvasNodeId("g".into()),
                CanvasLayout {
                    x: 10.,
                    y: 20.,
                    width: 300.,
                    height: 200.,
                },
                CanvasDepth {
                    index: 0,
                    render: 0,
                    z: 10.,
                },
                GroupPresentation {
                    drop_target: false,
                    collapsed: false,
                    badge: false,
                    badge_scale: 1.,
                    member_count: 2,
                    running: false,
                    resizable: false,
                },
            ))
            .id();
        world.run_system_once(sync_group_panels).unwrap();
        world.flush();
        assert_eq!(panel_count(&mut world), 1);
        let (panel_entity, handle) = world
            .query::<(Entity, &GroupPanel)>()
            .iter(&world)
            .map(|(entity, panel)| (entity, panel.mesh.clone()))
            .next()
            .unwrap();
        world.run_system_once(sync_group_panels).unwrap();
        world.flush();
        assert_eq!(panel_count(&mut world), 1, "稳定几何不得重复创建");
        let initial = world.get::<Transform>(panel_entity).unwrap().translation;
        assert_eq!(
            (initial.x, initial.y),
            (10., -20.),
            "组位置由实体 transform 承担"
        );
        // 纯移动：只更新 transform，不重建 mesh；背板不得留在旧位置。
        world.entity_mut(entity).insert(CanvasLayout {
            x: 42.,
            y: 64.,
            width: 300.,
            height: 200.,
        });
        world.run_system_once(sync_group_panels).unwrap();
        world.flush();
        let moved = world.get::<Transform>(panel_entity).unwrap().translation;
        assert_eq!(moved.x, 42.);
        assert_eq!(moved.y, -64.);
        let panel = world.get::<GroupPanel>(panel_entity).unwrap();
        assert_eq!(panel.mesh, handle, "纯位置增量不得重建 mesh");
        // mesh 仍是组本地坐标（0..width），由 transform 搬到 42/64。
        let mesh = world.resource::<Assets<Mesh>>().get(&handle).unwrap();
        let Some(bevy::mesh::VertexAttributeValues::Float32x3(points)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("panel needs positions");
        };
        let min_x = points.iter().map(|point| point[0]).fold(f32::MAX, f32::min);
        let max_x = points.iter().map(|point| point[0]).fold(f32::MIN, f32::max);
        assert!((min_x - 0.).abs() < 0.01 && (max_x - 300.).abs() < 0.01);
        world.entity_mut(entity).insert(CanvasLayout {
            x: 42.,
            y: 64.,
            width: 300.,
            height: 240.,
        });
        world.run_system_once(sync_group_panels).unwrap();
        world.flush();
        let next = world
            .query::<&GroupPanel>()
            .single(&world)
            .unwrap()
            .mesh
            .clone();
        assert_ne!(next, handle, "矩形变化重建 mesh");
        assert!(world.resource::<Assets<Mesh>>().get(&handle).is_none());
        world.entity_mut(entity).remove::<GroupPresentation>();
        world.run_system_once(sync_group_panels).unwrap();
        world.flush();
        assert_eq!(panel_count(&mut world), 0);
        assert!(world.get_entity(panel_entity).is_err());
        assert_eq!(world.resource::<Assets<Mesh>>().len(), 0);
    }
}
