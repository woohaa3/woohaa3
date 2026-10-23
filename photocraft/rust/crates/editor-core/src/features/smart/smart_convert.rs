//! 转换沿原生图层语义执行；完整候选通过源树核验后才发布。
use crate::{EditorError, Result};
use photocraft_doc::{Document, Layer, LayerContent, LayerId, Rect, SmartSource};
use photocraft_engine::Session;
use photocraft_project_verify::{limits, smart_source::inspect_document_sources};
use std::{collections::HashSet, sync::Arc};

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "smart.convert".into(),
        message: message.to_string(),
    }
}

/// 走真实合成；本次只检查私有构造替身及拒绝分支，未执行完整合成路径。
/// 本入口不开放 Editor/WASM 命令或普通 Smart 工程上传。
pub fn convert(session: &mut Session, ids: &[LayerId]) -> Result<LayerId> {
    convert_using(session, ids, |doc, roots| {
        let restored = restore_inputs(doc, roots)?;
        let doc = &restored;
        render_region(doc, roots)?;
        let top = doc.layer(*roots.last().unwrap()).unwrap();
        let mut layer = if roots.len() == 1 {
            photocraft_engine::smart_cmds::layer_to_smart(doc, top)
        } else {
            photocraft_engine::smart_cmds::layers_to_smart(
                doc,
                &top.name,
                roots
                    .iter()
                    .map(|id| doc.layer(*id).unwrap().clone())
                    .collect(),
            )
        }
        .map_err(error)?;
        // 图层名可包含路径字符，嵌入源名不承担文件路径语义。
        if let LayerContent::Smart(smart) = &mut layer.content {
            if let SmartSource::Embedded { file_name, .. } = &mut smart.source {
                *file_name = "contents.pcraft".into();
            }
        }
        Ok(layer)
    })
}

fn restore_inputs(document: &Document, roots: &[LayerId]) -> Result<Document> {
    let mut restored = document.clone();
    let paths: Vec<_> = roots
        .iter()
        .map(|id| document.path_of(*id).unwrap())
        .collect();
    let mut objects = Vec::new();
    let mut texts = Vec::new();
    for (path, _, layer) in document.walk() {
        if !paths.iter().any(|root| path.starts_with(root)) {
            continue;
        }
        match &layer.content {
            LayerContent::Smart(_) => objects.push(layer.id),
            LayerContent::Text(_) => texts.push(layer.id),
            _ => {}
        }
    }
    if !objects.is_empty() {
        let graph = inspect_document_sources(&restored).map_err(|e| error(e.message))?;
        crate::smart_source_render::refresh_instances(&mut restored, &objects, &graph)?;
    }
    if !texts.is_empty() {
        let dpi = restored.resolution_dpi;
        let format = restored.pixel_format();
        let mut engine = photocraft_text::shared()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for id in texts {
            let LayerContent::Text(text) = &mut restored.layer_mut(id).unwrap().content else {
                unreachable!()
            };
            text.cache = None;
            engine.render_layer(text, dpi, format);
            if text.cache.is_none() {
                return Err(error("无法恢复转换目标的文字外观"));
            }
        }
    }
    Ok(restored)
}

fn convert_using(
    session: &mut Session,
    ids: &[LayerId],
    build: impl FnOnce(&Document, &[LayerId]) -> Result<Layer>,
) -> Result<LayerId> {
    let base = session.active().ok_or(EditorError::NoDocument)?.clone();
    if ids.is_empty() {
        return Err(error("请先选择要转换的图层"));
    }
    for id in ids {
        if base.doc.layer(*id).is_none() {
            return Err(error("目标图层不存在"));
        }
    }
    let graph = inspect_document_sources(&base.doc).map_err(|e| error(e.message))?;
    if graph.resources.layer_count.saturating_add(1) > limits::MAX_LAYERS {
        return Err(error("转换后的完整源树超过 64 层"));
    }
    let mut chosen = base.clone();
    chosen.selected_layers = ids.to_vec();
    chosen.active_layer = ids.last().copied();
    let roots: HashSet<_> = crate::layer_preview::selected_roots(&chosen)
        .into_iter()
        .collect();
    let roots: Vec<_> = base
        .doc
        .walk()
        .into_iter()
        .filter_map(|(_, _, layer)| roots.contains(&layer.id).then_some(layer.id))
        .collect();
    if roots.iter().any(|id| base.doc.effective_locks(*id).all) {
        return Err(error("目标或父组已全部锁定，请先解锁"));
    }
    render_region(&base.doc, &roots)?;
    let converted = build(&base.doc, &roots)?;
    if !matches!(&converted.content, LayerContent::Smart(smart) if smart.cache.is_some()) {
        return Err(error("转换没有返回完整智能对象外观"));
    }
    if base.doc.layer(converted.id).is_some() {
        return Err(error("转换结果必须使用新的图层身份"));
    }
    let new_id = converted.id;
    let mut candidate = (*base.doc).clone();
    candidate.insert_above(roots.last().copied(), converted);
    for id in roots {
        candidate.remove(id).ok_or_else(|| error("转换目标丢失"))?;
    }
    inspect_document_sources(&candidate).map_err(|e| error(e.message))?;
    crate::preview_history::commit_selected(
        session,
        Arc::new(candidate),
        Some(new_id),
        vec![new_id],
        "转换为智能对象",
    )
    .map_err(error)?;
    let current = &session.active().unwrap().doc;
    let contents: HashSet<_> = current
        .walk()
        .into_iter()
        .filter_map(|(_, _, layer)| {
            if let LayerContent::Smart(smart) = &layer.content {
                Some(smart.contents_id)
            } else {
                None
            }
        })
        .collect();
    let parent = current.id;
    session
        .smart_links
        .retain(|link| link.parent != parent || contents.contains(&link.contents_id));
    Ok(new_id)
}

/// 原生合成范围的保守上界，在实际合成前拒绝大分配及整数溢出。
fn render_region(doc: &Document, roots: &[LayerId]) -> Result<Rect> {
    fn bounds(layer: &Layer, canvas: Rect) -> Rect {
        match &layer.content {
            LayerContent::Group(g) => g
                .children
                .iter()
                .map(|l| bounds(l, canvas))
                .fold(Rect::EMPTY, |a, b| a.union(&b)),
            LayerContent::Adjustment(_) | LayerContent::Fill(_) => canvas,
            _ => layer.surface().map_or(Rect::EMPTY, |s| s.content_bounds()),
        }
    }
    let mut region = roots
        .iter()
        .map(|id| bounds(doc.layer(*id).unwrap(), doc.bounds()))
        .fold(doc.bounds(), |a, b| a.union(&b));
    if crate::smart_identity::contains_smart(&doc.layers) {
        region = region.union(&crate::smart_transform::frame(doc, roots)?);
    }
    let paths: Vec<_> = roots.iter().map(|id| doc.path_of(*id).unwrap()).collect();
    let effects = doc.walk().into_iter().any(|(path, _, layer)| {
        paths.iter().any(|root| path.starts_with(root))
            && layer.effects.enabled
            && !layer.effects.items.is_empty()
    });
    let pad = if effects { 256i64 } else { 0 };
    let (x0, y0, x1, y1) = (
        i64::from(region.x0) - pad,
        i64::from(region.y0) - pad,
        i64::from(region.x1) + pad,
        i64::from(region.y1) + pad,
    );
    if x0 < i64::from(i32::MIN)
        || y0 < i64::from(i32::MIN)
        || x1 > i64::from(i32::MAX)
        || y1 > i64::from(i32::MAX)
        || x1 <= x0
        || y1 <= y0
        || (x1 - x0) as u64 * (y1 - y0) as u64 > limits::MAX_CANVAS_PIXELS
    {
        return Err(error("转换合成范围超过像素预算"));
    }
    Ok(Rect::new(x0 as i32, y0 as i32, x1 as i32, y1 as i32))
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Affine, ColorMode, SampleType, Size, SmartObject, Surface};
    use serde_json::Value;

    fn fixture() -> (Session, LayerId, LayerId, LayerId) {
        let mut doc = Document::new("父", Size::new(32, 24), ColorMode::Rgb, SampleType::U8);
        let a = Layer::raster("甲", doc.pixel_format());
        let b = Layer::raster("乙", doc.pixel_format());
        let b_id = b.id;
        let group = Layer::group("组", vec![b]);
        let ids = (a.id, b_id, group.id);
        doc.layers = vec![a, group];
        let mut session = Session::new();
        session.add_document(doc, None);
        session.active_mut().unwrap().active_layer = Some(ids.0);
        session.active_mut().unwrap().selected_layers = vec![ids.0, ids.1];
        (session, ids.0, ids.1, ids.2)
    }
    // 私有构造替身只打包空层；不运行原生转换、渲染、裁切或像素平移。
    fn blank_build(doc: &Document, roots: &[LayerId]) -> Result<Layer> {
        let mut child = Document::new("内容", doc.size, doc.mode, doc.depth);
        child.layers = roots
            .iter()
            .map(|id| doc.layer(*id).unwrap().clone())
            .collect();
        let source = SmartSource::Embedded {
            file_name: "contents.pcraft".into(),
            bytes: Arc::new(photocraft_format::save_to_bytes(&child, &Default::default()).unwrap()),
        };
        Ok(Layer::new(
            "对象",
            LayerContent::Smart(SmartObject::new(
                source,
                Affine::IDENTITY,
                Some(Surface::new(doc.pixel_format())),
            )),
        ))
    }
    #[test]
    fn smart_conversion_uses_document_order_top_parent_and_one_history() {
        let (mut session, a, b, group) = fixture();
        let base = session.active().unwrap().clone();
        let id = convert_using(&mut session, &[b, a], |doc, roots| {
            assert_eq!(roots, &[a, b]);
            blank_build(doc, roots)
        })
        .unwrap();
        let state = session.active().unwrap();
        assert_eq!(state.doc.path_of(id), Some(vec![0, 0]));
        assert_eq!(state.doc.layer(group).unwrap().children().unwrap().len(), 1);
        assert!(state.doc.layer(a).is_none() && state.doc.layer(b).is_none());
        assert_eq!(state.selected_layers(), vec![id]);
        assert_eq!(state.active_layer, Some(id));
        assert_eq!(state.history.past_len(), base.history.past_len() + 1);
        let LayerContent::Smart(smart) = &state.doc.layer(id).unwrap().content else {
            unreachable!()
        };
        let source = photocraft_project_verify::smart_source::load(&smart.source).unwrap();
        assert_eq!(
            source
                .document
                .layers
                .iter()
                .map(|l| l.name.as_str())
                .collect::<Vec<_>>(),
            vec!["甲", "乙"]
        );
        let bytes = photocraft_format::save_to_bytes(&state.doc, &Default::default()).unwrap();
        let loaded = photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(
            crate::document_content::document_content_hash(&loaded, &Default::default()),
            crate::document_content::document_content_hash(&state.doc, &Default::default())
        );
        session.execute("edit.undo", Value::Null).unwrap();
        assert!(session.active().unwrap().doc.layer(a).is_some());
        assert_eq!(
            session.active().unwrap().selected_layers(),
            base.selected_layers()
        );
        session.execute("edit.redo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().selected_layers(), vec![id]);
    }
    #[test]
    fn smart_conversion_deduplicates_ancestors_and_rejects_locked_or_missing_targets() {
        let (mut session, a, b, group) = fixture();
        convert_using(&mut session, &[b, group, group], |doc, roots| {
            assert_eq!(roots, &[group]);
            blank_build(doc, roots)
        })
        .unwrap();
        assert!(session.active().unwrap().doc.layer(a).is_some());
        let (mut session, _, b, group) = fixture();
        Arc::make_mut(&mut session.active_mut().unwrap().doc)
            .layer_mut(group)
            .unwrap()
            .locks
            .all = true;
        let base = session.active().unwrap().clone();
        for targets in [vec![], vec![LayerId(u64::MAX)], vec![b]] {
            assert!(
                convert_using(&mut session, &targets, |_, _| panic!("无效目标不应构造")).is_err()
            );
            assert!(Arc::ptr_eq(&session.active().unwrap().doc, &base.doc));
        }
    }
    #[test]
    fn smart_conversion_builder_and_candidate_failures_preserve_redo_and_document() {
        let (mut session, a, _, _) = fixture();
        session
            .edit("临时", |doc, _| {
                doc.name = "临时".into();
                Ok(())
            })
            .unwrap();
        session.execute("edit.undo", Value::Null).unwrap();
        let base = session.active().unwrap().clone();
        assert!(convert_using(&mut session, &[a], |_, _| Err(error("构造失败"))).is_err());
        assert!(
            convert_using(&mut session, &[a], |doc, _| Ok(Layer::raster(
                "错误类型",
                doc.pixel_format()
            )))
            .is_err()
        );
        assert!(
            convert_using(&mut session, &[a], |doc, roots| {
                let mut layer = blank_build(doc, roots)?;
                let LayerContent::Smart(smart) = &mut layer.content else {
                    unreachable!()
                };
                smart.source = SmartSource::Embedded {
                    file_name: "contents.pcraft".into(),
                    bytes: Arc::new(vec![0]),
                };
                Ok(layer)
            })
            .is_err()
        );
        assert!(Arc::ptr_eq(&session.active().unwrap().doc, &base.doc));
        assert!(session.active().unwrap().history.can_redo());
        assert_eq!(
            session.active().unwrap().selected_layers(),
            base.selected_layers()
        );
    }
    #[test]
    fn smart_conversion_layer_and_render_budgets_reject_before_builder() {
        let (mut session, _, _, _) = fixture();
        let doc = Arc::make_mut(&mut session.active_mut().unwrap().doc);
        doc.layers = (0..64)
            .map(|_| Layer::raster("空", doc.pixel_format()))
            .collect();
        let id = doc.layers[0].id;
        assert!(convert_using(&mut session, &[id], |_, _| panic!("64 层转换后超限")).is_err());
        Arc::make_mut(&mut session.active_mut().unwrap().doc)
            .layers
            .pop();
        convert_using(&mut session, &[id], blank_build).unwrap();
        assert_eq!(
            inspect_document_sources(&session.active().unwrap().doc)
                .unwrap()
                .resources
                .layer_count,
            64
        );
        let (mut session, _, _, _) = fixture();
        let doc = Arc::make_mut(&mut session.active_mut().unwrap().doc);
        doc.size = Size::new(8192, 8192);
        let id = doc.layers[0].id;
        doc.layers[0].effects.items = vec![
            photocraft_engine::layer_style::effect_from_params("dropShadow", &Value::Null).unwrap(),
        ];
        doc.layers[0].effects.enabled = true;
        assert!(convert_using(&mut session, &[id], |_, _| panic!("效果扩边后超限")).is_err());
    }
    #[test]
    fn smart_conversion_detaches_only_parent_links_without_remaining_instances() {
        let (mut session, a, _, _) = fixture();
        let original = blank_build(&session.active().unwrap().doc, &[a]).unwrap();
        let LayerContent::Smart(smart) = &original.content else {
            unreachable!()
        };
        let contents_id = smart.contents_id;
        let second = original.duplicate();
        let ids = [original.id, second.id];
        let doc = Arc::make_mut(&mut session.active_mut().unwrap().doc);
        doc.layers = vec![original, second];
        let parent = doc.id;
        let related = photocraft_engine::smart_cmds::SmartLink {
            child: photocraft_doc::DocId::fresh(),
            parent,
            layer: ids[0],
            contents_id,
        };
        let mut unrelated = related;
        unrelated.parent = photocraft_doc::DocId::fresh();
        unrelated.child = photocraft_doc::DocId::fresh();
        session.smart_links = vec![related, unrelated];
        // 仍有父文档直接实例时，原子编辑关联继续有效。
        convert_using(&mut session, &ids[..1], blank_build).unwrap();
        assert_eq!(session.smart_links, vec![related, unrelated]);
        convert_using(&mut session, &ids[1..], blank_build).unwrap();
        assert_eq!(session.smart_links, vec![unrelated]);
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.smart_links, vec![unrelated]);
    }
}
