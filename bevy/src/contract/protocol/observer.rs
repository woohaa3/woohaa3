//! 聚焦观察镜头增量 wire 协议。
//!
//! 已聚焦节点仅朝向变化时用固定大小的 `set_observer` 替代完整 `set_scene`。
//! 本模块只做边界校验；base / 聚焦门禁在 `canvas_query` 接受点原子判断。

use serde::Deserialize;

use super::scene::Scene;

/// 与 contracts `CANVAS_OBSERVER_UPDATE_VERSION` 一致，结构变化必须升版本。
///
/// v2 删除了卡片预览姿态（`preview`）：模型聚焦只使用世界包围盒取景。
pub(crate) const CANVAS_OBSERVER_UPDATE_VERSION: &str = "woohaa-canvas-observer-v2";

/// 固定大小观察镜头增量请求（`set_observer` JSON 输入）。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObserverUpdateRequest {
    pub(crate) version: String,
    pub(crate) base_scene_generation: u32,
    pub(crate) node_id: String,
    pub(crate) yaw: f32,
    pub(crate) pitch: f32,
    pub(crate) distance: f32,
    pub(crate) target: [f32; 3],
}

impl ObserverUpdateRequest {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != CANVAS_OBSERVER_UPDATE_VERSION {
            return Err("Unsupported observer update version");
        }
        if self.node_id.is_empty() || self.node_id.len() > 128 {
            return Err("Invalid observer node id");
        }
        if ![
            self.yaw,
            self.pitch,
            self.distance,
            self.target[0],
            self.target[1],
            self.target[2],
        ]
        .iter()
        .all(|value| value.is_finite())
        {
            return Err("Invalid observer camera");
        }
        if !(0.4..=10_000_000.0).contains(&self.distance) {
            return Err("Invalid observer distance");
        }
        Ok(())
    }
}

pub(crate) fn apply_observer(scene: &mut Scene, request: &ObserverUpdateRequest) {
    if let Some(focus) = scene.model_focus.as_mut() {
        if focus.node_id == request.node_id {
            focus.yaw = request.yaw;
            focus.pitch = request.pitch;
            focus.distance = request.distance;
            focus.target = request.target;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ObserverUpdateRequest {
        ObserverUpdateRequest {
            version: CANVAS_OBSERVER_UPDATE_VERSION.to_owned(),
            base_scene_generation: 1,
            node_id: "n".into(),
            yaw: 0.2,
            pitch: -0.1,
            distance: 4.0,
            target: [0.0, 0.0, 0.0],
        }
    }

    #[test]
    fn accepts_finite_focused_pose() {
        assert!(request().validate().is_ok());
    }

    #[test]
    fn rejects_wrong_version() {
        let mut value = request();
        value.version = "woohaa-canvas-observer-v0".into();
        assert_eq!(value.validate(), Err("Unsupported observer update version"));
    }

    #[test]
    fn rejects_non_finite_distance() {
        let mut value = request();
        value.distance = f32::NAN;
        assert_eq!(value.validate(), Err("Invalid observer camera"));
    }
}
