//! P5/P6/P7：调色、直方图、选区、修饰、滤镜、构图、文字与矢量的统一入口
//! （change: 2026-10-22-complete-photocraft-webui-editing）。
//!
//! 每个入口都遵守同一套事务规则（design D3）：
//! 草稿预览不推进修订／指纹／历史；确认只提交一次；无变化不增历史；失败保留现场。
use crate::adjustment_ext::{
    HistogramChannel, HistogramSource,
};
use serde_json::Value;

use crate::editor::*;
use super::command_error;


impl Editor {
    /// 直方图：只读采样，不修改文档、历史或保存基线。
    pub fn histogram(&self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let state = self.active_doc()?;
        let source = match params.get("source").and_then(Value::as_str) {
            Some("layer") => HistogramSource::Layer,
            Some("composite") | None => HistogramSource::Composite,
            Some(other) => {
                return Err(command_error("analysis.histogram", format!("未知采样目标：{other}")))
            }
        };
        let channel = match params.get("channel").and_then(Value::as_str) {
            Some("luminance") => HistogramChannel::Luminance,
            Some("rgb") | None => HistogramChannel::Rgb,
            Some(other) => {
                return Err(command_error("analysis.histogram", format!("未知通道模式：{other}")))
            }
        };
        // `generation` 用于调用方丢弃过期结果；这里回传当前修订。
        let result = crate::adjustment_ext::histogram(&state.doc, source, channel, state.revision)?;
        Ok(result.to_json())
    }
}
