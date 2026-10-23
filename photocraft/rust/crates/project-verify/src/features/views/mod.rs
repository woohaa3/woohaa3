//! 视图导航与分析辅助的核验贡献（U70–U73，change:
//! `2026-10-22-add-photocraft-view-workspace-workflows`）。
//!
//! ## 为什么只有文档级检查
//!
//! 本域的持久数据不挂在图层上：参考线、标尺原点、测量比例、标尺线、计数分组与注释都是
//! **文档级**字段。因此 `inspect`（按图层遍历）恒返回 `None`，真正的检查在
//! [`inspect_document`]。
//!
//! ## 边界
//!
//! 只使用本域自己的有界预算，不改 `limits`、不提升全局上限：
//!
//! | 数据 | 上限 |
//! | --- | --- |
//! | 参考线（每轴） | [`MAX_GUIDES_PER_AXIS`]，位置有限且在 ±[`MAX_GUIDE_PX`] |
//! | 参考线颜色 | 不超过参考线总数 |
//! | 标尺原点 | ±[`MAX_GUIDE_PX`] |
//! | 测量比例 | 两段长度为正、有限、有单位 |
//! | 计数分组 / 标记 | [`MAX_COUNT_GROUPS`] / [`MAX_COUNT_MARKERS`] |
//! | 注释 | [`MAX_NOTES`] 条，作者与文本有界 |
//! | 颜色采样点 | 元数据键 `photocraft.views.colorSamplers`，[`MAX_SAMPLERS`] 点、坐标 ±[`MAX_GUIDE_PX`] |
//!
//! 颜色采样点在上游是**会话**数据；本 change 把它持久化在文档已有的自由文本元数据
//! （`Document::metadata.text`）的命名空间键里，因此这里是**工程内数据**，必须同样有界：坏数据
//! 会让整份工程被拒绝，而不是载入后静默丢弃。

// 调用点已接在 `src/lib.rs` 的文档校验里（`features::views::inspect_document`），与图层级
// `inspect` 并列：本域持久字段全部是文档级，图层遍历接不到它们。

use super::*;

/// 单轴参考线上限（Photoshop 的参考线布局上限是 32/轴；这里给更宽松的有界值）。
pub const MAX_GUIDES_PER_AXIS: usize = 4096;

/// 参考线/原点的坐标绝对上限（源像素）。与上游 `MAX_GUIDE_PX` 同量级。
pub const MAX_GUIDE_PX: f64 = 1.0e7;

/// 一个文档最多多少个计数分组。
pub const MAX_COUNT_GROUPS: usize = 256;

/// 一个文档最多多少个计数标记（所有分组合计）。
pub const MAX_COUNT_MARKERS: usize = 100_000;

/// 一个文档最多多少条注释。
pub const MAX_NOTES: usize = 1024;

/// 单条注释的作者与文本长度上限（字符）。
pub const MAX_NOTE_AUTHOR_CHARS: usize = 256;
pub const MAX_NOTE_TEXT_CHARS: usize = 64 * 1024;

/// 测量比例的单位名长度上限。
pub const MAX_UNIT_CHARS: usize = 32;

/// 持久颜色采样点的元数据键（与 `editor-core` 的本域常量一致）。
pub const SAMPLERS_KEY: &str = "photocraft.views.colorSamplers";

/// 每个文档最多多少个持久颜色采样点（上游 `MAX_SAMPLERS` 同为 10）。
pub const MAX_SAMPLERS: usize = 10;

/// 采样点元数据值的字节上限（10 点 × 约 48 字节，留足余量）。
pub const MAX_SAMPLERS_BYTES: usize = 4 * 1024;

pub(super) fn inspect(_layer: &photocraft_doc::Layer, _depth: usize, _out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    None
}

/// 文档级视图/分析数据的有界检查。任何越界都返回稳定 code，调用方据此拒绝整份工程。
pub fn inspect_document(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    inspect_guides(document)?;
    inspect_ruler_origin(document.ruler_origin)?;
    inspect_measurement(document)?;
    inspect_notes(document)?;
    inspect_color_samplers(document)?;
    Ok(())
}

/// 持久颜色采样点：只在元数据里出现本域键时才校验。
///
/// 键不存在是旧工程/从未采样，合法；键存在但形状、数量或坐标越界则拒绝整份工程，避免把
/// 越界点灌进会话状态，或让同一份字节在不同机器上表现不一致。
fn inspect_color_samplers(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    let Some(raw) = document
        .metadata
        .text
        .iter()
        .find(|(key, _)| key == SAMPLERS_KEY)
        .map(|(_, value)| value)
    else {
        return Ok(());
    };
    // 采样点 JSON 有界：10 个点 × 2 个坐标，远小于这个字节预算。
    if raw.len() > MAX_SAMPLERS_BYTES {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("颜色采样点元数据超过字节上限：{} > {MAX_SAMPLERS_BYTES}", raw.len()),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).map_err(|_| {
        err(VerifyErrorCode::UnsupportedObject, "颜色采样点元数据不是合法 JSON")
    })?;
    let points = parsed
        .get("points")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| err(VerifyErrorCode::UnsupportedObject, "颜色采样点元数据缺少 points 数组"))?;
    if points.len() > MAX_SAMPLERS {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("颜色采样点超过上限：{} > {MAX_SAMPLERS}", points.len()),
        ));
    }
    for point in points {
        let pair = point
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| err(VerifyErrorCode::UnsupportedObject, "颜色采样点不是 [x, y]"))?;
        let (Some(x), Some(y)) = (pair[0].as_f64(), pair[1].as_f64()) else {
            return Err(err(VerifyErrorCode::UnsupportedObject, "颜色采样点坐标不是数值"));
        };
        if !x.is_finite() || !y.is_finite() || x.abs() > MAX_GUIDE_PX || y.abs() > MAX_GUIDE_PX {
            return Err(err(VerifyErrorCode::UnsupportedObject, "颜色采样点坐标越界"));
        }
    }
    Ok(())
}

fn inspect_guides(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    for (axis, positions) in [
        ("垂直", &document.guides.vertical),
        ("水平", &document.guides.horizontal),
    ] {
        if positions.len() > MAX_GUIDES_PER_AXIS {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("{axis}参考线超过上限：{} > {MAX_GUIDES_PER_AXIS}", positions.len()),
            ));
        }
        for position in positions {
            if !position.is_finite() || position.abs() > MAX_GUIDE_PX {
                return Err(err(VerifyErrorCode::UnsupportedObject, format!("{axis}参考线坐标越界")));
            }
        }
    }
    let total = document.guides.vertical.len() + document.guides.horizontal.len();
    if document.guides.colors.len() > total {
        return Err(err(VerifyErrorCode::UnsupportedObject, "参考线颜色条目多于参考线本身"));
    }
    for color in &document.guides.colors {
        if !color.position.is_finite() || color.position.abs() > MAX_GUIDE_PX {
            return Err(err(VerifyErrorCode::UnsupportedObject, "参考线颜色指向越界坐标"));
        }
        // 颜色按方向和位置索引参考线；指向不存在的参考线说明数据自相矛盾。
        let axis = if color.vertical { &document.guides.vertical } else { &document.guides.horizontal };
        if !axis.contains(&color.position) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "参考线颜色指向不存在的参考线"));
        }
    }
    Ok(())
}

fn inspect_ruler_origin(origin: [f64; 2]) -> Result<(), VerifyError> {
    if origin.iter().any(|value| !value.is_finite() || value.abs() > MAX_GUIDE_PX) {
        return Err(err(VerifyErrorCode::UnsupportedObject, "标尺原点越界"));
    }
    Ok(())
}

fn inspect_measurement(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    let measurement = &document.measurement;
    let scale = &measurement.scale;
    if !scale.pixel_length.is_finite() || scale.pixel_length <= 0.0 {
        return Err(err(VerifyErrorCode::UnsupportedObject, "测量比例的实际长度为非正数"));
    }
    if !scale.logical_length.is_finite() || scale.logical_length <= 0.0 {
        return Err(err(VerifyErrorCode::UnsupportedObject, "测量比例的逻辑长度为非正数"));
    }
    if scale.units.trim().is_empty() || scale.units.chars().count() > MAX_UNIT_CHARS {
        return Err(err(VerifyErrorCode::UnsupportedObject, "测量比例单位为空或过长"));
    }
    if let Some(ruler) = measurement.ruler {
        let points = [ruler.start, ruler.end].into_iter().chain(ruler.protractor);
        for point in points {
            if point.iter().any(|value| !value.is_finite() || value.abs() > MAX_GUIDE_PX) {
                return Err(err(VerifyErrorCode::UnsupportedObject, "标尺线坐标越界"));
            }
        }
    }
    if measurement.count_groups.len() > MAX_COUNT_GROUPS {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("计数分组超过上限：{} > {MAX_COUNT_GROUPS}", measurement.count_groups.len()),
        ));
    }
    let mut markers = 0usize;
    for group in &measurement.count_groups {
        if group.name.chars().count() > 256 {
            return Err(err(VerifyErrorCode::UnsupportedObject, "计数分组名称过长"));
        }
        if !(1..=10).contains(&group.marker_size) || !(8..=72).contains(&group.label_size) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "计数标记或标签尺寸越界"));
        }
        for point in &group.points {
            if point.iter().any(|value| !value.is_finite() || value.abs() > MAX_GUIDE_PX) {
                return Err(err(VerifyErrorCode::UnsupportedObject, "计数标记坐标越界"));
            }
        }
        markers = markers.saturating_add(group.points.len());
    }
    if markers > MAX_COUNT_MARKERS {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("计数标记超过上限：{markers} > {MAX_COUNT_MARKERS}"),
        ));
    }
    if !measurement.count_groups.is_empty() && measurement.active_count_group >= measurement.count_groups.len() {
        return Err(err(VerifyErrorCode::UnsupportedObject, "活动计数分组索引越界"));
    }
    Ok(())
}

fn inspect_notes(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    if document.notes.len() > MAX_NOTES {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("注释超过上限：{} > {MAX_NOTES}", document.notes.len()),
        ));
    }
    for note in &document.notes {
        if note.author.chars().count() > MAX_NOTE_AUTHOR_CHARS {
            return Err(err(VerifyErrorCode::UnsupportedObject, "注释作者过长"));
        }
        if note.text.chars().count() > MAX_NOTE_TEXT_CHARS {
            return Err(err(VerifyErrorCode::UnsupportedObject, "注释文本超过上限"));
        }
        if note.position.iter().any(|value| !value.is_finite() || value.abs() > MAX_GUIDE_PX) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "注释位置越界"));
        }
        if note.popup.iter().any(|value| !value.is_finite() || value.abs() > MAX_GUIDE_PX) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "注释弹窗位置越界"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use photocraft_doc::{
        Color, ColorMode, CountGroup, Document, MeasurementScale, Note, Ruler, SampleType, Size,
    };

    use super::*;

    fn document() -> Document {
        let mut document = Document::new("核验", Size::new(64, 48), ColorMode::Rgb, SampleType::U8);
        document.layers.push(photocraft_doc::Layer::raster("背景", document.pixel_format()));
        document
    }

    fn error_code(result: Result<(), VerifyError>) -> VerifyErrorCode {
        result.expect_err("expected a bounded rejection").code
    }

    #[test]
    fn a_plain_document_passes_with_the_default_view_data() {
        inspect_document(&document()).expect("defaults are in bounds");
    }

    #[test]
    fn guides_origin_and_colours_are_bounded_per_axis_and_position() {
        let mut document = document();
        document.guides.vertical = vec![10.0, 200.0];
        document.guides.horizontal = vec![-5.0];
        document.ruler_origin = [12.0, -8.0];
        inspect_document(&document).expect("bounded guides");

        document.guides.vertical.push(f64::NAN);
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.guides.vertical = vec![1.0e9];
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.guides.vertical = vec![1.0];
        document.guides.colors = vec![
            photocraft_doc::GuideColor { vertical: true, position: 1.0, rgb: [1, 2, 3] },
        ];
        inspect_document(&document).expect("颜色与参考线一一对应");
        document.guides.colors.push(
            photocraft_doc::GuideColor { vertical: true, position: 2.0, rgb: [1, 2, 3] },
        );
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject, "颜色指向不存在的参考线");
    }

    #[test]
    fn the_ruler_origin_is_bounded() {
        let mut document = document();
        document.ruler_origin = [f64::INFINITY, 0.0];
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.ruler_origin = [0.0, -1.0e8];
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
    }

    #[test]
    fn measurement_scale_and_ruler_line_are_bounded() {
        let mut document = document();
        document.measurement.scale = MeasurementScale { pixel_length: 10.0, logical_length: 5.0, units: "mm".into() };
        document.measurement.ruler = Some(Ruler { start: [0.0, 0.0], end: [10.0, 10.0], protractor: Some([0.0, 10.0]) });
        inspect_document(&document).expect("bounded measurement");

        document.measurement.scale = MeasurementScale { pixel_length: 0.0, logical_length: 5.0, units: "mm".into() };
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.measurement.scale = MeasurementScale { pixel_length: 1.0, logical_length: -1.0, units: "mm".into() };
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.measurement.scale = MeasurementScale { pixel_length: 1.0, logical_length: 1.0, units: "  ".into() };
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.measurement.scale = MeasurementScale::default();
        document.measurement.ruler = Some(Ruler { start: [0.0, f64::NAN], end: [1.0, 1.0], protractor: None });
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
    }

    #[test]
    fn count_groups_markers_and_the_active_index_are_bounded() {
        let mut document = document();
        document.measurement.count_groups = vec![CountGroup { name: "组".into(), points: vec![[1.0, 2.0]], ..Default::default() }];
        inspect_document(&document).expect("bounded count");

        document.measurement.count_groups[0].marker_size = 0;
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.measurement.count_groups[0].marker_size = 12;
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.measurement.count_groups[0].marker_size = 3;
        document.measurement.count_groups[0].label_size = 200;
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.measurement.count_groups[0].label_size = 12;
        document.measurement.count_groups[0].points.push([f64::INFINITY, 0.0]);
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.measurement.count_groups[0].points = vec![[0.0, 0.0]];
        document.measurement.active_count_group = 3;
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
    }

    #[test]
    fn notes_are_bounded_in_count_length_and_position() {
        let mut document = document();
        document.notes.push(Note { author: "美术".into(), color: Color::rgb(1.0, 1.0, 0.5), text: "补光".into(), position: [4.0, 5.0], popup: [24.0, 25.0, 264.0, 165.0], open: true, modified: String::new() });
        inspect_document(&document).expect("bounded note");

        document.notes[0].text = "字".repeat(MAX_NOTE_TEXT_CHARS + 1);
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.notes[0].text = "ok".into();
        document.notes[0].author = "a".repeat(MAX_NOTE_AUTHOR_CHARS + 1);
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
        document.notes[0].author = "ok".into();
        document.notes[0].position = [f64::NAN, 0.0];
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);
    }

    #[test]
    fn persisted_color_samplers_are_bounded_in_count_bytes_and_coordinates() {
        let mut document = document();
        // 键不存在 = 旧工程 / 从未采样，合法。
        inspect_document(&document).expect("没有采样点元数据也应通过");

        let key = SAMPLERS_KEY.to_string();
        document.metadata.text.push((key.clone(), r#"{"points":[[1.0,2.0],[3.0,4.0]]}"#.into()));
        inspect_document(&document).expect("合法采样点通过");

        // 超过 10 个点：拒绝整份工程，而不是载入后静默丢弃。
        let too_many: Vec<String> = (0..MAX_SAMPLERS + 1).map(|n| format!("[{n}.0,0.0]")).collect();
        document.metadata.text[0].1 = format!(r#"{{"points":[{}]}}"#, too_many.join(","));
        assert_eq!(error_code(inspect_document(&document)), VerifyErrorCode::UnsupportedObject);

        // 形状/数值/坐标/字节预算各自的拒绝路径。
        for raw in [
            "not json".to_string(),
            r#"{"other":[]}"#.to_string(),
            r#"{"points":[[1.0]]}"#.to_string(),
            r#"{"points":[["a","b"]]}"#.to_string(),
            r#"{"points":[[1e300,0.0]]}"#.to_string(),
            r#"{"points":[[1.0,0.0]]} trailing"#.to_string(),
            "x".repeat(MAX_SAMPLERS_BYTES + 1),
        ] {
            document.metadata.text[0].1 = raw.clone();
            assert_eq!(
                error_code(inspect_document(&document)),
                VerifyErrorCode::UnsupportedObject,
                "应拒绝：{}",
                &raw[..raw.len().min(20)]
            );
        }
        // 非本域键不受影响（别的工具可以自由写自己的 tEXt）。
        document.metadata.text = vec![("comment".into(), "not our key".into())];
        inspect_document(&document).expect("非本域键不参与采样点校验");
    }

    #[test]
    fn layer_level_inspection_stays_out_of_the_way() {
        let document = document();
        let mut inspection = LayerInspection::default();
        for layer in &document.layers {
            assert!(inspect(layer, 1, &mut inspection, false).is_none(), "视图数据不是图层对象");
        }
    }
}
