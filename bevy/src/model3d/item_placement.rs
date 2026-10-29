//! Dynamic object placement; static geometry and the scene fit remain stable while editing.
use super::runtime::ModelVisuals;
use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelSnapshot, Scene};
use bevy::prelude::*;

pub(super) fn transform(p: &ModelPlacement) -> Transform {
    Transform {
        translation: Vec3::new(p.offset.x, p.offset.y, p.offset.z),
        rotation: Quat::from_rotation_y(p.yaw.to_radians()),
        scale: Vec3::splat(p.scale),
    }
}

pub(super) fn sync(commands: &mut Commands, models: &mut ModelVisuals, scene: &Scene) {
    for node in &scene.nodes {
        let Some(film_set) = &node.composite_asset else {
            continue;
        };
        let Some(root) = models.roots.get_mut(&node.id) else {
            continue;
        };
        for (id, placement) in &film_set.item_placements {
            let Some(entity) = root.part_entities.get(id) else {
                continue;
            };
            let base = transform(placement);
            root.part_bases.insert(id.clone(), base);
            commands.entity(*entity).insert(base);
        }
    }
    // Group geometry is prepared under its owner. Edit the binding part root,
    // never the independently displayed source card root. Geometry and payload
    // identity remain stable for transform/visibility edits.
    for group in &scene.managed_item_groups {
        let Some(root) = models.roots.get_mut(&group.owner_node_id) else { continue; };
        for binding in &group.items {
            let id = format!("{}:{}", binding.item_id.len(), binding.item_id);
            let Some(entity) = root.part_entities.get(&id) else { continue; };
            let base = Transform {
                translation: Vec3::new(
                    binding.transform.x,
                    binding.transform.y,
                    binding.transform.z,
                ),
                rotation: Quat::from_rotation_y(binding.transform.yaw),
                scale: Vec3::splat(binding.transform.scale),
            };
            root.part_bases.insert(id, base);
            commands.entity(*entity).insert((
                base,
                if binding.visible {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                },
            ));
        }
    }
}

/// Picking uses the same dynamic transforms, but layout still uses the immutable resource bounds.
pub(super) fn snapshot(model: &ModelSnapshot, node: &GraphNode) -> ModelSnapshot {
    let mut live = model.clone();
    if let Some(film_set) = &node.composite_asset {
        for op in &mut live.ops {
            if let ModelOp::Group {
                id,
                position,
                rotation,
                scale,
                ..
            } = op
            {
                if let Some(p) = film_set.item_placements.get(id) {
                    *position = [p.offset.x, p.offset.y, p.offset.z];
                    *rotation = [0.0, p.yaw, 0.0];
                    *scale = [p.scale; 3];
                }
            }
        }
    }
    live
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model3d::layout::{film_set_item_world_aabbs_counted, model_anchor, model_unit};

    #[test]
    fn placement_moves_bounds_without_changing_fit_or_resource() {
        let mut node: GraphNode = serde_json::from_value(serde_json::json!({
            "id":"film", "type":"model", "x":0,"y":0,"width":260,"height":195,
            "compositeAsset":{"x":0,"y":0,"width":260,"height":195,"itemRoots":{"a":"root"}}
        }))
        .unwrap();
        let model: ModelSnapshot = serde_json::from_value(serde_json::json!({
            "sceneVersion":"woohaa-model-scene-ir-v2", "extent":1,
            "ops":[{"t":"group","id":"root"}, {"t":"box","id":"body","parent":"root","size":[1,1,1]}]
        })).unwrap();
        let p = ModelPlacement::default();
        // 计数变体与唯一几何公式共用：取 `[0].1` 即世界 AABB，忽略计数。
        let bounds = |node: &GraphNode| -> crate::model3d::scene::ModelAabb {
            film_set_item_world_aabbs_counted(
                &node,
                &model,
                &p,
                &node.composite_asset.as_ref().unwrap().item_roots,
            )
            .0[0]
                .1
        };
        let unit = model_unit(&node, &model, &p);
        let anchor = model_anchor(&node, &model, &p, unit);
        let before = bounds(&node);
        node.composite_asset
            .as_mut()
            .unwrap()
            .item_placements
            .insert(
                "root".into(),
                ModelPlacement {
                    offset: crate::protocol::ModelOffset {
                        x: 2.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    ..default()
                },
            );
        let after = bounds(&node);
        assert!((after.center().x - before.center().x - 2.0 * unit).abs() < 1e-3);
        assert_eq!(model_unit(&node, &model, &p), unit);
        assert_eq!(model_anchor(&node, &model, &p, unit), anchor);
        assert!((before.half_extents() - after.half_extents()).length() < 1e-3);
    }
}
