//! 自由变换的 Smart 适配：原生命令处理蒙版/选区，源图负责最终外观。
use crate::{EditorError, Result};
use photocraft_doc::{Affine, Document, Group, LayerContent, LayerId};
use photocraft_engine::{DocState, Session};
use photocraft_project_verify::smart_source::inspect_document_sources;
use serde_json::{Value, json};
use std::sync::Arc;

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "edit.transform".into(),
        message: message.to_string(),
    }
}
fn native(base: &DocState, command: &str, params: Value) -> Result<DocState> {
    let mut scratch = Session::new();
    scratch.add_document((*base.doc).clone(), None);
    *scratch.active_mut().unwrap() = base.clone();
    scratch.execute(command, params).map_err(error)?;
    Ok(scratch.active().unwrap().clone())
}

pub(crate) fn execute(base: &DocState, command: &str, mut params: Value) -> Result<DocState> {
    if command == "layer.duplicate" {
        let ids = params
            .get("layer")
            .and_then(Value::as_u64)
            .map(LayerId)
            .map(|id| vec![id])
            .unwrap_or_else(|| crate::layer_preview::selected_roots(base));
        let mut scratch = Session::new();
        scratch.add_document((*base.doc).clone(), None);
        *scratch.active_mut().unwrap() = base.clone();
        crate::smart_copy::duplicate(&mut scratch, &ids, crate::smart_copy::CopyKind::Shared)?;
        return Ok(scratch.active().unwrap().clone());
    }
    if command != "edit.transform" {
        return native(base, command, params);
    }
    inspect_document_sources(&base.doc).map_err(|failure| error(failure.message))?;
    let id = params
        .get("layer")
        .and_then(Value::as_u64)
        .map(LayerId)
        .or(base.active_layer)
        .ok_or_else(|| error("没有变换目标"))?;
    if photocraft_engine::transform_cmds::lone_target(&base.doc, Some(id), &params)
        .map_err(error)?
        .is_some()
    {
        // 独立蒙版或通道沿原生命令，不改变 Smart 仿射或重算源。
        return native(base, command, params);
    }
    if photocraft_engine::transform_cmds::locked_for_transform(&base.doc, id) {
        return Err(error("变换目标或父组已锁定位置"));
    }
    let values = params["matrix"]
        .as_array()
        .filter(|values| values.len() == 6)
        .ok_or_else(|| error("需要六参数仿射"))?;
    let mut m = [0.0; 6];
    for (out, value) in m.iter_mut().zip(values) {
        *out = value
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or_else(|| error("仿射参数必须有限"))?;
    }
    let matrix = Affine { m };
    if !matrix.determinant().is_finite() || matrix.inverse().is_none() {
        return Err(error("仿射参数不可逆"));
    }
    let path = base
        .doc
        .path_of(id)
        .ok_or_else(|| error("变换目标不存在"))?;
    let instances: Vec<_> = base
        .doc
        .walk()
        .into_iter()
        .filter_map(|(at, _, layer)| {
            if at.starts_with(&path) {
                if let LayerContent::Smart(smart) = &layer.content {
                    return Some((layer.id, smart.clone()));
                }
            }
            None
        })
        .collect();
    if instances.is_empty() {
        return native(base, command, params);
    }
    let mut input = base.clone();
    let document = Arc::make_mut(&mut input.doc);
    for (id, smart) in &instances {
        let mut transformed = smart.clone();
        transformed.transform = matrix.mul(&smart.transform);
        transformed.cache = None;
        document.layer_mut(*id).unwrap().content = LayerContent::Smart(transformed);
    }
    // 在任何关联蒙版或普通像素处理之前，先拒绝源放置越界。
    inspect_document_sources(document).map_err(|failure| error(failure.message))?;
    for (id, _) in &instances {
        // 无内容组与 Smart 都整体移动，蒙版和选区规则相同。
        // 临时替身阻止原生命令重采样旧缓存或走通用源导入；绝不发布该文档。
        document.layer_mut(*id).unwrap().content = LayerContent::Group(Group {
            children: vec![],
            expanded: true,
            artboard: None,
        });
    }
    if params.get("rect").is_none() {
        // 显式 matrix 使用文档坐标；rect 只供原生命令返回/相对参数路径，不用于重算矩阵。
        let b = base.doc.bounds();
        params["rect"] = json!([b.x0, b.y0, b.x1, b.y1]);
    }
    let mut result = native(&input, command, params)?;
    let document = Arc::make_mut(&mut result.doc);
    for (id, mut smart) in instances {
        smart.transform = matrix.mul(&smart.transform);
        smart.cache = None;
        document
            .layer_mut(id)
            .ok_or_else(|| error("变换后智能对象丢失"))?
            .content = LayerContent::Smart(smart);
    }
    inspect_document_sources(document).map_err(|failure| error(failure.message))?;
    Ok(result)
}

/// Smart 的外框覆盖完整源画布；不依赖可能缺失或只覆盖非透明像素的旧缓存。
pub(crate) fn frame(document: &Document, ids: &[LayerId]) -> Result<photocraft_doc::Rect> {
    let graph = inspect_document_sources(document).map_err(|failure| error(failure.message))?;
    let mut frame = photocraft_doc::Rect::EMPTY;
    for id in ids {
        let layer = document.layer(*id).ok_or_else(|| error("变换目标不存在"))?;
        let mut uncached = layer.clone();
        clear_smart_cache(&mut uncached);
        frame = frame.union(&photocraft_engine::transform_cmds::transform_frame(
            document, &uncached,
        ));
        let root = document.path_of(*id).unwrap();
        for (path, _, layer) in document.walk() {
            if !path.starts_with(&root) {
                continue;
            }
            if let LayerContent::Smart(smart) = &layer.content {
                let source = graph
                    .document(&smart.source)
                    .ok_or_else(|| error("源帧不在核验图中"))?;
                let (w, h) = (f64::from(source.size.width), f64::from(source.size.height));
                let points = [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)]
                    .map(|(x, y)| smart.transform.apply(photocraft_geom::Point::new(x, y)));
                let x0 = points
                    .iter()
                    .map(|p| p.x)
                    .fold(f64::INFINITY, f64::min)
                    .floor();
                let y0 = points
                    .iter()
                    .map(|p| p.y)
                    .fold(f64::INFINITY, f64::min)
                    .floor();
                let x1 = points
                    .iter()
                    .map(|p| p.x)
                    .fold(f64::NEG_INFINITY, f64::max)
                    .ceil();
                let y1 = points
                    .iter()
                    .map(|p| p.y)
                    .fold(f64::NEG_INFINITY, f64::max)
                    .ceil();
                frame = frame.union(&photocraft_doc::Rect::new(
                    x0 as i32, y0 as i32, x1 as i32, y1 as i32,
                ));
            }
        }
    }
    Ok(frame)
}

fn clear_smart_cache(layer: &mut photocraft_doc::Layer) {
    match &mut layer.content {
        LayerContent::Smart(smart) => smart.cache = None,
        LayerContent::Group(group) => group.children.iter_mut().for_each(clear_smart_cache),
        _ => {}
    }
}

/// 所有目标合入完整候选后才统一重算，使共享源复用和工作量预算覆盖整次预览。
pub(crate) fn refresh(before: &Document, after: &mut Document) -> Result<()> {
    let changed: Vec<_> = after
        .walk()
        .into_iter()
        .filter_map(|(_, _, layer)| {
            let LayerContent::Smart(current) = &layer.content else {
                return None;
            };
            let previous = before.layer(layer.id).and_then(|layer| {
                if let LayerContent::Smart(s) = &layer.content {
                    Some(s)
                } else {
                    None
                }
            });
            previous
                .is_none_or(|old| {
                    old.transform != current.transform || old.source != current.source
                })
                .then_some(layer.id)
        })
        .collect();
    if changed.is_empty() {
        return Ok(());
    }
    let graph = inspect_document_sources(after).map_err(|failure| error(failure.message))?;
    crate::smart_source_render::refresh_instances(after, &changed, &graph)
}
