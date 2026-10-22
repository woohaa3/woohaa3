//! 智能对象的普通共享复制与独立副本；核验完整候选后才发布一步历史。
use crate::{EditorError, Result};
use photocraft_doc::{LayerContent, LayerId, SmartContentsId};
use photocraft_engine::Session;
use photocraft_project_verify::smart_source::inspect_document_sources;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyKind {
    /// 普通多层/组复制，组内对象仍与当前文档原实例共享源身份。
    Shared,
    /// Photoshop“通过拷贝新建智能对象”：仅接受一个智能对象。
    Independent,
}
fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "smart.copy".into(),
        message: message.to_string(),
    }
}

/// 仅用于原生接入基础，不开放 Editor/WASM 命令或普通 Smart 工程上传。
/// IDs 为当前文档的目标；祖先/后代同时给出时只复制祖先，每个副本留在原父组。
pub fn duplicate(session: &mut Session, ids: &[LayerId], kind: CopyKind) -> Result<Vec<LayerId>> {
    let base = session.active().ok_or(EditorError::NoDocument)?.clone();
    if ids.is_empty() {
        return Err(error("请先选择要复制的图层"));
    }
    for id in ids {
        base.doc
            .path_of(*id)
            .ok_or_else(|| error("目标图层不存在"))?;
    }
    inspect_document_sources(&base.doc).map_err(|failure| error(failure.message))?;
    let mut chosen = base.clone();
    chosen.selected_layers = ids.to_vec();
    chosen.active_layer = ids.last().copied();
    let roots = crate::layer_preview::selected_roots(&chosen);
    for id in &roots {
        let path = base.doc.path_of(*id).unwrap();
        // 允许复制本身锁定的层并保留锁定，但不能在全部锁定的父组内插入内容。
        if path.len() > 1
            && base
                .doc
                .layer_at(&path[..path.len() - 1])
                .is_some_and(|parent| base.doc.effective_locks(parent.id).all)
        {
            return Err(error("目标父组已全部锁定，请先解锁"));
        }
    }
    if kind == CopyKind::Independent
        && (roots.len() != 1
            || !matches!(
                base.doc.layer(roots[0]).map(|layer| &layer.content),
                Some(LayerContent::Smart(_))
            ))
    {
        return Err(error("请只选择一个智能对象来创建独立副本"));
    }
    let additional = crate::layer_preview::target_layer_count(&base.doc, &roots);
    if crate::layer_preview::layer_count(&base.doc.layers).saturating_add(additional)
        > photocraft_project_verify::MAX_LAYERS
    {
        return Err(error("复制结果超过工程图层上限（64 层）"));
    }
    // 复用上游命名、原位插入、普通背景层处理和递归新 LayerId，不复制输入栈。
    let active = base
        .active_layer
        .and_then(|active| base.doc.path_of(active))
        .and_then(|active| {
            roots.iter().copied().find(|id| {
                base.doc
                    .path_of(*id)
                    .is_some_and(|path| active.starts_with(&path))
            })
        })
        .or_else(|| roots.last().copied());
    let mut scratch = Session::new();
    scratch.add_document((*base.doc).clone(), None);
    let state = scratch.active_mut().unwrap();
    *state = base.clone();
    state.selected_layers = roots;
    state.active_layer = active;
    let label = if kind == CopyKind::Independent {
        "通过拷贝新建智能对象"
    } else {
        "复制图层"
    };
    photocraft_engine::layer_multi_cmds::duplicate_selected(&mut scratch, true, label)
        .map_err(error)?;
    let state = scratch.active_mut().unwrap();
    let copies = state.selected_layers();
    if kind == CopyKind::Independent {
        let copy = Arc::make_mut(&mut state.doc)
            .layer_mut(copies[0])
            .ok_or_else(|| error("副本不存在"))?;
        let LayerContent::Smart(smart) = &mut copy.content else {
            return Err(error("副本不是智能对象"));
        };
        // 字节不可变，可保留同一快照和外观；独立性由新 contents_id 决定。
        smart.contents_id = SmartContentsId::fresh();
        smart.psd_raw = None;
        copy.psd_blocks
            .retain(|(key, _)| ![b"SoLd", b"PlLd", b"SoLE"].contains(&key));
    }
    inspect_document_sources(&state.doc).map_err(|failure| error(failure.message))?;
    crate::preview_history::commit_selected(
        session,
        state.doc.clone(),
        state.active_layer,
        copies.clone(),
        label,
    )
    .map_err(error)?;
    // 复制不替换旧源，不清除或复制原子编辑器关联。
    Ok(copies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        document_content::{AssetRegistry, document_content_hash},
        smart_source_edit,
    };
    use photocraft_doc::{
        Affine, ColorMode, Document, Layer, LayerMask, SampleType, Size, SmartObject, SmartSource,
        Surface,
    };

    fn source(count: usize) -> SmartSource {
        let mut doc = Document::new("源", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
        doc.layers = (0..count)
            .map(|_| Layer::raster("空", doc.pixel_format()))
            .collect();
        SmartSource::Embedded {
            file_name: "source.pcraft".into(),
            bytes: Arc::new(photocraft_format::save_to_bytes(&doc, &Default::default()).unwrap()),
        }
    }
    fn fixture(count: usize) -> (Session, LayerId) {
        let mut doc = Document::new("父", Size::new(32, 24), ColorMode::Rgb, SampleType::U8);
        let mut layer = Layer::new(
            "对象",
            LayerContent::Smart(SmartObject::new(
                source(count),
                Affine {
                    m: [2.0, 0.0, 1e-8, 1.0, 5.0, -3.0],
                },
                Some(Surface::new(doc.pixel_format())),
            )),
        );
        layer.mask = Some(LayerMask::reveal_all());
        layer.opacity = 0.75;
        let id = layer.id;
        doc.layers = vec![layer];
        let mut session = Session::new();
        session.add_document(doc, None);
        session.active_mut().unwrap().active_layer = Some(id);
        session.active_mut().unwrap().selected_layers = vec![id];
        let LayerContent::Smart(smart) = &session.active().unwrap().doc.layer(id).unwrap().content
        else {
            unreachable!()
        };
        session
            .smart_links
            .push(photocraft_engine::smart_cmds::SmartLink {
                child: photocraft_doc::DocId::fresh(),
                parent: session.active().unwrap().doc.id,
                layer: id,
                contents_id: smart.contents_id,
            });
        (session, id)
    }
    fn smart(doc: &Document, id: LayerId) -> &SmartObject {
        let LayerContent::Smart(smart) = &doc.layer(id).unwrap().content else {
            panic!("测试目标应为智能对象")
        };
        smart
    }
    fn hash(doc: &Document) -> String {
        document_content_hash(doc, &AssetRegistry::default()).unwrap()
    }

    #[test]
    fn independent_copy_drops_only_stale_placed_blocks_while_shared_copy_keeps_them() {
        let (mut session, a) = fixture(1);
        let doc = Arc::make_mut(&mut session.active_mut().unwrap().doc);
        let layer = doc.layer_mut(a).unwrap();
        for key in [*b"SoLd", *b"PlLd", *b"SoLE", *b"name"] {
            layer.psd_blocks.push((key, Arc::new(vec![1, 2, 3])));
        }
        let original = layer.psd_blocks.clone();
        let shared = duplicate(&mut session, &[a], CopyKind::Shared).unwrap()[0];
        let independent = duplicate(&mut session, &[a], CopyKind::Independent).unwrap()[0];
        let doc = &session.active().unwrap().doc;
        assert_eq!(doc.layer(a).unwrap().psd_blocks, original);
        assert_eq!(doc.layer(shared).unwrap().psd_blocks, original);
        assert_eq!(
            doc.layer(independent).unwrap().psd_blocks,
            vec![original[3].clone()]
        );
    }

    #[test]
    fn shared_copy_and_independent_copy_keep_snapshots_but_replace_different_instance_sets() {
        let (mut session, original) = fixture(1);
        let before = session.active().unwrap().clone();
        let links = session.smart_links.clone();
        let shared = duplicate(&mut session, &[original], CopyKind::Shared).unwrap()[0];
        let independent = duplicate(&mut session, &[original], CopyKind::Independent).unwrap()[0];
        let state = session.active().unwrap();
        assert_eq!(state.revision, before.revision + 2);
        assert_eq!(state.history.past_len(), before.history.past_len() + 2);
        assert_eq!(state.selected_layers(), vec![independent]);
        assert_eq!(
            smart(&state.doc, original).contents_id,
            smart(&state.doc, shared).contents_id
        );
        assert_ne!(
            smart(&state.doc, original).contents_id,
            smart(&state.doc, independent).contents_id
        );
        for copy in [shared, independent] {
            let mut expected = before.doc.layer(original).unwrap().clone();
            let actual = state.doc.layer(copy).unwrap();
            expected.id = actual.id;
            expected.name = actual.name.clone();
            if let LayerContent::Smart(contents) = &mut expected.content {
                contents.contents_id = smart(&state.doc, copy).contents_id;
            }
            assert_eq!(actual, &expected);
            let (SmartSource::Embedded { bytes: a, .. }, SmartSource::Embedded { bytes: b, .. }) = (
                &smart(&state.doc, original).source,
                &smart(&state.doc, copy).source,
            ) else {
                unreachable!()
            };
            assert!(Arc::ptr_eq(a, b));
        }
        let prepared = smart_source_edit::prepare(&state.doc, original, source(2)).unwrap();
        assert_eq!(prepared.instances.len(), 2);
        assert!(prepared.instances.contains(&original) && prepared.instances.contains(&shared));
        assert_eq!(
            prepared.document.layer(independent),
            state.doc.layer(independent)
        );
        let independent_edit =
            smart_source_edit::prepare(&state.doc, independent, source(2)).unwrap();
        assert_eq!(independent_edit.instances, vec![independent]);
        assert_eq!(
            independent_edit.document.layer(original),
            state.doc.layer(original)
        );
        assert_eq!(session.smart_links, links);
        let after = state.doc.clone();
        session
            .execute("edit.undo", serde_json::Value::Null)
            .unwrap();
        assert!(session.active().unwrap().doc.layer(independent).is_none());
        assert_eq!(session.active().unwrap().selected_layers(), vec![shared]);
        session
            .execute("edit.redo", serde_json::Value::Null)
            .unwrap();
        assert_eq!(session.active().unwrap().doc, after);
        let bytes = photocraft_format::save_to_bytes(&after, &Default::default()).unwrap();
        let loaded = photocraft_format::load_from_bytes_with(
            &bytes,
            &photocraft_format::LoadOptions {
                preserve_ids: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hash(&loaded), hash(&after));
        assert_eq!(
            smart(&loaded, original).contents_id,
            smart(&loaded, shared).contents_id
        );
        assert_ne!(
            smart(&loaded, original).contents_id,
            smart(&loaded, independent).contents_id
        );
        assert!(photocraft_project_verify::verify(&bytes).is_err());
    }

    #[test]
    fn group_copy_deduplicates_ancestors_and_preserves_internal_and_external_sharing() {
        let (mut session, a) = fixture(1);
        let doc = Arc::make_mut(&mut session.active_mut().unwrap().doc);
        let original = doc.remove(a).unwrap();
        let outside = original.duplicate();
        let outside_id = outside.id;
        let group = Layer::group("组", vec![original]);
        let group_id = group.id;
        doc.layers = vec![group, outside];
        let state = session.active_mut().unwrap();
        state.active_layer = Some(a);
        state.selected_layers = vec![group_id, a];
        let before = state.clone();
        let copies = duplicate(&mut session, &[group_id, a, group_id], CopyKind::Shared).unwrap();
        assert_eq!(copies.len(), 1);
        let state = session.active().unwrap();
        let child = state.doc.layer(copies[0]).unwrap().children().unwrap()[0].id;
        assert_ne!(child, a);
        assert_eq!(
            smart(&state.doc, child).contents_id,
            smart(&state.doc, outside_id).contents_id
        );
        let edit = smart_source_edit::prepare(&state.doc, child, source(2)).unwrap();
        assert_eq!(edit.instances.len(), 3);
        assert!(edit.instances.contains(&outside_id));
        assert_eq!(
            state.doc.layers.iter().map(|l| l.id).collect::<Vec<_>>(),
            vec![group_id, copies[0], outside_id]
        );
        session
            .execute("edit.undo", serde_json::Value::Null)
            .unwrap();
        assert_eq!(session.active().unwrap().doc, before.doc);
        assert_eq!(
            session.active().unwrap().selected_layers(),
            before.selected_layers()
        );
    }

    #[test]
    fn batch_copy_keeps_each_parent_and_active_copy_in_one_history_step() {
        let (mut session, a) = fixture(1);
        let doc = Arc::make_mut(&mut session.active_mut().unwrap().doc);
        let b = doc.layer(a).unwrap().duplicate();
        let b_id = b.id;
        let group = Layer::group("组", vec![b]);
        let group_id = group.id;
        doc.layers.push(group);
        let before = session.active().unwrap().clone();
        let copies = duplicate(&mut session, &[b_id, a], CopyKind::Shared).unwrap();
        assert_eq!(copies.len(), 2);
        let state = session.active().unwrap();
        assert_eq!(state.revision, before.revision + 1);
        assert_eq!(state.active_layer, Some(copies[0]));
        assert_eq!(
            state.doc.path_of(copies[1]).unwrap()[..1],
            state.doc.path_of(b_id).unwrap()[..1]
        );
        assert_eq!(
            state.doc.layer(group_id).unwrap().children().unwrap().len(),
            2
        );
        assert_eq!(state.doc.layers[1].id, copies[0]);
        assert_eq!(
            smart(&state.doc, copies[0]).contents_id,
            smart(&state.doc, copies[1]).contents_id
        );
    }

    #[test]
    fn source_tree_budget_rejects_whole_copy_preserving_redo_and_links() {
        for kind in [CopyKind::Shared, CopyKind::Independent] {
            let (mut session, a) = fixture(32);
            session
                .execute(
                    "layer.setProps",
                    serde_json::json!({"layer":a.0,"name":"改名"}),
                )
                .unwrap();
            session
                .execute("edit.undo", serde_json::Value::Null)
                .unwrap();
            let before = session.active().unwrap().clone();
            let links = session.smart_links.clone();
            assert!(
                duplicate(&mut session, &[a], kind)
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("累计图层")
            );
            let state = session.active().unwrap();
            assert!(Arc::ptr_eq(&state.doc, &before.doc));
            assert_eq!(state.revision, before.revision);
            assert!(state.history.can_redo());
            assert_eq!(session.smart_links, links);
        }
        let (mut session, a) = fixture(31);
        duplicate(&mut session, &[a], CopyKind::Shared).unwrap();
        assert_eq!(
            inspect_document_sources(&session.active().unwrap().doc)
                .unwrap()
                .resources
                .layer_count,
            64
        );
        assert!(duplicate(&mut session, &[a], CopyKind::Shared).is_err());
    }

    #[test]
    fn invalid_targets_and_locked_parent_reject_but_layer_locks_are_preserved() {
        let (mut session, a) = fixture(1);
        for ids in [vec![], vec![LayerId::fresh()]] {
            assert!(duplicate(&mut session, &ids, CopyKind::Shared).is_err());
        }
        let doc = Arc::make_mut(&mut session.active_mut().unwrap().doc);
        doc.layer_mut(a).unwrap().locks.all = true;
        let copy = duplicate(&mut session, &[a], CopyKind::Independent).unwrap()[0];
        assert!(session.active().unwrap().doc.layer(copy).unwrap().locks.all);
        assert!(duplicate(&mut session, &[a, copy], CopyKind::Independent).is_err());
        let doc = Arc::make_mut(&mut session.active_mut().unwrap().doc);
        let child = doc.remove(a).unwrap();
        let mut group = Layer::group("锁定父组", vec![child]);
        group.locks.all = true;
        let group_id = group.id;
        doc.layers.push(group);
        let before = session.active().unwrap().clone();
        assert!(
            duplicate(&mut session, &[a], CopyKind::Shared)
                .err()
                .unwrap()
                .to_string()
                .contains("父组")
        );
        assert!(duplicate(&mut session, &[group_id], CopyKind::Independent).is_err());
        assert!(Arc::ptr_eq(&session.active().unwrap().doc, &before.doc));
        // 同时给出锁定组和它的后代时，实际插入点是根级，不能误按组内插入拒绝。
        let group_copy = duplicate(&mut session, &[group_id, a], CopyKind::Shared).unwrap();
        assert_eq!(group_copy.len(), 1);
        assert!(
            session
                .active()
                .unwrap()
                .doc
                .layer(group_copy[0])
                .unwrap()
                .locks
                .all
        );
    }
}
