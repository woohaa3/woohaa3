#![cfg(feature = "canvas-core")]

use woohaa_bevy_canvas::{base_scene_generation, set_scene};

#[test]
fn scene_boundary_rejects_invalid_world_data_without_replacing_accepted_scene() {
    let fixture = include_str!("fixtures/shared-world/render-scene.json");
    assert_eq!(woohaa_bevy_canvas::golden_api::shared_world_projection(fixture).unwrap(),
        ([160.0, 80.0, 192.0], [0.5, 0.5, -0.5, 0.5], 1.75));
    let generation = set_scene(fixture).unwrap();
    let original: serde_json::Value = serde_json::from_str(fixture).unwrap();
    for change in ["version", "missing", "scale", "null", "extra", "scene-version"] {
        let mut bad = original.clone();
        let instance = &mut bad["nodes"][0]["sharedWorldInstance"];
        match change {
            "version" => instance["transform"]["version"] = "future".into(),
            "missing" => { instance["transform"].as_object_mut().unwrap().remove("rotation"); },
            "scale" => instance["transform"]["scale"] = 0.into(),
            "null" => *instance = serde_json::Value::Null,
            "extra" => instance["extra"] = true.into(),
            _ => bad["version"] = "future".into(),
        }
        assert!(set_scene(&bad.to_string()).is_err(), "{change}");
        assert_eq!(base_scene_generation(), generation, "{change}");
    }
    let mut legacy = original;
    legacy["nodes"][0].as_object_mut().unwrap().remove("sharedWorldInstance");
    assert!(set_scene(&legacy.to_string()).is_ok());
}
