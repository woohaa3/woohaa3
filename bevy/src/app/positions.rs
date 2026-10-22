//! Stable full-scene slots and scope offsets; position frames touch moved IDs only.
use crate::protocol::{NodePosition, Scene};
use bevy::prelude::*;
use std::collections::HashMap;

#[derive(Resource, Default)]
pub(crate) struct PositionIndex(HashMap<String, (usize, Option<Vec2>)>);
impl PositionIndex {
    pub(super) fn reset(&mut self, scene: &Scene) {
        self.0 = scene
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| {
                (
                    n.id.clone(),
                    (
                        i,
                        n.composite_asset
                            .as_ref()
                            .map(|s| Vec2::new(s.x - n.x, s.y - n.y)),
                    ),
                )
            })
            .collect();
    }
    pub(super) fn apply(&self, scene: &mut Scene, positions: HashMap<String, NodePosition>) {
        for (id, p) in positions {
            let Some(&(index, offset)) = self.0.get(&id) else {
                continue;
            };
            let node = &mut scene.nodes[index];
            node.x = p.x;
            node.y = p.y;
            if let (Some(scope), Some(offset)) = (&mut node.composite_asset, offset) {
                scope.x = p.x + offset.x;
                scope.y = p.y + offset.y;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::{CurrentScene, FilmSetTextureBatch, FrameFlags, ModelAssetTable, TextureBatch},
        bridge,
        theme::ThemeResource,
    };
    use bevy::ecs::system::RunSystemOnce;

    fn scene() -> Scene {
        Scene {
            nodes: serde_json::from_value(serde_json::json!([
                {"id":"a","type":"text","x":0,"y":0},
                {"id":"film","type":"model","x":100,"y":200,
                    "compositeAsset":{"x":120,"y":240,"width":300,"height":200}}
            ]))
            .unwrap(),
            ..default()
        }
    }
    fn row(id: &str, x: f32, y: f32) -> NodePosition {
        NodePosition {
            id: id.into(),
            x,
            y,
        }
    }
    #[test]
    fn merged_positions_and_viewport_apply_after_pending_full_scene() {
        let mut world = World::new();
        world.insert_resource(CurrentScene::default());
        world.insert_resource(PositionIndex::default());
        world.insert_resource(FrameFlags::default());
        world.insert_resource(ModelAssetTable::default());
        world.insert_resource(TextureBatch::default());
        world.insert_resource(FilmSetTextureBatch::default());
        world.insert_resource(ThemeResource::default());
        world.insert_resource(ClearColor::default());
        bridge::queue_scene(scene());
        bridge::queue_positions(vec![row("a", 40., 50.), row("film", 200., 300.)], None);
        bridge::queue_viewport(crate::protocol::Viewport {
            x: 20.,
            y: 30.,
            zoom: 0.5,
        });
        bridge::queue_positions(vec![row("a", 70., 80.)], None);
        world
            .run_system_once(crate::app::input::ingest_bridge)
            .unwrap();
        let current = &world.resource::<CurrentScene>().0;
        assert_eq!((current.nodes[0].x, current.nodes[0].y), (70., 80.));
        assert_eq!((current.nodes[1].x, current.nodes[1].y), (200., 300.));
        let scope = current.nodes[1].composite_asset.as_ref().unwrap();
        assert_eq!((scope.x, scope.y), (220., 340.));
        assert_eq!(
            (
                current.viewport.x,
                current.viewport.y,
                current.viewport.zoom
            ),
            (20., 30., 0.5)
        );
        let flags = world.resource::<FrameFlags>();
        assert!(flags.scene_received && flags.positions_received);
        assert!(!flags.viewport_only);
        bridge::queue_positions(vec![row("a", 300., 400.)], None);
        bridge::queue_scene(scene()); // later full replaces every preceding increment
        world
            .run_system_once(crate::app::input::ingest_bridge)
            .unwrap();
        assert_eq!(world.resource::<CurrentScene>().0.nodes[0].x, 0.);
        assert!(!world.resource::<FrameFlags>().positions_received);
    }
    #[test]
    fn scope_translation_uses_full_baseline_offset_without_accumulating_drift() {
        let mut scene = scene();
        let mut index = PositionIndex::default();
        index.reset(&scene);
        for i in 0..200 {
            let x = i as f32 * 0.13;
            let y = i as f32 * 0.17;
            index.apply(
                &mut scene,
                HashMap::from([("film".into(), row("film", x, y))]),
            );
            let scope = scene.nodes[1].composite_asset.as_ref().unwrap();
            assert_eq!((scope.x, scope.y), (x + 20., y + 40.));
        }
    }
}
