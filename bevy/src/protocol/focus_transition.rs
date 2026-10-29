//! 公共聚焦过渡进度瞬时更新（change: 2026-10-12-unify-node-editors-and-focus-transitions，
//! design D6/D7 / 任务 1.5、6.1）。
//!
//! 三类节点聚焦的统一时间线由 Canvas Runtime scope 的 coordinator 拥有（前端唯一帧账本）。
//! Rust 侧**不再**用独立 `Time.delta` 启动第二套三维计时：当本帧携带匹配的公共进度时，
//! `FocusRig` 按该进度求值姿态；缺失合法进度时回退既有内部计时（保持旧帧兼容）。
//!
//! 边界（design D7）：只承载可丢弃的渲染瞬时态，不进入 canonical 数据；版本化并做有限值 /
//! identity / generation 校验，旧代（更小 runtime generation）进度被原子忽略。

use serde::Deserialize;

/// 聚焦过渡进度协议版本；与 Web `FOCUS_TRANSITION_VERSION` 一致。
pub(crate) const FOCUS_TRANSITION_VERSION: &str = "woohaa-focus-transition-v1";

/// 本帧的公共过渡进度。
///
/// `progress` 为 0..1 的**原始**进度（未缓动；缓动由两侧共享 `smoothstep` 施加）。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FocusTransitionProgress {
    pub(crate) version: String,
    /// 目标节点 id（必须与当前聚焦目标一致才生效）。
    pub(crate) node_id: String,
    /// 目标 kind（`model` / `image` / `video` / `extension`）。缺失按 `model` 处理。
    #[serde(default)]
    pub(crate) kind: String,
    /// 0..1 原始进度；必须有限。
    pub(crate) progress: f32,
    /// 前端 runtime generation；更小值的进度视为旧代丢弃。
    #[serde(default)]
    pub(crate) runtime_generation: u32,
    /// 过渡身份（同一连续聚焦旅程内的递增 id；诊断与去重）。
    #[serde(default)]
    pub(crate) transition_id: u32,
}

impl FocusTransitionProgress {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != FOCUS_TRANSITION_VERSION {
            return Err("Unknown focus transition version");
        }
        if self.node_id.is_empty() {
            return Err("Invalid focus transition node id");
        }
        if !self.progress.is_finite() || !(0.0..=1.0).contains(&self.progress) {
            return Err("Invalid focus transition progress");
        }
        Ok(())
    }

    /// 三维 pos/projection 是否消费本进度：仅普通模型 / extension 聚焦（`model`/`extension`）；
    /// 图片/视频的二维取景由前端直接投影 x/y/zoom，不经本三维进度。
    pub(crate) fn drives_model_rig(&self) -> bool {
        self.kind.is_empty() || self.kind == "model" || self.kind == "extension"
    }

    /// 是否适用于当前聚焦目标节点。
    pub(crate) fn matches(&self, node_id: &str) -> bool {
        self.node_id == node_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(version: &str, progress: f32) -> FocusTransitionProgress {
        FocusTransitionProgress {
            version: version.to_string(),
            node_id: "m1".to_string(),
            kind: "model".to_string(),
            progress,
            runtime_generation: 1,
            transition_id: 1,
        }
    }

    #[test]
    fn accepts_known_version_and_in_range() {
        assert!(progress(FOCUS_TRANSITION_VERSION, 0.0).validate().is_ok());
        assert!(progress(FOCUS_TRANSITION_VERSION, 1.0).validate().is_ok());
        assert!(progress(FOCUS_TRANSITION_VERSION, 0.5).validate().is_ok());
    }

    #[test]
    fn rejects_unknown_version_and_out_of_range_and_nan() {
        assert!(
            progress("woohaa-focus-transition-v2", 0.5)
                .validate()
                .is_err()
        );
        assert!(progress(FOCUS_TRANSITION_VERSION, 1.5).validate().is_err());
        assert!(progress(FOCUS_TRANSITION_VERSION, -0.1).validate().is_err());
        assert!(
            progress(FOCUS_TRANSITION_VERSION, f32::NAN)
                .validate()
                .is_err()
        );
    }

    #[test]
    fn rejects_empty_node_id() {
        let mut p = progress(FOCUS_TRANSITION_VERSION, 0.5);
        p.node_id = String::new();
        assert!(p.validate().is_err());
    }

    #[test]
    fn matches_only_same_node() {
        let p = progress(FOCUS_TRANSITION_VERSION, 0.5);
        assert!(p.matches("m1"));
        assert!(!p.matches("m2"));
    }

    #[test]
    fn drives_model_rig_for_model_and_extension_only() {
        let mut p = progress(FOCUS_TRANSITION_VERSION, 0.5);
        assert!(p.drives_model_rig());
        p.kind = "extension".to_string();
        assert!(p.drives_model_rig());
        p.kind = String::new();
        assert!(p.drives_model_rig());
        p.kind = "image".to_string();
        assert!(!p.drives_model_rig());
        p.kind = "video".to_string();
        assert!(!p.drives_model_rig());
    }
}
