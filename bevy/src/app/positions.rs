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
}
