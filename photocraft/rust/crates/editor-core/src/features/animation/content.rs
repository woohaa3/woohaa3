//! 时间轴与视频帧的内容身份贡献（design D1）。
//!
//! 内容指纹的唯一入口仍是共享 `document_content::document_content_hash`。本域只提供**纯函数**，
//! 把时间轴与视频帧折叠成稳定、有界、与遍历顺序无关的摘要：
//!
//! - 帧像素用共享 `document_content::surface_hash`（稀疏 tile、默认 tile 不计），因此同一帧内容在
//!   重开后得到同一摘要；
//! - 帧按索引顺序参与摘要（顺序本身就是内容）；
//! - **不用图层 id 标识条目**：加载工程时图层 id 会重新分配（`format::convert` 只在
//!   `preserve_ids` 时保留），把 id 写进摘要会让同一份工程重开后身份漂移。因此这里用「图层树中的
//!   位置 + 图层名」定位，`content.rs` 与 TS `animationContentKey` 同一字段顺序；
//! - 时间轴只贡献 `fps` 与 `duration`：`current`（播放头）是会话视图，`work_start`/`work_end` 是
//!   工作区范围，二者都不进内容身份（与 `identity.rs` 的「视图不进内容」一致）。
//!
//! 旧工程没有时间轴/视频层时，这些字段不产生任何贡献，因此旧身份逐字节不变。
//!
//! ## 与共享内容身份的接线（已落地）
//!
//! 本模块的两个入口都由共享层调用，因此时间轴与帧**就是**工程内容的一部分：
//!
//! - [`animation_content_json`] 由 `document_content::project_content` 在根层追加成 `animation` 字段；
//! - `identity::canonicalize` 用 [`crate::identity`] 里的 `canonicalize_animation` 把同一份结构
//!   写成规范文本的一行，与 TS `canonicalizeAnimationContent` 逐字节一致。
//!
//! 旧工程没有时间轴也没有视频层时 [`animation_content_json`] 返回 `None`，字段不出现，规范文本
//! 逐字节不变——历史指纹因此兼容。改帧率/时长/帧顺序/帧像素会改变 `documentContentHash`，
//! 播放头与工作区范围不会（它们是会话视图）。
use photocraft_doc::Document;
use serde_json::{Value, json};

/// 一帧的稳定描述：尺寸、格式与稀疏像素摘要。
pub fn frame_json(surface: &photocraft_doc::Surface) -> Value {
    frame_json_cached(surface, &mut std::collections::HashMap::new())
}

/// 与 [`frame_json`] 相同，但复用共享的 tile 摘要缓存（`project_content` 每次状态同步都会调用）。
pub fn frame_json_cached(
    surface: &photocraft_doc::Surface,
    tiles: &mut std::collections::HashMap<usize, crate::document_content::TileFingerprint>,
) -> Value {
    let bounds = surface.content_bounds();
    json!({
        "contentHash": crate::document_content::surface_hash_cached(surface, tiles),
        "width": bounds.width(),
        "height": bounds.height(),
        "format": format_name(&surface.format()),
    })
}

/// 像素格式的稳定短名（`PixelFormat` 的 `Debug` 会带上字段名与分隔符，不适合进内容身份）。
///
/// 已知格式走固定表；组合格式回退到 `mode/sample[:alpha]` 的形式，仍是确定文本。
pub fn format_name(format: &photocraft_doc::PixelFormat) -> String {
    use photocraft_doc::{ColorMode, SampleType};
    let known = [
        (photocraft_doc::PixelFormat::RGBA8, "RGBA8"),
        (photocraft_doc::PixelFormat::RGBA16, "RGBA16"),
        (photocraft_doc::PixelFormat::RGBA32F, "RGBA32F"),
        (photocraft_doc::PixelFormat::GRAY8, "GRAY8"),
        (photocraft_doc::PixelFormat::GRAYA8, "GRAYA8"),
        (photocraft_doc::PixelFormat::CMYKA8, "CMYKA8"),
    ];
    for (candidate, name) in known {
        if *format == candidate {
            return name.to_string();
        }
    }
    let mode = match format.mode {
        ColorMode::Bitmap => "Bitmap",
        ColorMode::Grayscale => "Grayscale",
        ColorMode::Indexed => "Indexed",
        ColorMode::Rgb => "Rgb",
        ColorMode::Cmyk => "Cmyk",
        ColorMode::Lab => "Lab",
        ColorMode::Multichannel => "Multichannel",
        ColorMode::Duotone => "Duotone",
    };
    let sample = match format.sample {
        SampleType::U8 => "U8",
        SampleType::U16 => "U16",
        SampleType::F32 => "F32",
    };
    format!("{mode}/{sample}{}", if format.alpha { "+alpha" } else { "" })
}

/// 时间轴的**内容**部分（不含播放头与工作区范围）。
pub fn timeline_json(timeline: &photocraft_doc::Timeline) -> Value {
    json!({
        "fps": f64::from(timeline.fps),
        "duration": timeline.duration,
    })
}

/// 视频层的帧栈描述；`original_frames` 只在存在时出现（旧文档缺省即兼容）。
pub fn video_json(video: &photocraft_doc::VideoData) -> Value {
    video_json_cached(video, &mut std::collections::HashMap::new())
}

/// 与 [`video_json`] 相同，但复用共享的 tile 摘要缓存。
pub fn video_json_cached(
    video: &photocraft_doc::VideoData,
    tiles: &mut std::collections::HashMap<usize, crate::document_content::TileFingerprint>,
) -> Value {
    let mut value = json!({
        "fps": f64::from(video.fps),
        "showAltered": video.show_altered,
        "frames": video.frames.iter().map(|frame| frame_json_cached(frame, tiles)).collect::<Vec<_>>(),
    });
    if let Some(original) = &video.original_frames {
        value["original"] = json!(original.iter().map(|frame| frame_json_cached(frame, tiles)).collect::<Vec<_>>());
    }
    value
}

/// 一个图层及其子树的视频帧摘要；不含视频（自身与子树都没有帧栈）时返回 `None`。
///
/// 条目用**图层名**定位、整体保持文档顺序，不用 `LayerId`：加载工程时 id 会重新分配（见模块文档）。
///
/// 自身没有帧栈的组也会因为子树带帧而出现，此时 `video` 是 `null`——**不能**用空对象顶替，
/// 否则「组只有子层帧」和「组有一组空帧栈」会得到同一份摘要。
pub fn layer_video_json(layer: &photocraft_doc::Layer) -> Option<Value> {
    layer_video_json_cached(layer, &mut std::collections::HashMap::new())
}

/// 与 [`layer_video_json`] 相同，但复用共享的 tile 摘要缓存。
pub fn layer_video_json_cached(
    layer: &photocraft_doc::Layer,
    tiles: &mut std::collections::HashMap<usize, crate::document_content::TileFingerprint>,
) -> Option<Value> {
    let own = layer.video.as_ref().map(|video| video_json_cached(video, tiles));
    let children: Vec<Value> = match &layer.content {
        photocraft_doc::LayerContent::Group(group) => group
            .children
            .iter()
            .filter_map(|child| layer_video_json_cached(child, tiles))
            .collect(),
        _ => Vec::new(),
    };
    if own.is_none() && children.is_empty() {
        return None;
    }
    let mut entry = json!({"name": layer.name, "video": own});
    if !children.is_empty() {
        entry["children"] = Value::Array(children);
    }
    Some(entry)
}

/// 整份文档的动画贡献：`None` = 没有时间轴也没有视频层（旧工程身份保持兼容）。
pub fn animation_content_json(doc: &Document) -> Option<Value> {
    animation_content_json_cached(doc, &mut std::collections::HashMap::new())
}

/// 与 [`animation_content_json`] 相同，但复用共享的 tile 摘要缓存。
///
/// `project_content` 在每次状态同步时都会调用本函数；帧之间、帧与显示内容之间大量共享同一批
/// `Arc<Tile>`，共用缓存后重复调用只花时间在真正改动过的 tile 上。
pub fn animation_content_json_cached(
    doc: &Document,
    tiles: &mut std::collections::HashMap<usize, crate::document_content::TileFingerprint>,
) -> Option<Value> {
    let timeline = doc.timeline.as_ref().map(timeline_json);
    let layers: Vec<Value> = doc
        .layers
        .iter()
        .filter_map(|layer| layer_video_json_cached(layer, tiles))
        .collect();
    if timeline.is_none() && layers.is_empty() {
        return None;
    }
    Some(json!({
        "timeline": timeline,
        "layers": layers,
    }))
}

/// 视频层「显示内容」的内容身份。
///
/// 上游把**播放头处的帧**同步成图层的显示内容（`video_cmds::sync`），因此显示内容只是帧栈的
/// 投影。若它直接参与图层像素身份，**只是拖动播放头就会让工程变成「已修改」**——这与
/// 「播放位置是会话态」相悖。所以：
///
/// - 显示内容与播放头处的帧一致（已同步）→ 用固定标记，帧内容由 [`animation_content_json`]
///   里的帧栈负责，播放头因此不进身份；
/// - 不一致（有尚未写回的绘画编辑）→ 用显示内容摘要，未写回的编辑仍被算作内容变化，
///   不会出现「画了但宿主认为没变、保存时丢掉」。
///
/// **前提**是这份显示内容真的会被写回：写回条件与上游一致（`show_altered || 没有原始素材`）。
/// 在「显示原始素材」模式下显示内容是**预览**，写回被跳过（上游 #3060），因此它绝不能被算成
/// 内容——否则指纹会声称一份存不进工程的编辑：保存后重开会退回原值，宿主刚存完就认为工程又被
/// 外部改过。这种编辑由 [`original_view_edits_pending`] 报给界面，而不是伪造进指纹。
pub fn video_display_hash(
    current: usize,
    video: &photocraft_doc::VideoData,
    display: &photocraft_doc::Surface,
    tiles: &mut std::collections::HashMap<usize, crate::document_content::TileFingerprint>,
) -> String {
    if !write_back_reaches_the_display(video) {
        return crate::identity::fnv1a64_hex("video-display");
    }
    let display_hash = crate::document_content::surface_hash_cached(display, tiles);
    let visible = if video.show_altered {
        &video.frames
    } else {
        video.original_frames.as_ref().unwrap_or(&video.frames)
    };
    let stored = visible
        .get(current.min(visible.len().saturating_sub(1)))
        .map(|frame| crate::document_content::surface_hash_cached(frame, tiles));
    if stored.as_deref() == Some(display_hash.as_str()) {
        // 固定标记：同一份帧栈在不同播放头下得到同一身份。
        return crate::identity::fnv1a64_hex("video-display");
    }
    display_hash
}

/// 显示内容是否会被写回帧栈（与上游 `video_cmds::store` 的判定完全一致）。
///
/// 「显示原始素材」模式下显示内容只是预览，写回被跳过（上游 #3060）。两处必须同源：若身份按
/// 显示内容算、而写回跳过，指纹就描述了工程里存不下的东西。
fn write_back_reaches_the_display(video: &photocraft_doc::VideoData) -> bool {
    video.show_altered || video.original_frames.is_none()
}

/// 「显示原始素材」模式下画布上还留着尚未生效的编辑时，返回涉及该层的说明。
///
/// 这类编辑**不会**被写回帧栈（上游 #3060：原始视图是预览），所以不能静默当成已保存。返回
/// `Some` 时界面必须提示用户切回「显示修帧结果」，而不是让保存后的重开悄悄丢掉这次作画。
pub fn original_view_edits_pending(doc: &Document) -> Option<String> {
    fn walk(layers: &[photocraft_doc::Layer], current: usize, names: &mut Vec<String>) {
        for layer in layers {
            if let (Some(video), photocraft_doc::LayerContent::Raster(surface)) = (&layer.video, &layer.content)
                && !write_back_reaches_the_display(video)
            {
                let visible = video.original_frames.as_ref().unwrap_or(&video.frames);
                let slot = current.min(visible.len().saturating_sub(1));
                if visible.get(slot).is_none_or(|frame| frame != surface) {
                    names.push(layer.name.clone());
                }
            }
            if let photocraft_doc::LayerContent::Group(group) = &layer.content {
                walk(&group.children, current, names);
            }
        }
    }
    let current = doc.timeline.as_ref().map_or(0, |timeline| timeline.current);
    let mut names = Vec::new();
    walk(&doc.layers, current, &mut names);
    if names.is_empty() {
        None
    } else {
        Some(format!(
            "「显示原始素材」模式下画布上的编辑不会写回帧栈：{}。请先切回「显示修帧结果」再作画或保存。",
            names.join("、")
        ))
    }
}

/// 帧预算核算用的辅助：文档中所有视频层的最大帧数（无视频层为 0）。
pub fn max_frame_count(doc: &Document) -> usize {
    fn walk(layers: &[photocraft_doc::Layer]) -> usize {
        layers
            .iter()
            .map(|layer| {
                let own = layer.video.as_ref().map_or(0, |video| video.frames.len());
                let nested = match &layer.content {
                    photocraft_doc::LayerContent::Group(group) => walk(&group.children),
                    _ => 0,
                };
                own.max(nested)
            })
            .max()
            .unwrap_or(0)
    }
    walk(&doc.layers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{ColorMode, Document, Layer, LayerContent, SampleType, Size, Timeline, VideoData};
    use photocraft_raster::Surface;

    fn document() -> Document {
        let mut doc = Document::new("animation", Size::new(4, 3), ColorMode::Rgb, SampleType::U8);
        doc.layers.push(Layer::raster("background", doc.pixel_format()));
        doc
    }

    fn painted(mut surface: Surface, x: i32, y: i32, rgba: [f32; 4]) -> Surface {
        surface.write_pixel(x, y, &rgba);
        surface
    }

    #[test]
    fn a_plain_document_contributes_nothing_so_old_identity_is_unchanged() {
        assert!(animation_content_json(&document()).is_none());
        assert_eq!(max_frame_count(&document()), 0);
    }

    #[test]
    fn timeline_identity_covers_duration_and_fps_but_not_the_playhead() {
        let mut doc = document();
        doc.timeline = Some(Timeline::new(12, 24.0));
        let base = animation_content_json(&doc).expect("时间轴参与内容");
        assert_eq!(base["timeline"]["duration"], 12);
        assert_eq!(base["timeline"]["fps"], 24.0);
        // 播放头与工作区范围是会话视图，不改变内容身份。
        doc.timeline.as_mut().unwrap().current = 7;
        doc.timeline.as_mut().unwrap().work_start = 2;
        doc.timeline.as_mut().unwrap().work_end = 9;
        assert_eq!(animation_content_json(&doc).unwrap(), base);
        // 持续时间是内容。
        doc.timeline.as_mut().unwrap().duration = 24;
        assert_ne!(animation_content_json(&doc).unwrap(), base);
    }

    #[test]
    fn frame_order_and_pixels_both_change_the_summary() {
        let format = document().pixel_format();
        let a = painted(Surface::new(format), 0, 0, [1.0, 0.0, 0.0, 1.0]);
        let b = painted(Surface::new(format), 1, 1, [0.0, 1.0, 0.0, 1.0]);
        let mut doc = document();
        let mut layer = Layer::raster("video", format);
        layer.video = Some(VideoData::new(vec![a.clone(), b.clone()], 30.0));
        doc.layers.push(layer);
        let summary = animation_content_json(&doc).expect("视频层参与内容");
        assert_eq!(summary["layers"][0]["video"]["frames"].as_array().unwrap().len(), 2);
        assert_ne!(summary["layers"][0]["video"]["frames"][0], summary["layers"][0]["video"]["frames"][1]);

        // 改成反序：同一组帧、不同顺序，摘要必须不同。
        let reordered = animation_content_json(&{
            let mut other = doc.clone();
            if let Some(video) = other.layers.last_mut().and_then(|l| l.video.as_mut()) {
                video.frames = vec![b, a];
            }
            other
        })
        .unwrap();
        assert_ne!(summary, reordered);
    }

    #[test]
    fn an_empty_video_layer_is_not_mistaken_for_pixels() {
        let format = document().pixel_format();
        let mut doc = document();
        let mut layer = Layer::raster("video", format);
        layer.video = Some(VideoData::new(Vec::new(), 30.0));
        doc.layers.push(layer);
        let summary = animation_content_json(&doc).expect("空帧栈也参与内容");
        assert_eq!(summary["layers"][0]["video"]["frames"].as_array().unwrap().len(), 0);
        assert_eq!(max_frame_count(&doc), 0);
    }

    #[test]
    fn nested_video_layers_are_summarised_and_counted() {
        let format = document().pixel_format();
        let mut doc = document();
        let frame = Surface::new(format);
        let mut child = Layer::raster("child", format);
        child.video = Some(VideoData::new(vec![frame.clone(), frame.clone(), frame], 24.0));
        doc.layers.push(Layer::group("group", vec![child]));
        let summary = animation_content_json(&doc).expect("嵌套视频层参与内容");
        assert_eq!(summary["layers"][0]["name"], "group");
        assert_eq!(summary["layers"][0]["children"][0]["name"], "child");
        assert_eq!(summary["layers"][0]["children"].as_array().unwrap().len(), 1);
        assert_eq!(max_frame_count(&doc), 3);
        // 组本身没有帧栈：`video` 是 null，不是空对象，否则会和「一组空帧栈」撞摘要。
        assert!(summary["layers"][0]["video"].is_null());
    }

    /// 同一份工程保存→重开后，摘要必须逐字节不变。
    ///
    /// 加载时图层 id 会重新分配，因此摘要**不能**含 id；否则「改帧率才改变身份」这条接线一落地，
    /// 每次重开都会把未修改的工程判成已改动。这里用真实容器往返验证，而不是只比两个内存副本。
    #[test]
    fn the_summary_is_stable_across_a_save_and_reopen() {
        let format = document().pixel_format();
        let mut doc = document();
        let frame = painted(Surface::new(format), 2, 1, [0.25, 0.5, 0.75, 1.0]);
        let mut layer = Layer::raster("video", format);
        layer.video = Some(VideoData::new(vec![frame.clone(), Surface::new(format)], 24.0));
        doc.layers.push(layer);
        let mut group_child = Layer::raster("nested", format);
        group_child.video = Some(VideoData::new(vec![frame], 12.0));
        doc.layers.push(Layer::group("group", vec![group_child]));
        doc.timeline = Some(Timeline::new(2, 24.0));

        let before = animation_content_json(&doc).expect("带时间轴的文档有动画内容");
        let bytes = photocraft_format::save_to_bytes(&doc, &photocraft_format::SaveOptions::default())
            .expect("保存带视频层的工程");
        let reopened = photocraft_format::load_from_bytes(&bytes).expect("重开工程");
        let after = animation_content_json(&reopened).expect("重开后仍有动画内容");
        assert_eq!(after, before, "重开不得改变动画内容摘要（图层 id 不进摘要）");
    }

    #[test]
    fn original_frames_only_appear_when_present() {
        let format = document().pixel_format();
        let mut doc = document();
        let mut layer = Layer::raster("video", format);
        let mut video = VideoData::new(vec![Surface::new(format)], 30.0);
        assert!(video_json(&video)["original"].is_null());
        video.original_frames = Some(vec![Surface::new(format)]);
        layer.video = Some(video);
        doc.layers.push(layer);
        let summary = animation_content_json(&doc).unwrap();
        assert_eq!(summary["layers"][0]["video"]["original"].as_array().unwrap().len(), 1);
        assert!(matches!(doc.layers.last().unwrap().content, LayerContent::Raster(_)));
    }
}
