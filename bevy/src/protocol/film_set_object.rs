//! 片场对象 child 运动投影 DTO（change: 2026-10-09-add-film-set-object-motion-and-editing，
//! design D2/D4）。
//!
//! `AnimationPlayback.objects` 携带每个片场对象的局部播放配置与对象动作轨道；Rust 按片场统一
//! 播放头 `time` 映射对象局部时间后求值。`part_ids` 为作者语义 partId → 组合作用域编码 id。

use serde::Deserialize;

/// 片场单个对象的 child 运动投影。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilmSetObjectMotion {
    #[allow(dead_code)] // 线格式字段：宿主投影与诊断使用；Rust 侧按 part_ids 定位实体。
    pub(crate) item_id: String,
    pub(crate) playback: FilmSetObjectPlayback,
    #[serde(default)]
    pub(crate) model_motion: Vec<crate::motion::RawModelTrack>,
    /// 作者语义 partId → 组合作用域编码 id（`model_motion.target_id` 与根目标据此解析）。
    #[serde(default)]
    pub(crate) part_ids: std::collections::HashMap<String, String>,
}

/// 对象局部播放配置（design D4）。
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilmSetObjectPlayback {
    #[serde(default)]
    pub(crate) start_time: f32,
    #[serde(default)]
    pub(crate) duration: f32,
    #[serde(default = "default_time_scale")]
    pub(crate) time_scale: f32,
    #[serde(default, rename = "loop")]
    pub(crate) looped: bool,
}

fn default_time_scale() -> f32 {
    1.0
}

impl FilmSetObjectMotion {
    /// 局部时间映射（design D4）；返回 `None` 表示尚未开始（显示基础姿态）。
    ///
    /// `T < startTime` → `None`；否则 `u = (T-startTime)*timeScale`，非循环 `clamp(u,0,duration)`，
    /// 循环 `u mod duration`。与 contracts `filmSetItemLocalTime` 逐位同语义。
    pub(crate) fn local_time(&self, t: f32) -> Option<f32> {
        let time = if t.is_finite() { t.max(0.0) } else { 0.0 };
        if time < self.playback.start_time {
            return None;
        }
        let scale = if self.playback.time_scale.is_finite() && self.playback.time_scale > 0.0 {
            self.playback.time_scale
        } else {
            1.0
        };
        let u = (time - self.playback.start_time) * scale;
        if !(self.playback.duration > 0.0) {
            return Some(0.0);
        }
        if self.playback.looped {
            Some(u.rem_euclid(self.playback.duration))
        } else {
            Some(u.clamp(0.0, self.playback.duration))
        }
    }
}
