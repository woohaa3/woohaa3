use crate::model3d::{
    grid,
    layout::{model_anchor, model_unit},
    scene,
};
use crate::protocol::{GraphNode, ModelAabbDto, ModelPlacement, ModelSnapshot};
use bevy::prelude::*;

#[test]
fn saved_object_bounds_and_maximum_whole_scale_fit_every_model_in_the_frame() {
    let mut node: GraphNode = serde_json::from_str(r#"{
      "id":"film","type":"model","x":100,"y":200,"width":260,"height":195,
      "compositeAsset":{"x":100,"y":200,"width":260,"height":195,
        "itemPlacements":{"left":{"offset":{"x":-10,"y":0,"z":0},"scale":2,"yaw":25},"right":{"offset":{"x":10,"y":5,"z":8},"scale":4,"yaw":-40}}}
    }"#).unwrap();
    let model: ModelSnapshot = serde_json::from_str(r#"{"signature":"model","extent":2,"ops":[
      {"t":"group","id":"left","parent":null,"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]},
      {"t":"box","id":"a","parent":"left","position":[0,1,0],"rotation":[0,0,0],"scale":[1,1,1],"size":[2,2,2]},
      {"t":"group","id":"right","parent":null,"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]},
      {"t":"box","id":"b","parent":"right","position":[0,1,0],"rotation":[0,0,0],"scale":[1,1,1],"size":[2,2,2]}
    ]}"#).unwrap();
    let live = crate::model3d::item_placement::snapshot(&model, &node);
    let local = scene::model_local_aabb(&live).unwrap();
    node.composite_asset.as_mut().unwrap().layout_aabb = Some(ModelAabbDto {
        min: local.min,
        max: local.max,
    });
    for scale in [0.2, 1.0, 4.0, 100.0] {
        for yaw in [0.0, 37.0, 125.0] {
            let placement = ModelPlacement {
                scale,
                yaw,
                offset: crate::protocol::ModelOffset {
                    x: 100.0,
                    y: -100.0,
                    z: 0.0,
                },
            };
            let unit = model_unit(&node, &model, &placement);
            let anchor = model_anchor(&node, &model, &placement, unit);
            for x in [local.min[0], local.max[0]] {
                for y in [local.min[1], local.max[1]] {
                    for z in [local.min[2], local.max[2]] {
                        let world = anchor
                            + Quat::from_rotation_y(yaw.to_radians()) * Vec3::new(x, y, z) * unit;
                        let screen = grid::view_rotation() * world;
                        assert!(
                            screen.x >= 116.0 - 0.001 && screen.x <= 344.0 + 0.001,
                            "{scale} {yaw}: {screen:?}"
                        );
                        assert!(
                            -screen.y >= 216.0 - 0.001 && -screen.y <= 379.0 + 0.001,
                            "{scale} {yaw}: {screen:?}"
                        );
                    }
                }
            }
            if scale >= 1.0 {
                let maximum = model_unit(
                    &node,
                    &model,
                    &ModelPlacement {
                        scale: 1.0,
                        ..placement
                    },
                );
                assert!((unit - maximum).abs() < 0.0001);
            }
        }
    }
}
