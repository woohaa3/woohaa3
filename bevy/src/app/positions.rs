//! Stable full-scene slots; position frames touch moved IDs only.
use crate::protocol::{NodePosition, Scene};
use bevy::prelude::*;
use std::collections::HashMap;

#[derive(Resource, Default)]
pub(crate) struct PositionIndex(HashMap<String, usize>);
impl PositionIndex {
    pub(super) fn reset(&mut self, scene: &Scene) {
        self.0 = scene
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.clone(), i))
            .collect();
    }
    pub(super) fn apply(&self, scene: &mut Scene, positions: HashMap<String, NodePosition>) {
        for (id, p) in positions {
            let Some(&index) = self.0.get(&id) else {
                continue;
            };
            let node = &mut scene.nodes[index];
            node.x = p.x;
            node.y = p.y;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_move_body_and_ignore_unknown_ids() {
        let mut scene = Scene::default();
        scene.nodes.push(
            serde_json::from_value(serde_json::json!({
                "id":"a","type":"text","x":10,"y":20,"width":100,"height":50
            }))
            .unwrap(),
        );
        let mut index = PositionIndex::default();
        index.reset(&scene);
        index.apply(
            &mut scene,
            [(
                "a".to_owned(),
                NodePosition {
                    id: "a".into(),
                    x: 40.0,
                    y: 60.0,
                },
            )]
            .into_iter()
            .collect(),
        );
        assert_eq!((scene.nodes[0].x, scene.nodes[0].y), (40.0, 60.0));
    }

    #[test]
    fn position_increment_does_not_reanchor_shared_world_model() {
        use crate::model3d::{sync_models, FocusVisuals, ModelVisuals};
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
        node.model = Some(ModelReference { ground_anchor_local: None, part_rotations: None,
            resource_key: "s".into(),
            scene_version: snapshot.scene_version.clone(),
            signature: "s".into(),
            placement: ModelPlacement::default(),
        });
        let assets = [("s".to_owned(), Arc::new(snapshot))].into_iter().collect();
        let mut scene = Scene {
            nodes: vec![node],
            ..Scene::default()
        };
        let mut index = PositionIndex::default();
        index.reset(&scene);
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
        index.apply(
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
