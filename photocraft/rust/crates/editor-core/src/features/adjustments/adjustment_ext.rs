//! P5：新区调整（色阶／分通道曲线／自然饱和度／黑白）、直方图与高级选区
//! （change: 2026-10-22-complete-photocraft-webui-editing，P5 / design D8）。
//!
//! ## 调色
//!
//! 复用上游 `photocraft_doc::Adjustment` 与 `engine::adjust_params`，只把 `adjustment_preview`
//! 的白名单扩到新区类型。参数校验、草稿原子性与「无变化不增历史」沿用同一实现。
//!
//! ## 直方图
//!
//! 只读采样：当前层或可见合成、RGB 或亮度，走 `photocraft_compose::render` 的源像素（不用
//! 缩略图估算）。结果带 `generation`，调用方丢弃过期响应；采样不修改修订、指纹或历史。
//!
//! ## 选区
//!
//! 魔棒、快速选择、色彩范围与选区修改（扩展／收缩／平滑／边界／羽化）都走上游命令；这里的
//! 附加值是把它们编译成**可预览草稿**（预览不改正式选区，确认才提交一次历史），并提供边缘
//! 细化的输出目标（选区／像素蒙版）。

use photocraft_doc::{Document, LayerContent, LayerId};
use serde_json::{Value, json};

use crate::error::{EditorError, Result};

fn error(id: &'static str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

/// P5 开放的调整类型（命令后缀）。
pub const ADJUSTMENT_KINDS: &[&str] = &["levels", "curves", "vibrance", "blackWhite"];

/// 调整层是否属于 P5 新区类型。
pub fn is_p5_adjustment(kind: &str) -> bool {
    ADJUSTMENT_KINDS.contains(&kind)
}

/// 直方图采样目标。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistogramSource {
    /// 当前活动层（只算该层内容）。
    Layer,
    /// 可见合成（与画布所见一致）。
    Composite,
}

/// 直方图通道模式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistogramChannel {
    Rgb,
    Luminance,
}

/// 一次直方图采样结果。
pub struct HistogramResult {
    /// 采样时的文档代际／修订：调用方据此丢弃过期结果。
    pub generation: u64,
    pub source: &'static str,
    pub channel: &'static str,
    /// RGB 三通道各 256 桶（亮度模式三个通道相同）。
    pub channels: [[u64; 256]; 3],
    /// 实际参与统计的样本数。
    pub samples: u64,
    /// 透明像素数（不参与 RGB 统计，但计入总数说明）。
    pub transparent: u64,
    pub width: u32,
    pub height: u32,
}

impl HistogramResult {
    pub fn to_json(&self) -> Value {
        json!({
            "generation": self.generation,
            "source": self.source,
            "channel": self.channel,
            "channels": self.channels.iter().map(|bins| bins.to_vec()).collect::<Vec<_>>(),
            "samples": self.samples,
            "transparent": self.transparent,
            "width": self.width,
            "height": self.height,
            "bins": 256,
        })
    }
}

/// 采样直方图。`generation` 由调用方给出（通常是文档修订），只用于结果归属。
pub fn histogram(
    document: &Document,
    source: HistogramSource,
    channel: HistogramChannel,
    generation: u64,
) -> Result<HistogramResult> {
    let bounds = document.bounds();
    if bounds.is_empty() {
        return Err(error("analysis.histogram", "文档没有可采样的像素"));
    }
    // 源像素：可见合成，或只渲染活动层。两者都走真实合成，不用缩略图。
    let buffer = match source {
        HistogramSource::Composite => photocraft_compose::render(document, bounds),
        HistogramSource::Layer => {
            let active = document
                .layers
                .iter()
                .find(|layer| matches!(layer.content, LayerContent::Raster(_)))
                .ok_or_else(|| error("analysis.histogram", "没有可采样的像素层"))?;
            let mut isolated = document.clone();
            isolated.layers.retain(|layer| layer.id == active.id);
            photocraft_compose::render(&isolated, bounds)
        }
    };
    let samples: Vec<[f32; 4]> = buffer.px.clone();
    let mut result = stats(&samples, channel);
    result.generation = generation;
    result.source = match source {
        HistogramSource::Composite => "composite",
        HistogramSource::Layer => "layer",
    };
    result.channel = match channel {
        HistogramChannel::Rgb => "rgb",
        HistogramChannel::Luminance => "luminance",
    };
    result.width = buffer.rect.width();
    result.height = buffer.rect.height();
    Ok(result)
}

fn stats(pixels: &[[f32; 4]], channel: HistogramChannel) -> HistogramResult {
    let mut channels = [[0u64; 256]; 3];
    let mut samples = 0u64;
    let mut transparent = 0u64;
    for pixel in pixels {
        if !pixel.iter().all(|value| value.is_finite()) {
            continue;
        }
        if pixel[3] <= 0.0 {
            transparent += 1;
            continue;
        }
        samples += 1;
        match channel {
            HistogramChannel::Rgb => {
                for (index, bins) in channels.iter_mut().enumerate() {
                    let value = pixel[index].clamp(0.0, 1.0);
                    let bin = ((value * 255.0) + 0.5).min(255.0) as usize;
                    bins[bin] += 1;
                }
            }
            HistogramChannel::Luminance => {
                // Rec.709 亮度，与合成器的显示权重一致。
                let value = (0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]).clamp(0.0, 1.0);
                let bin = ((value * 255.0) + 0.5).min(255.0) as usize;
                for bins in &mut channels {
                    bins[bin] += 1;
                }
            }
        }
    }
    HistogramResult {
        generation: 0,
        source: "composite",
        channel: "rgb",
        channels,
        samples,
        transparent,
        width: 0,
        height: 0,
    }
}

/// 图层是否有可写像素（修饰与滤镜的目标检查共用）。
pub fn writable_pixel_layer(document: &Document, layer: LayerId) -> Result<()> {
    let target = document.layer(layer).ok_or_else(|| error("paint.target", "目标图层不存在"))?;
    match &target.content {
        LayerContent::Raster(_) => {}
        LayerContent::Text(_) => {
            return Err(error("paint.target", "文字图层需要先栅格化才能绘画"))
        }
        LayerContent::Smart(_) => {
            return Err(error("paint.target", "智能对象请先编辑内容或显式栅格化"))
        }
        _ => return Err(error("paint.target", "该图层类型不支持像素绘画")),
    }
    let locks = document.effective_locks(layer);
    if locks.all || locks.pixels {
        return Err(error("paint.target", "目标图层已锁定像素"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Color, ColorMode, SampleType, Size};

    fn document() -> Document {
        let mut document = Document::with_background(
            "doc",
            Size::new(32, 24),
            ColorMode::Rgb,
            SampleType::U8,
            Color::rgb(0.2, 0.4, 0.6),
        );
        let mut layer = photocraft_doc::Layer::raster("上层", document.pixel_format());
        if let LayerContent::Raster(surface) = &mut layer.content {
            surface.fill_rect(photocraft_geom::Rect::new(0, 0, 16, 24), &[0.9, 0.9, 0.9, 1.0]);
        }
        document.layers.push(layer);
        document
    }

    #[test]
    fn histogram_samples_real_pixels_and_reports_counts() {
        let document = document();
        let result = histogram(&document, HistogramSource::Composite, HistogramChannel::Rgb, 7).unwrap();
        assert_eq!(result.generation, 7);
        assert_eq!(result.source, "composite");
        assert_eq!(result.samples, 32 * 24);
        assert_eq!(result.width, 32);
        assert_eq!(result.height, 24);
        // 左右两半亮度不同：桶分布必须有多个非零项。
        assert!(result.channels[0].iter().filter(|count| **count > 0).count() > 1);
        // RGB 模式每个样本计入三个通道。
        assert_eq!(
            result.channels.iter().map(|bins| bins.iter().sum::<u64>()).sum::<u64>(),
            32 * 24 * 3
        );
        // 亮度模式：三通道一致。
        let luma = histogram(&document, HistogramSource::Composite, HistogramChannel::Luminance, 8).unwrap();
        assert_eq!(luma.channels[0], luma.channels[1]);
        assert_eq!(luma.channels[1], luma.channels[2]);
        // 逐层采样与合成采样不同。
        let layer = histogram(&document, HistogramSource::Layer, HistogramChannel::Rgb, 9).unwrap();
        assert_ne!(layer.channels, result.channels);
    }

    #[test]
    fn histogram_does_not_change_the_document_or_history() {
        let document = document();
        let snapshots = (
            document.layers.len(),
            document.layers[0].name.clone(),
            document.selection.is_some(),
        );
        let _ = histogram(&document, HistogramSource::Composite, HistogramChannel::Rgb, 1).unwrap();
        assert_eq!(
            (document.layers.len(), document.layers[0].name.clone(), document.selection.is_some()),
            snapshots
        );
    }

    #[test]
    fn selection_modify_draft_previews_then_commits_one_history_step() {
        let mut session = photocraft_engine::Session::new();
        session.add_document(document(), None);
        session.execute("select.rect", json!({"x":4,"y":4,"width":8,"height":8})).unwrap();
        let base = session.active().unwrap().clone();
        let before_hash = crate::document_content::document_content_hash(&base.doc, &Default::default());
        let draft = SelectionDraft::new(&base, "expand", 3.0).unwrap();
        let bounds = draft.bounds().unwrap();
        assert!(bounds[2] - bounds[0] > 8, "扩展后选区变大");
        // 预览不改变正式文档。
        assert_eq!(session.active().unwrap().revision, base.revision);
        draft.commit(&mut session).unwrap();
        assert_eq!(session.active().unwrap().history.past_len(), base.history.past_len() + 1);
        // 选区变化不改变内容 hash。
        assert_eq!(
            crate::document_content::document_content_hash(&session.active().unwrap().doc, &Default::default()),
            before_hash
        );
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().history.past_len(), base.history.past_len());
    }

    #[test]
    fn selection_modify_rejects_missing_selection_bad_radius_and_empty_result() {
        let mut session = photocraft_engine::Session::new();
        session.add_document(document(), None);
        let base = session.active().unwrap().clone();
        assert!(SelectionDraft::new(&base, "expand", 2.0).is_err(), "无选区必须拒绝");
        session.execute("select.rect", json!({"x":4,"y":4,"width":8,"height":8})).unwrap();
        let base = session.active().unwrap().clone();
        for (operation, radius) in [("expand", 0.0), ("expand", -1.0), ("expand", f64::NAN), ("expand", 1e9), ("unknown", 2.0)] {
            assert!(SelectionDraft::new(&base, operation, radius).is_err(), "{operation} {radius}");
        }
        // 收缩到空：明确报错，不提交空选区。
        assert!(SelectionDraft::new(&base, "contract", 500.0).is_err());
    }

    #[test]
    fn refine_edge_params_are_bounded_and_name_the_output() {
        let params = refine_edge_params(
            &json!({"radius":2,"smooth":10,"feather":1.5,"contrast":20,"shiftEdge":-5,"smartRadius":true}),
            RefineOutput::LayerMask,
        )
        .unwrap();
        assert_eq!(params["output"], "layerMask");
        assert_eq!(params["radius"], 2.0);
        assert_eq!(params["smartRadius"], true);
        assert!(refine_edge_params(&json!({"radius":-1}), RefineOutput::Selection).is_err());
        assert!(refine_edge_params(&json!({"contrast":101}), RefineOutput::Selection).is_err());
        assert!(refine_edge_params(&json!({"shiftEdge":-101}), RefineOutput::Selection).is_err());
        // 手工修边笔迹：模式与尺寸受限。
        let brushes = refine_brushes(&json!({"refineStrokes":[{"points":[[0,0],[1,1]],"mode":"background","size":12}]})).unwrap();
        assert_eq!(brushes.len(), 1);
        assert!(refine_brushes(&json!({"refineStrokes":[{"points":[],"mode":"ai","size":12}]})).is_err());
        assert!(refine_brushes(&json!({"refineStrokes":[{"points":[],"mode":"foreground","size":0}]})).is_err());
    }

    #[test]
    fn writable_targets_reject_text_smart_and_locked_layers() {
        let mut document = document();
        let raster = document.layers[1].id;
        writable_pixel_layer(&document, raster).unwrap();
        let text = photocraft_doc::Layer::new(
            "文字",
            LayerContent::Text(photocraft_doc::TextLayer::default()),
        );
        let text_id = text.id;
        document.layers.push(text);
        assert!(writable_pixel_layer(&document, text_id).is_err());
        let smart = photocraft_doc::Layer::new(
            "对象",
            LayerContent::Smart(photocraft_doc::SmartObject::new(
                photocraft_doc::SmartSource::Linked { path: "/x".into() },
                photocraft_geom::Affine::IDENTITY,
                None,
            )),
        );
        let smart_id = smart.id;
        document.layers.push(smart);
        assert!(writable_pixel_layer(&document, smart_id).is_err());
        document.layers[1].locks.pixels = true;
        assert!(writable_pixel_layer(&document, raster).is_err());
    }
}

#[path = "../selections/selection_draft.rs"]
mod selections_implementation;
pub use selections_implementation::*;
