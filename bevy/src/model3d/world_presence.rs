//! 共享世界对象的轻量呈现：空模型占位与世界模型选择指示。
//!
//! 世界模型不再拥有内容卡片。`chrome.kind == "none"` 时卡片外壳由 2D producer 抑制，
//! 因此世界对象必须在真实 world pose 处自己表达「可选中/已选中」：
//! - 空模型（没有已注册 Scene IR）在实例根显示地台菱形与竖向指示，可被点选；
//! - 有几何的世界模型在选中/悬停时显示真实 AABB 线框，位置来自同一份渲染 AABB；
//! - 进入模型聚焦后只保留聚焦目标，避免其他对象在地面留下辅助线。
//!
//! 这里只负责呈现与可见性，不参与拾取判定；拾取由 `super::pick` 的真实可见表面
//! 或空模型标记 AABB 派生，两者共用 `layout::world_instance_transform`。

use std::collections::HashMap;
use std::fmt::Write as _;

use bevy::prelude::*;

use crate::protocol::Scene;
use crate::theme::ThemeResource;

use super::layout;

/// 所有世界对象辅助几何的标记；用于生命周期回收与回归断言。
#[derive(Component)]
pub(crate) struct WorldPresenceMarker;

/// 世界空模型/选择指示的 ECS 资源。
#[derive(Resource, Default)]
pub(crate) struct WorldPresence {
    key: Option<String>,
    entities: Vec<Entity>,
    assets: PresenceAssets,
}

#[derive(Default)]
struct PresenceAssets {
    cube: Option<Handle<Mesh>>,
    materials: HashMap<u32, Handle<StandardMaterial>>,
}

impl PresenceAssets {
    fn cube(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.cube
            .get_or_insert_with(|| meshes.add(Cuboid::new(1.0, 1.0, 1.0)))
            .clone()
    }

    fn material(
        &mut self,
        materials: &mut Assets<StandardMaterial>,
        color: u32,
    ) -> Handle<StandardMaterial> {
        self.materials
            .entry(color)
            .or_insert_with(|| {
                materials.add(StandardMaterial {
                    base_color: Color::srgb_u8(
                        (color >> 16) as u8,
                        (color >> 8) as u8,
                        color as u8,
                    ),
                    unlit: true,
                    ..default()
                })
            })
            .clone()
    }
}

/// 世界实例的呈现输入指纹；主题、资源身份和选择/悬停/聚焦都参与。
fn presentation_key(scene: &Scene, theme: &ThemeResource, resources: &HashMap<String, std::sync::Arc<crate::protocol::ModelSnapshot>>) -> String {
    let mut key = String::new();
    let _ = write!(key, "t{};", theme.fingerprint());
    for node in &scene.nodes {
        if node.shared_world_instance.is_none() || !node.chrome.is_none() {
            continue;
        }
        let _ = write!(
            key,
            "{}:{}{}:",
            node.id,
            scene.selection.nodes.contains(&node.id) as u8,
            scene
                .hover
                .as_ref()
                .and_then(|hover| hover.node_id.as_deref())
                == Some(node.id.as_str())
        );
        if let Some(transform) = layout::world_instance_transform(node) {
            let _ = write!(
                key,
                "{:.4},{:.4},{:.4}/{:.4},{:.4},{:.4},{:.4}/{:.4};",
                transform.translation.x,
                transform.translation.y,
                transform.translation.z,
                transform.rotation.x,
                transform.rotation.y,
                transform.rotation.z,
                transform.rotation.w,
                transform.scale.x
            );
        }
        match node
            .model
            .as_ref()
            .and_then(|reference| resources.get(&reference.resource_key))
        {
            Some(resource) => {
                let _ = write!(key, "m{:x};", std::sync::Arc::as_ptr(resource) as usize);
            }
            None => key.push_str("empty;"),
        }
    }
    key.push_str(scene.model_focus.as_ref().map_or("-", |focus| focus.node_id.as_str()));
    key
}

/// 按 accepted scene 重建世界对象辅助几何。
///
/// 调用方只在场景/资源/主题/选择可能变化时运行；函数内部仍以指纹去重，静止帧只做一次
/// 轻量签名比较，不重建 mesh/材质。
pub(crate) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    scene: &Scene,
    theme: &ThemeResource,
    resources: &HashMap<String, std::sync::Arc<crate::protocol::ModelSnapshot>>,
    presence: &mut WorldPresence,
) {
    let key = presentation_key(scene, theme, resources);
    if presence.key.as_deref() == Some(key.as_str()) {
        return;
    }
    presence.key = Some(key);
    for entity in presence.entities.drain(..) {
        commands.entity(entity).try_despawn();
    }
    let cube = presence.assets.cube(meshes);
    let focus = scene.model_focus.as_ref().map(|focus| focus.node_id.as_str());
    for node in &scene.nodes {
        if node.shared_world_instance.is_none() || !node.chrome.is_none() {
            continue;
        }
        // 聚焦时只保留目标对象；其他世界对象由模型可见性系统隐藏。
        if focus.is_some() && focus != Some(node.id.as_str()) {
            continue;
        }
        let Some(transform) = layout::world_instance_transform(node) else {
            continue;
        };
        let selected = scene.selection.nodes.iter().any(|id| id == &node.id);
        let hovered = scene
            .hover
            .as_ref()
            .and_then(|hover| hover.node_id.as_deref())
            == Some(node.id.as_str());
        let resource = node
            .model
            .as_ref()
            .and_then(|reference| resources.get(&reference.resource_key));
        match resource {
            Some(model) => {
                if !selected && !hovered {
                    continue;
                }
                let Some(placement) = node.model.as_ref().map(|reference| &reference.placement) else {
                    continue;
                };
                let Some((aabb, anchor)) = layout::model_bounds_for_node(model, placement, node) else {
                    continue;
                };
                let min = Vec3::new(
                    aabb.min[0] + anchor.x,
                    aabb.min[1] + anchor.y,
                    aabb.min[2] + anchor.z,
                );
                let max = Vec3::new(
                    aabb.max[0] + anchor.x,
                    aabb.max[1] + anchor.y,
                    aabb.max[2] + anchor.z,
                );
                if !min.is_finite() || !max.is_finite() {
                    continue;
                }
                let color = if selected {
                    theme.token_u32("canvasNodeBorderSelected")
                } else {
                    theme.token_u32("canvasPortDefault")
                };
                spawn_aabb_edges(commands, presence, &cube, materials, color, min, max);
                spawn_ground_diamond(
                    commands,
                    presence,
                    &cube,
                    materials,
                    color,
                    Vec3::new((min.x + max.x) * 0.5, min.y, (min.z + max.z) * 0.5),
                    ((max.x - min.x).max(max.z - min.z) * 0.55).max(16.0),
                    transform.scale.x * 0.008,
                );
            }
            None => {
                // 空模型/资源未就绪：真实实例根处的轻量占位，不是内容卡片。
                let color = if selected {
                    theme.token_u32("canvasNodeBorderSelected")
                } else {
                    theme.token_u32("canvasPortDefault")
                };
                let unit = transform.scale.x.abs().max(1.0);
                let ground = Vec3::new(
                    transform.translation.x,
                    transform.translation.y,
                    transform.translation.z,
                );
                spawn_ground_diamond(
                    commands,
                    presence,
                    &cube,
                    materials,
                    color,
                    ground,
                    unit * 0.55,
                    (unit * 0.008).clamp(0.8, 8.0),
                );
                // 竖杆 + 顶端方块：等距视角下可从地面范围里辨认这一锚点。
                let height = unit * 0.9;
                let pin = commands
                    .spawn((
                        WorldPresenceMarker,
                        Mesh3d(cube.clone()),
                        MeshMaterial3d(presence.assets.material(materials, color)),
                        Transform::from_xyz(ground.x, ground.y + height * 0.5, ground.z)
                            .with_scale(Vec3::new(
                                (unit * 0.035).clamp(0.6, 6.0),
                                height,
                                (unit * 0.035).clamp(0.6, 6.0),
                            )),
                        Visibility::Inherited,
                    ))
                    .id();
                presence.entities.push(pin);
                let cap = commands
                    .spawn((
                        WorldPresenceMarker,
                        Mesh3d(cube.clone()),
                        MeshMaterial3d(presence.assets.material(materials, color)),
                        Transform::from_xyz(ground.x, ground.y + height, ground.z).with_scale(
                            Vec3::splat((unit * 0.09).clamp(2.0, 14.0)),
                        ),
                        Visibility::Inherited,
                    ))
                    .id();
                presence.entities.push(cap);
            }
        }
    }
}

fn spawn_aabb_edges(
    commands: &mut Commands,
    presence: &mut WorldPresence,
    cube: &Handle<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    color: u32,
    min: Vec3,
    max: Vec3,
) {
    let extent = (max - min).abs();
    let thickness = (extent.max_element() * 0.006).clamp(1.2, 6.0);
    // 稍微外扩线框，避免与模型表面共面 z-fighting；仍围绕真实 AABB，不改模型高度。
    let pad = thickness * 0.5;
    let min = min - Vec3::splat(pad);
    let max = max + Vec3::splat(pad);
    let extent = (max - min).abs();
    let material = presence.assets.material(materials, color);
    let center = (min + max) * 0.5;
    let mut push = |translation: Vec3, scale: Vec3| {
        let entity = commands
            .spawn((
                WorldPresenceMarker,
                Mesh3d(cube.clone()),
                MeshMaterial3d(material.clone()),
                Transform::from_translation(translation).with_scale(scale),
                Visibility::Inherited,
            ))
            .id();
        presence.entities.push(entity);
    };
    for x in [min.x, max.x] {
        for y in [min.y, max.y] {
            push(
                Vec3::new(x, y, center.z),
                Vec3::new(thickness, thickness, extent.z.max(thickness)),
            );
        }
    }
    for x in [min.x, max.x] {
        for z in [min.z, max.z] {
            push(
                Vec3::new(x, center.y, z),
                Vec3::new(thickness, extent.y.max(thickness), thickness),
            );
        }
    }
    for y in [min.y, max.y] {
        for z in [min.z, max.z] {
            push(
                Vec3::new(center.x, y, z),
                Vec3::new(extent.x.max(thickness), thickness, thickness),
            );
        }
    }
}

fn spawn_ground_diamond(
    commands: &mut Commands,
    presence: &mut WorldPresence,
    cube: &Handle<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    color: u32,
    center: Vec3,
    radius: f32,
    thickness: f32,
) {
    if !radius.is_finite() || radius <= 0.0 {
        return;
    }
    let thickness = thickness.max(0.6);
    let material = presence.assets.material(materials, color);
    let edge = radius * std::f32::consts::SQRT_2;
    // 四个边：((中心, 绕 Y 旋转), ...) 组成贴地菱形。
    for (dx, dz, yaw) in [
        (radius * 0.5, radius * 0.5, 45.0_f32),
        (radius * 0.5, -radius * 0.5, 135.0),
        (-radius * 0.5, -radius * 0.5, -135.0),
        (-radius * 0.5, radius * 0.5, -45.0),
    ] {
        let entity = commands
            .spawn((
                WorldPresenceMarker,
                Mesh3d(cube.clone()),
                MeshMaterial3d(material.clone()),
                Transform::from_xyz(center.x + dx, center.y, center.z + dz)
                    .with_rotation(Quat::from_rotation_y(yaw.to_radians()))
                    .with_scale(Vec3::new(edge, thickness, thickness)),
                Visibility::Inherited,
            ))
            .id();
        presence.entities.push(entity);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{GraphNode, ModelOp, ModelSnapshot, NodeChrome};
    use std::sync::Arc;

    #[derive(Resource)]
    struct TestScene(Scene);
    #[derive(Resource, Default)]
    struct TestResources(HashMap<String, Arc<ModelSnapshot>>);

    fn snapshot() -> ModelSnapshot {
        ModelSnapshot::new(
            Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            vec![ModelOp::Box {
                id: "body".to_owned(),
                parent: None,
                position: [0.0, 1.0, 0.0],
                rotation: [0.0, 0.0, 0.0],
                scale: [1.0; 3],
                color: Some("#ffffff".to_owned()),
                material: None,
                size: [2.0, 2.0, 2.0],
            }],
            "sig".to_owned(),
            2.0,
            Default::default(),
        )
    }

    fn run_sync(
        mut commands: Commands,
        mut meshes: ResMut<Assets<Mesh>>,
        mut materials: ResMut<Assets<StandardMaterial>>,
        scene: Res<TestScene>,
        resources: Res<TestResources>,
        mut presence: ResMut<WorldPresence>,
    ) {
        sync(
            &mut commands,
            &mut meshes,
            &mut materials,
            &scene.0,
            &ThemeResource::default(),
            &resources.0,
            &mut presence,
        );
    }

    fn marker_count(app: &mut App) -> usize {
        let world = app.world_mut();
        let mut query = world.query_filtered::<Entity, With<WorldPresenceMarker>>();
        query.iter(world).count()
    }

    fn world_node(chrome: NodeChrome) -> GraphNode {
        serde_json::from_value(serde_json::json!({
            "id": "world", "type": "model3d", "x": 900.0, "y": 900.0,
            "width": 10.0, "height": 10.0,
            "chrome": match &chrome {
                NodeChrome::Card => serde_json::json!({"kind":"card"}),
                NodeChrome::Frame { group_id, member_node_ids } => serde_json::json!({
                    "kind": "frame", "groupId": group_id, "memberNodeIds": member_node_ids
                }),
                NodeChrome::None => serde_json::json!({"kind":"none"}),
            },
            "sharedWorldInstance": {
                "kind": "world-instance", "version": "shared-world-v1",
                "instanceId": "i",
                "transform": {"version":"shared-world-v1",
                    "position":{"u":2,"v":3,"h":1},"rotation":[0,0,0,1],"scale":1.5}
            }
        }))
        .unwrap()
    }

    #[test]
    fn production_sync_spawns_marker_for_empty_world_and_selection_box_for_model() {
        let mut app = App::new();
        app.init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .init_resource::<WorldPresence>()
            .init_resource::<TestResources>()
            .insert_resource(TestScene(Scene {
                nodes: vec![world_node(NodeChrome::None)],
                ..Scene::default()
            }))
            .add_systems(Update, run_sync);
        app.update();
        assert_eq!(marker_count(&mut app), 6);

        let mut scene = Scene {
            nodes: vec![world_node(NodeChrome::None)],
            ..Scene::default()
        };
        scene.nodes[0].model = Some(serde_json::from_value(serde_json::json!({
            "resourceKey": "v:sig"
        })).unwrap());
        scene.selection.nodes = vec![scene.nodes[0].id.clone()];
        app.world_mut().resource_mut::<TestScene>().0 = scene;
        app.world_mut()
            .resource_mut::<TestResources>()
            .0
            .insert("v:sig".into(), Arc::new(snapshot()));
        app.update();
        assert_eq!(marker_count(&mut app), 16);
    }

    #[test]
    fn card_nodes_do_not_claim_world_presence() {
        let scene = Scene { nodes: vec![world_node(NodeChrome::Card)], ..Scene::default() };
        let theme = ThemeResource::default();
        let key = presentation_key(&scene, &theme, &HashMap::new());
        assert_eq!(key, format!("t{};-", theme.fingerprint()));
    }

    #[test]
    fn empty_world_anchor_uses_instance_pose_not_card() {
        let scene = Scene { nodes: vec![world_node(NodeChrome::None)], ..Scene::default() };
        let transform = layout::world_instance_transform(&scene.nodes[0]).unwrap();
        assert!((transform.translation.x - 128.0).abs() < 0.001);
        assert!((transform.translation.y - 64.0).abs() < 0.001);
        assert!((transform.translation.z + 192.0).abs() < 0.001);
        assert_eq!(transform.scale.x, 96.0);
    }
}
