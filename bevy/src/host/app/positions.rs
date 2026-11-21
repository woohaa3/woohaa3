//! 位置增量只改已索引节点的坐标，不另建 `nodeId → 下标`。
//!
//! 下标来自同代 [`super::NodeIndex`]：完整场景接受时由 `ingest_bridge` 重建，
//! 纯位置帧不重建。未知 id 跳过。重复 id 用末下标（旧 `PositionIndex`）；
//! 查询仍用首下标。`Scene::validate` 不拒绝重复节点 id。
use crate::protocol::{NodePosition, Scene};
use std::collections::HashMap;

use super::NodeIndex;

/// 把位置增量写进同代场景。索引缺失或下标对不上该 id 时跳过，不插入新节点。
pub(super) fn apply(
    index: &NodeIndex,
    scene: &mut Scene,
    positions: HashMap<String, NodePosition>,
) -> Vec<String> {
    let mut changed = Vec::with_capacity(positions.len());
    for (id, position) in positions {
        let Some(slot) = index.position_last(&id) else {
            continue;
        };
        let Some(node) = scene.nodes.get_mut(slot) else {
            continue;
        };
        if node.id != id {
            continue;
        }
        if node.x == position.x && node.y == position.y {
            continue;
        }
        node.x = position.x;
        node.y = position.y;
        changed.push(id);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::prelude::*;

    #[test]
    fn positions_move_body_and_ignore_unknown_ids() {
        let mut scene = Scene::default();
        scene.nodes.push(
            serde_json::from_value(serde_json::json!({
                "id":"a","type":"text","x":10,"y":20,"width":100,"height":50
            }))
            .unwrap(),
        );
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        apply(
            &index,
            &mut scene,
            [
                (
                    "a".to_owned(),
                    NodePosition {
                        id: "a".into(),
                        x: 40.0,
                        y: 60.0,
                    },
                ),
                (
                    "missing".to_owned(),
                    NodePosition {
                        id: "missing".into(),
                        x: 1.0,
                        y: 2.0,
                    },
                ),
            ]
            .into_iter()
            .collect(),
        );
        assert_eq!(scene.nodes.len(), 1);
        assert_eq!((scene.nodes[0].x, scene.nodes[0].y), (40.0, 60.0));
        assert_eq!(index.position("a"), Some(0));
        assert_eq!(index.position("missing"), None);
    }

    #[test]
    fn accepted_moves_mark_only_affected_document_and_incident_edge_blocks() {
        let mut scene = Scene::default();
        scene.nodes = (0..35)
            .map(|i| {
                serde_json::from_value(serde_json::json!({
                "id": format!("n{i}"), "type":"text", "x":i, "y":0
                    }))
                .unwrap()
            })
            .collect();
        scene.edges = (0..34)
            .map(|i| {
                serde_json::from_value(serde_json::json!({
                "id":format!("e{i}"), "source":format!("n{i}"), "target":format!("n{}", i + 1)
                    }))
                .unwrap()
            })
            .collect();
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        let edges = crate::canvas_runtime::EdgeIndex::build(&scene.edges);
        let changed = apply(
            &index,
            &mut scene,
            [
                (
                    "n17".into(),
                    NodePosition {
                        id: "n17".into(),
                        x: 300.,
                        y: 2.,
                    },
                ),
                (
                    "n20".into(),
                    NodePosition {
                        id: "n20".into(),
                        x: 20.,
                        y: 0.,
                    },
                ),
                (
                    "missing".into(),
                    NodePosition {
                        id: "missing".into(),
                        x: 1.,
                        y: 1.,
                    },
                ),
            ]
            .into_iter()
            .collect(),
        );
        let mut changes = crate::canvas_runtime::ChangeSet::default();
        changes.add_positions(&changed, &index, &edges);
        assert_eq!(changed, vec!["n17"]);
        assert_eq!(changes.card_blocks.into_iter().collect::<Vec<_>>(), vec![1]);
        assert_eq!(
            changes.incident_edges.into_iter().collect::<Vec<_>>(),
            vec![16, 17]
        );
        assert_eq!(changes.edge_blocks.into_iter().collect::<Vec<_>>(), vec![1]);
        assert_eq!(scene.nodes[17].x, 300.);
    }

    #[test]
    fn duplicate_id_follows_node_index_and_rebuild_drops_stale_slots() {
        let mut scene = Scene::default();
        scene.nodes.extend([
            serde_json::from_value(serde_json::json!({
                "id":"a","type":"text","x":1,"y":2,"width":10,"height":10
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "id":"a","type":"text","x":3,"y":4,"width":10,"height":10
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "id":"b","type":"text","x":5,"y":6,"width":10,"height":10
            }))
            .unwrap(),
        ]);
        scene.version = crate::protocol::CANVAS_RENDER_SCENE_VERSION.to_owned();
        assert_eq!(
            scene.validate(),
            Ok(()),
            "Scene::validate 不拒绝重复节点 id"
        );
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        assert_eq!(index.position("a"), Some(0), "查询取首项");
        assert_eq!(index.position_last("a"), Some(1), "位置增量取末项");
        apply(
            &index,
            &mut scene,
            [(
                "a".into(),
                NodePosition {
                    id: "a".into(),
                    x: 9.0,
                    y: 8.0,
                },
            )]
            .into_iter()
            .collect(),
        );
        assert_eq!(
            (scene.nodes[0].x, scene.nodes[0].y),
            (1.0, 2.0),
            "查询首项不被位置增量改写"
        );
        assert_eq!((scene.nodes[1].x, scene.nodes[1].y), (9.0, 8.0));

        scene.nodes.remove(2);
        scene.nodes.remove(1);
        scene.nodes[0].x = 0.0;
        scene.nodes[0].y = 2.0;
        index.rebuild(&scene);
        assert_eq!(index.position("b"), None);
        apply(
            &index,
            &mut scene,
            [(
                "b".into(),
                NodePosition {
                    id: "b".into(),
                    x: 7.0,
                    y: 7.0,
                },
            )]
            .into_iter()
            .collect(),
        );
        assert_eq!(scene.nodes.len(), 1);
        assert_eq!((scene.nodes[0].x, scene.nodes[0].y), (0.0, 2.0));
    }

    #[test]
    fn position_increment_does_not_reanchor_shared_world_model() {
        use crate::model3d::{FocusVisuals, ModelVisuals, sync_models};
        use crate::protocol::{ModelOp, ModelPlacement, ModelReference, ModelSnapshot};
        use std::sync::Arc;
        let mut node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({
            "id":"a", "type":"model", "x":10, "y":20, "width":100, "height":50,
            "sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i",
                "transform":{"version":"shared-world-v1","position":{"u":1,"v":2,"h":3},"rotation":[0,0,0,1],"scale":1}}
        })).unwrap();
        let snapshot = ModelSnapshot {
            scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.into()),
            ops: vec![ModelOp::Sphere {
                id: "s".into(),
                parent: None,
                position: [0.; 3],
                rotation: [0.; 3],
                scale: [1.; 3],
                color: Some("#ffffff".into()),
                material: None,
                radius: 1.,
            }],
            signature: "s".into(),
            extent: 2.,
            aabb: None,
            geometry_keys: None,
            prepared_bounds: None,
            placement: ModelPlacement::default(),
        };
        node.model = Some(ModelReference {
            ground_anchor_local: None,
            part_rotations: None,
            part_positions: None,
            resource_key: "s".into(),
            scene_version: snapshot.scene_version.clone(),
            signature: "s".into(),
        });
        let assets = [("s".to_owned(), Arc::new(snapshot))].into_iter().collect();
        let mut scene = Scene {
            nodes: vec![node],
            ..Scene::default()
        };
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        let mut world = World::new();
        let mut visuals = ModelVisuals::default();
        let mut focus = FocusVisuals::default();
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<StandardMaterial>::default();
        let sync = |world: &mut World,
                    visuals: &mut ModelVisuals,
                    focus: &mut FocusVisuals,
                    meshes: &mut Assets<Mesh>,
                    materials: &mut Assets<StandardMaterial>,
                    scene: &Scene| {
            sync_models(
                &mut world.commands(),
                meshes,
                materials,
                visuals,
                focus,
                &assets,
                scene,
            );
            world.flush();
        };
        sync(
            &mut world,
            &mut visuals,
            &mut focus,
            &mut meshes,
            &mut materials,
            &scene,
        );
        let mut query = world.query_filtered::<&Transform, With<crate::model3d::ModelAnchor>>();
        let before = *query.single(&world).unwrap();
        apply(
            &index,
            &mut scene,
            [(
                "a".into(),
                NodePosition {
                    id: "a".into(),
                    x: 900.,
                    y: -200.,
                },
            )]
            .into_iter()
            .collect(),
        );
        sync(
            &mut world,
            &mut visuals,
            &mut focus,
            &mut meshes,
            &mut materials,
            &scene,
        );
        assert_eq!(*query.single(&world).unwrap(), before);
        assert_eq!(before.translation, Vec3::new(64., 192., -128.));
    }
}
