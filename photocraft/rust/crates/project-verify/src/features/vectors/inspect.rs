//! 矢量域核验（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools，design D4）。
//!
//! 与编辑器共用同一份已解压文档：本模块只判**有界性与引用完整性**，不重新解析 `.pcraft`、
//! 不重建几何、不分配像素。三条规则：
//!
//! 1. 形状层与矢量蒙版的路径必须有界且非空（矢量蒙版在 selections 域统一检查）；
//! 2. 形状的规范参数（`LiveShape`）与描边参数必须在交互命令接受的范围内——工程可能来自旧版本
//!    或其他工具，越界值不能只靠渲染时 clamp；
//! 3. 文档级路径（工作路径、已存路径、裁切路径引用）必须真实存在且有界；裁切路径指向缺失的
//!    名字视为损坏而不是「忽略」。

use super::*;
use crate::limits::{MAX_VECTOR_KNOTS_PER_SUBPATH, MAX_VECTOR_PATH_POINTS, MAX_VECTOR_SAVED_PATHS, MAX_VECTOR_SUBPATHS};

/// 路径几何有界：节点数、单子路径节点数与坐标都在工程可保存范围内。
pub(crate) fn path_bounded(path: &photocraft_doc::vector::Path) -> bool {
    let limit = f64::from(limits::MAX_CANVAS_SIDE) * 8.0;
    if path.subpaths.len() > MAX_VECTOR_SUBPATHS {
        return false;
    }
    path.subpaths.iter().all(|subpath| {
        subpath.knots.len() <= MAX_VECTOR_KNOTS_PER_SUBPATH
            && subpath.knots.iter().all(|knot| {
                [knot.anchor, knot.in_ctrl, knot.out_ctrl].into_iter().all(|point| {
                    point.x.is_finite() && point.y.is_finite() && point.x.abs() <= limit && point.y.abs() <= limit
                })
            })
    })
}

/// 形状层：路径有界 + 规范参数有界 + 描边有效。
pub(super) fn inspect(layer: &photocraft_doc::Layer, _depth: usize, out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    match &layer.content {
        LayerContent::Shape(shape) => Some((|| {
            if shape.path.is_empty() {
                return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含空的形状路径"));
            }
            if !path_bounded(&shape.path) {
                return Err(err(VerifyErrorCode::UnsupportedObject, "形状路径几何越界"));
            }
            if let Some(live) = &shape.live
                && !live_bounded(live)
            {
                return Err(err(VerifyErrorCode::UnsupportedObject, "形状的规范参数越界"));
            }
            if let Some(stroke) = &shape.stroke
                && stroke.validate().is_err()
            {
                return Err(err(VerifyErrorCode::UnsupportedObject, "形状描边参数越界"));
            }
            out.kinds.insert("shape".into());
            Ok(())
        })()),
        _ => None,
    }
}

/// 规范形状参数是否在交互命令接受的范围内（不许依赖渲染期夹取）。
fn live_bounded(live: &photocraft_doc::vector::LiveShape) -> bool {
    use photocraft_doc::vector::LiveShape;
    let rect_ok = |rect: &[f64; 4]| {
        rect.iter().all(|value| value.is_finite())
            && rect[2] > 0.0
            && rect[3] > 0.0
            && rect[0].abs() <= 1_000_000.0
            && rect[1].abs() <= 1_000_000.0
            && rect[2] <= 1_000_000.0
            && rect[3] <= 1_000_000.0
    };
    let point_ok = |point: &[f64; 2]| point.iter().all(|value| value.is_finite() && value.abs() <= 1_000_000.0);
    match live {
        LiveShape::Rect { rect, radii } => {
            rect_ok(rect)
                && radii.iter().all(|radius| radius.is_finite() && *radius >= 0.0)
                && radii.iter().all(|radius| *radius <= rect[2].min(rect[3]) / 2.0)
        }
        LiveShape::Ellipse { rect } => rect_ok(rect),
        LiveShape::Polygon { rect, sides, star_ratio } => {
            rect_ok(rect) && (3..=100).contains(sides) && star_ratio.is_finite() && (0.01..=1.0).contains(star_ratio)
        }
        LiveShape::Line { from, to, weight } => {
            point_ok(from) && point_ok(to) && weight.is_finite() && (0.0..=1_000_000.0).contains(weight)
        }
    }
}

/// 文档级路径核验：工作路径、已存路径与裁切路径引用。
///
/// **集成点**：`lib.rs` 在 `inspect_layers` 之后调用一次（`features::vectors::inspect_document`）。
/// 该文件由集成会话单一写入，本域只提供实现与回归。
pub(crate) fn inspect_document(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    if let Some(work) = &document.work_path
        && (work.is_empty() || !path_bounded(work))
    {
        return Err(err(VerifyErrorCode::UnsupportedObject, "工作路径为空或几何越界"));
    }
    if document.paths.len() > MAX_SAVED_PATHS {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("已存路径超过上限：{} > {MAX_SAVED_PATHS}", document.paths.len()),
        ));
    }
    for path in &document.paths {
        if path.name.trim().is_empty() || path.name.chars().count() > 200 {
            return Err(err(VerifyErrorCode::UnsupportedObject, "已存路径名称非法"));
        }
        if path.path.is_empty() || !path_bounded(&path.path) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "已存路径为空或几何越界"));
        }
    }
    if let Some(clipping) = &document.clipping_path {
        if !clipping.flatness.is_finite() || !(0.0..=100.0).contains(&clipping.flatness) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "裁切路径平直度越界"));
        }
        if !document.paths.iter().any(|path| path.name == clipping.name) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "裁切路径引用了不存在的已存路径"));
        }
    }
    Ok(())
}

/// 已存路径数量上限（与界面同量级，远小于工程总预算）。
const MAX_SAVED_PATHS: usize = MAX_VECTOR_SAVED_PATHS;

/// **解码前**的矢量载荷累计预算（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
///
/// 在 `manifest.json` 解析后、分配像素 tile 与路径结构之前执行：任何一条路径超限、
/// 或全文档锚点累计超过 `MAX_VECTOR_PATH_POINTS`，整份工程拒绝，而不是逐条放过再靠渲染期夹取。
/// 这样损坏/敌意工程不会先付出一次完整解码（含 256 MiB 资源）的代价才被拒。
pub(crate) fn inspect_manifest_budget(manifest: &photocraft_format::Manifest) -> Result<(), VerifyError> {
    let document = &manifest.document;
    if document.paths.len() > MAX_SAVED_PATHS {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("已存路径超过上限：{} > {MAX_SAVED_PATHS}", document.paths.len()),
        ));
    }
    let mut points: u64 = 0;
    for named in &document.paths {
        charge_manifest_path(&named.path, &mut points)?;
    }
    if let Some(work) = &document.work_path {
        charge_manifest_path(work, &mut points)?;
    }
    let mut layers: Vec<&photocraft_format::manifest::LayerM> = document.layers.iter().collect();
    while let Some(layer) = layers.pop() {
        if let Some(mask) = &layer.vector_mask {
            charge_manifest_path(&mask.path, &mut points)?;
        }
        match &layer.content {
            photocraft_format::manifest::ContentM::Group { children, .. } => layers.extend(children.iter()),
            photocraft_format::manifest::ContentM::Shape { path, .. } => charge_manifest_path(path, &mut points)?,
            _ => {}
        }
    }
    Ok(())
}

/// 单条 manifest 路径的子路径/锚点预算与累计扣减。
fn charge_manifest_path(path: &photocraft_doc::vector::Path, points: &mut u64) -> Result<(), VerifyError> {
    if path.subpaths.len() > MAX_VECTOR_SUBPATHS {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("路径子路径超过上限：{} > {MAX_VECTOR_SUBPATHS}", path.subpaths.len()),
        ));
    }
    for subpath in &path.subpaths {
        if subpath.knots.len() > MAX_VECTOR_KNOTS_PER_SUBPATH {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("子路径锚点超过上限：{} > {MAX_VECTOR_KNOTS_PER_SUBPATH}", subpath.knots.len()),
            ));
        }
        *points = points.saturating_add(subpath.knots.len() as u64);
        if *points > MAX_VECTOR_PATH_POINTS {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("矢量路径锚点累计超过上限：{MAX_VECTOR_PATH_POINTS}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::vector::{ClippingPath, LiveShape, NamedPath, Path, Subpath};

    fn square() -> Path {
        Path::new(vec![Subpath::polygon(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)])])
    }

    fn blank() -> photocraft_doc::Document {
        let mut document = photocraft_doc::Document::with_background(
            "doc",
            photocraft_doc::Size::new(32, 32),
            photocraft_doc::ColorMode::Rgb,
            photocraft_doc::SampleType::U8,
            photocraft_doc::Color::WHITE,
        );
        document.layers.clear();
        document
    }

    #[test]
    fn saved_and_work_paths_must_be_bounded_and_named() {
        let mut document = blank();
        assert!(inspect_document(&document).is_ok());
        document.work_path = Some(square());
        assert!(inspect_document(&document).is_ok());
        document.work_path = Some(Path::default());
        assert!(inspect_document(&document).is_err(), "空工作路径不能通过核验");

        let mut document = blank();
        document.paths.push(NamedPath { name: "  ".into(), path: square(), psd_raw: None });
        assert!(inspect_document(&document).is_err(), "空名称的已存路径是损坏内容");

        let mut document = blank();
        let mut over = square();
        for subpath in &mut over.subpaths {
            for knot in &mut subpath.knots {
                knot.anchor.x = 1e9;
            }
        }
        document.paths.push(NamedPath { name: "越界".into(), path: over, psd_raw: None });
        assert!(inspect_document(&document).is_err());

        let mut document = blank();
        for index in 0..=MAX_SAVED_PATHS {
            document.paths.push(NamedPath { name: format!("P{index}"), path: square(), psd_raw: None });
        }
        assert!(inspect_document(&document).is_err(), "已存路径数量必须有界");
    }

    #[test]
    fn clipping_path_must_reference_an_existing_saved_path() {
        let mut document = blank();
        document.clipping_path = Some(ClippingPath { name: "缺失".into(), flatness: 0.0 });
        assert!(inspect_document(&document).is_err());
        document.paths.push(NamedPath { name: "剪裁".into(), path: square(), psd_raw: None });
        document.clipping_path = Some(ClippingPath { name: "剪裁".into(), flatness: 2.0 });
        assert!(inspect_document(&document).is_ok());
        document.clipping_path = Some(ClippingPath { name: "剪裁".into(), flatness: 1e9 });
        assert!(inspect_document(&document).is_err(), "平直度必须在设备像素范围内");
    }

    #[test]
    fn live_shape_parameters_are_checked_before_rendering() {
        assert!(live_bounded(&LiveShape::Rect { rect: [0.0, 0.0, 20.0, 20.0], radii: [2.0; 4] }));
        assert!(!live_bounded(&LiveShape::Rect { rect: [0.0, 0.0, 20.0, 20.0], radii: [20.0; 4] }), "圆角超过短边一半");
        assert!(!live_bounded(&LiveShape::Rect { rect: [0.0, 0.0, 0.0, 20.0], radii: [0.0; 4] }), "零宽矩形");
        assert!(live_bounded(&LiveShape::Polygon { rect: [0.0, 0.0, 20.0, 20.0], sides: 6, star_ratio: 0.5 }));
        assert!(!live_bounded(&LiveShape::Polygon { rect: [0.0, 0.0, 20.0, 20.0], sides: 2, star_ratio: 0.5 }));
        assert!(!live_bounded(&LiveShape::Polygon { rect: [0.0, 0.0, 20.0, 20.0], sides: 6, star_ratio: 0.0 }));
        assert!(live_bounded(&LiveShape::Line { from: [0.0, 0.0], to: [10.0, 10.0], weight: 2.0 }));
        assert!(!live_bounded(&LiveShape::Line { from: [0.0, 0.0], to: [10.0, 10.0], weight: f64::NAN }));
    }
}
