//! 片场对象 child 运动投影测试
//! （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 5.1/5.2/7.2）。

use super::super::motion::validate;
use crate::protocol::{AnimationPlayback, ManagedItemMotion, ManagedItemMotionPlayback};

fn object(playback: ManagedItemMotionPlayback) -> ManagedItemMotion {
    ManagedItemMotion {
        item_id: "a".into(),
        playback,
        model_motion: Vec::new(),
        part_ids: std::collections::HashMap::new(),
    }
}

fn config(start_time: f32, duration: f32, time_scale: f32, looped: bool) -> ManagedItemMotionPlayback {
    ManagedItemMotionPlayback {
        start_time,
        duration,
        time_scale,
        looped,
    }
}

#[test]
fn local_time_maps_delay_scale_clamp_and_loop() {
    // 延迟开始：T < startTime 返回 None（显示基础姿态）。
    assert_eq!(object(config(2.0, 3.0, 1.0, false)).local_time(1.0), None);
    // 变速：T=3, startTime=2, timeScale=2 → u=2。
    assert_eq!(
        object(config(2.0, 3.0, 2.0, false)).local_time(3.0),
        Some(2.0)
    );
    // 非循环钳制末帧。
    assert_eq!(
        object(config(0.0, 3.0, 1.0, false)).local_time(5.0),
        Some(3.0)
    );
    // 循环取模。
    let looped = object(config(0.0, 3.0, 1.0, true)).local_time(7.0).unwrap();
    assert!((looped - 1.0).abs() < 1e-5);
    // 非法 timeScale 回退 1。
    assert_eq!(
        object(config(0.0, 3.0, 0.0, false)).local_time(1.0),
        Some(1.0)
    );
}

#[test]
fn object_motion_validates_targets_and_evaluates() {
    // 对象动作轨道目标由 part_ids 解析；求值在 local_time。
    let track = serde_json::json!({
        "id": "t",
        "targetId": "root",
        "startTime": 0,
        "endTime": 3,
        "motion": { "kind": "move", "axis": "x", "speed": 1, "range": [0, 1] }
    });
    let motion: crate::motion::RawModelTrack = serde_json::from_value(track).expect("track");
    let ir = validate("woohaa-motion-ir-v1", Vec::new(), vec![motion], 3.0).expect("valid");
    let (_camera, deltas) = crate::motion::evaluate(
        &ir,
        2.0,
        crate::motion::camera_state_from_arrays(0.0, 0.0, 8.0, [0.0, 0.0, 0.0]),
    );
    assert_eq!(deltas.len(), 1);
    assert_eq!(deltas[0].0, "root");
}

#[test]
fn animation_playback_parses_managed_item_motion_projection() {
    // 线格式：animationPlayback.managedItemMotion 反序列化出条目运动投影（camelCase itemId/partIds）。
    let json = serde_json::json!({
        "nodeId": "anim",
        "version": "woohaa-motion-ir-v1",
        "time": 1.0,
        "duration": 4.0,
        "initialCamera": { "azimuth": 0.0, "elevation": 0.7, "distance": 8.0, "focusOffset": [0,0,0] },
        "managedItemMotion": [{
            "itemId": "a",
            "playback": { "startTime": 0.0, "duration": 3.0, "timeScale": 1.0, "loop": true },
            "modelMotion": [],
            "partIds": { "root": "1:a" }
        }]
    });
    let playback: AnimationPlayback = serde_json::from_value(json).expect("playback");
    assert_eq!(playback.managed_item_motion.len(), 1);
    assert_eq!(playback.managed_item_motion[0].item_id, "a");
    assert_eq!(playback.managed_item_motion[0].part_ids.get("root").map(String::as_str), Some("1:a"));
    assert!(playback.managed_item_motion[0].playback.looped);
}
