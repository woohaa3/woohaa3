use super::*;
use photocraft_doc::{
    Affine, ColorMode, Layer, LayerMask, SampleType, Size, SmartObject, Surface,
};
use std::sync::Arc;

fn source(count: usize) -> SmartSource {
    let mut doc = Document::new("源", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
    doc.layers = (0..count)
        .map(|i| Layer::raster(format!("空层{i}"), doc.pixel_format()))
        .collect();
    SmartSource::Embedded {
        file_name: "source.pcraft".into(),
        bytes: Arc::new(photocraft_format::save_to_bytes(&doc, &Default::default()).unwrap()),
    }
}
fn fixture() -> (Document, LayerId, LayerId, LayerId) {
    let mut doc = Document::new("父", Size::new(32, 24), ColorMode::Rgb, SampleType::U8);
    let mut a = Layer::new(
        "原件",
        LayerContent::Smart(SmartObject::new(source(1), Affine::IDENTITY, None)),
    );
    a.mask = Some(LayerMask::reveal_all());
    let mut b = a.duplicate();
    b.visible = false;
    let LayerContent::Smart(s) = &mut b.content else {
        unreachable!()
    };
    s.transform.m = [2.0, 0.0, 1e-8, 1.0, 5.0, -3.0];
    s.cache = Some(Surface::new(doc.pixel_format()));
    let independent = Layer::new(
        "独立",
        LayerContent::Smart(SmartObject::new(source(1), Affine::IDENTITY, None)),
    );
    let ids = (a.id, b.id, independent.id);
    doc.layers = vec![a, Layer::group("组", vec![b]), independent];
    (doc, ids.0, ids.1, ids.2)
}

fn session_fixture() -> (Session, LayerId, LayerId, LayerId) {
    let (doc, a, b, independent) = fixture();
    let mut session = Session::new();
    session.add_document(doc, None);
    let state = session.active_mut().unwrap();
    state.active_layer = Some(a);
    state.selected_layers = vec![a, b];
    state.layer_anchor = Some(b);
    let parent = state.doc.id;
    let LayerContent::Smart(smart) = &state.doc.layer(a).unwrap().content else {
        unreachable!()
    };
    let shared = smart.contents_id;
    let LayerContent::Smart(smart) = &state.doc.layer(independent).unwrap().content else {
        unreachable!()
    };
    let other = smart.contents_id;
    for contents_id in [shared, other] {
        session
            .smart_links
            .push(photocraft_engine::smart_cmds::SmartLink {
                child: photocraft_doc::DocId::fresh(),
                parent,
                layer: a,
                contents_id,
            });
    }
    (session, a, b, independent)
}

// 仅模拟重算的返回契约，不生成像素，也不把它作为真实外观证据。
fn blank_cache(document: &mut Document, id: LayerId) -> Result<()> {
    let format = document.pixel_format();
    let LayerContent::Smart(smart) = &mut document.layer_mut(id).unwrap().content else {
        unreachable!()
    };
    smart.cache = Some(Surface::new(format));
    Ok(())
}

#[test]
fn transaction_publishes_once_preserves_selection_and_detaches_only_replaced_links() {
    let (mut session, a, b, _) = session_fixture();
    let child = Document::new("旧内容", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
    session.smart_links[0].child = child.id;
    let child_index = session.add_document(child, None);
    session.set_active(0);
    let before = session.active().unwrap().clone();
    let other_link = session.smart_links[1];
    let transaction = SourceEditTransaction::new(&session, a, source(2)).unwrap();
    let mut calls = Vec::new();
    let changed = transaction
        .finish_with(&mut session, |doc, id| {
            calls.push(id);
            blank_cache(doc, id)
        })
        .unwrap();
    assert_eq!(calls, vec![a, b]);
    assert_eq!(changed, calls);
    let after = session.active().unwrap().clone();
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(after.history.past_len(), before.history.past_len() + 1);
    assert_eq!(after.selected_layers(), before.selected_layers());
    assert_eq!(after.active_layer, before.active_layer);
    assert_eq!(after.layer_anchor, before.layer_anchor);
    assert_eq!(session.smart_links, vec![other_link]);
    // 真实上游回写入口在找不到关联时直接返回，不编码或渲染旧子文档。
    assert!(!photocraft_engine::smart_cmds::commit_child(&mut session, child_index).unwrap());
    assert!(Arc::ptr_eq(&session.active().unwrap().doc, &after.doc));
    session
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    assert_eq!(session.active().unwrap().doc, before.doc);
    assert_eq!(
        session.active().unwrap().selected_layers(),
        before.selected_layers()
    );
    // 撤销不复活已失效的子编辑器回写关联。
    assert_eq!(session.smart_links, vec![other_link]);
    session
        .execute("edit.redo", serde_json::Value::Null)
        .unwrap();
    assert_eq!(session.active().unwrap().doc, after.doc);
    assert_eq!(
        session.active().unwrap().selected_layers(),
        after.selected_layers()
    );
}

#[test]
fn second_instance_failure_or_missing_cache_preserves_document_history_redo_and_links() {
    for missing_cache in [false, true] {
        let (mut session, a, b, _) = session_fixture();
        session
            .execute(
                "layer.setProps",
                serde_json::json!({"layer": a.0, "name": "临时"}),
            )
            .unwrap();
        session
            .execute("edit.undo", serde_json::Value::Null)
            .unwrap();
        let before = session.active().unwrap().clone();
        let links = session.smart_links.clone();
        let transaction = SourceEditTransaction::new(&session, a, source(2)).unwrap();
        let result = transaction.finish_with(&mut session, |doc, id| {
            if id == b {
                if missing_cache {
                    return Ok(());
                }
                return Err(error("第二个实例重算失败"));
            }
            blank_cache(doc, id)
        });
        assert!(result.is_err());
        let after = session.active().unwrap();
        assert!(Arc::ptr_eq(&before.doc, &after.doc));
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.history.past_len(), before.history.past_len());
        assert!(after.history.can_redo());
        assert_eq!(session.smart_links, links);
        session
            .execute("edit.redo", serde_json::Value::Null)
            .unwrap();
        assert_eq!(session.active().unwrap().doc.layer(a).unwrap().name, "临时");
    }
}

#[test]
fn stale_transaction_rejects_before_recompute_after_edit_undo_selection_or_document_switch() {
    for change in 0..4 {
        let (mut session, a, _, independent) = session_fixture();
        let transaction = SourceEditTransaction::new(&session, a, source(2)).unwrap();
        match change {
            0 | 1 => {
                session
                    .execute(
                        "layer.setProps",
                        serde_json::json!({"layer": a.0, "name": "新名"}),
                    )
                    .unwrap();
                if change == 1 {
                    session
                        .execute("edit.undo", serde_json::Value::Null)
                        .unwrap();
                }
            }
            2 => {
                session
                    .execute("layer.select", serde_json::json!({"layer": independent.0}))
                    .unwrap();
            }
            _ => {
                session.add_document(
                    Document::new("另一个", Size::new(1, 1), ColorMode::Rgb, SampleType::U8),
                    None,
                );
            }
        }
        let before = session.active().unwrap().clone();
        let links = session.smart_links.clone();
        assert!(
            transaction
                .finish_with(&mut session, |_, _| panic!("过期事务不得重算"))
                .is_err()
        );
        assert!(Arc::ptr_eq(&session.active().unwrap().doc, &before.doc));
        assert_eq!(session.active().unwrap().revision, before.revision);
        assert_eq!(session.smart_links, links);
    }
}

#[test]
fn cancellation_and_identical_source_preserve_redo_and_child_links() {
    let (mut session, a, _, _) = session_fixture();
    session
        .execute(
            "layer.setProps",
            serde_json::json!({"layer": a.0, "name": "新名"}),
        )
        .unwrap();
    session
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    let before = session.active().unwrap().clone();
    let links = session.smart_links.clone();
    let transaction = SourceEditTransaction::new(&session, a, source(2)).unwrap();
    drop(transaction);
    let LayerContent::Smart(smart) = &before.doc.layer(a).unwrap().content else {
        unreachable!()
    };
    let transaction = SourceEditTransaction::new(&session, a, smart.source.clone()).unwrap();
    assert!(
        transaction
            .finish_with(&mut session, |_, _| panic!("无变化不得重算"))
            .unwrap()
            .is_empty()
    );
    assert!(Arc::ptr_eq(&session.active().unwrap().doc, &before.doc));
    assert_eq!(session.active().unwrap().revision, before.revision);
    assert!(session.active().unwrap().history.can_redo());
    assert_eq!(session.smart_links, links);
}
#[test]
fn shared_replacement_preserves_instances_and_independent_source_without_rendering() {
    let (doc, a, b, independent) = fixture();
    let before = doc.clone();
    let replacement = source(2);
    let prepared = prepare(&doc, a, replacement.clone()).unwrap();
    assert_eq!(doc, before);
    assert_eq!(prepared.instances, vec![a, b]);
    assert_eq!(prepared.document.layer(independent), doc.layer(independent));
    for id in [a, b] {
        let mut expected = doc.layer(id).unwrap().clone();
        let LayerContent::Smart(s) = &mut expected.content else {
            unreachable!()
        };
        s.source = replacement.clone();
        s.cache = None;
        assert_eq!(prepared.document.layer(id), Some(&expected));
    }
    assert_eq!(prepared.sources.resources.layer_count, 9);
    let bytes =
        photocraft_format::save_to_bytes(&prepared.document, &Default::default()).unwrap();
    let loaded = photocraft_format::load_from_bytes_with(
        &bytes,
        &photocraft_format::LoadOptions {
            preserve_ids: true,
            ..Default::default()
        },
    )
    .unwrap();
    let hash = |d: &Document| {
        crate::document_content::document_content_hash(d, &Default::default()).unwrap()
    };
    assert_eq!(hash(&loaded), hash(&prepared.document));
    assert_ne!(hash(&doc), hash(&prepared.document));
    // 事务准备不开放普通上传。
    assert!(photocraft_project_verify::verify(&bytes).is_err());
}
#[test]
fn bad_source_shared_budget_and_bounds_reject_atomically() {
    let (mut doc, a, b, _) = fixture();
    let LayerContent::Smart(s) = &mut doc.layer_mut(b).unwrap().content else {
        unreachable!()
    };
    s.transform.m[0] = 500.0;
    inspect_document_sources(&doc).unwrap();
    for replacement in [
        SmartSource::Linked {
            path: "/never/read".into(),
        },
        SmartSource::Embedded {
            file_name: "broken.pcraft".into(),
            bytes: Arc::new(vec![1]),
        },
    ] {
        let before = doc.clone();
        assert!(prepare(&doc, a, replacement).is_err());
        assert_eq!(doc, before);
    }
    let before = doc.clone();
    assert!(
        prepare(&doc, a, source(31))
            .err()
            .unwrap()
            .to_string()
            .contains("累计图层")
    );
    assert_eq!(doc, before);
    // 共享实例自己的变换必须逐个验证：新源尺寸不能只检查活动层。
    let mut large = Document::new("大源", Size::new(32, 12), ColorMode::Rgb, SampleType::U8);
    large.layers.push(Layer::raster("空", large.pixel_format()));
    let replacement = SmartSource::Embedded {
        file_name: "large.pcraft".into(),
        bytes: Arc::new(photocraft_format::save_to_bytes(&large, &Default::default()).unwrap()),
    };
    assert!(
        prepare(&doc, a, replacement)
            .err()
            .unwrap()
            .to_string()
            .contains("源边界超限")
    );
    assert_eq!(doc, before);
}
#[test]
fn locked_hidden_instance_or_ancestor_rejects_whole_replacement() {
    let (mut doc, a, b, _) = fixture();
    doc.layer_mut(b).unwrap().locks.all = true;
    assert!(
        prepare(&doc, a, source(2))
            .err()
            .unwrap()
            .to_string()
            .contains("锁定")
    );
    doc.layer_mut(b).unwrap().locks.all = false;
    doc.layers[1].locks.all = true;
    let before = doc.clone();
    assert!(prepare(&doc, a, source(2)).is_err());
    assert_eq!(doc, before);
}
#[test]
fn identical_source_preserves_cache_and_invalid_old_state_cannot_be_repaired_silently() {
    let (mut doc, a, b, independent) = fixture();
    let LayerContent::Smart(s) = &doc.layer(a).unwrap().content else {
        unreachable!()
    };
    let prepared = prepare(&doc, a, s.source.clone()).unwrap();
    assert!(prepared.instances.is_empty());
    assert_eq!(prepared.document, doc);
    assert!(prepare(&doc, LayerId::fresh(), source(1)).is_err());
    assert!(prepare(&doc, doc.layers[1].id, source(1)).is_err());
    let LayerContent::Smart(other) = &doc.layer(independent).unwrap().content else {
        unreachable!()
    };
    let wrong = other.contents_id;
    let LayerContent::Smart(shared) = &mut doc.layer_mut(b).unwrap().content else {
        unreachable!()
    };
    shared.contents_id = wrong;
    shared.source = source(2);
    assert!(prepare(&doc, a, source(1)).is_err());
}
#[test]
fn smart_contents_edit_keeps_parent_private_and_commits_shared_instances_once() {
    let (mut session, a, b, independent) = session_fixture();
    let base = session.active().unwrap().clone();
    let links = session.smart_links.clone();
    let edit = SourceContentsEdit::new(&session, a).unwrap();
    let mut child = edit.document().clone();
    child.layers[0].name = "编辑后的内容".into();
    let transaction = edit.prepare(&session, &child).unwrap();
    assert_eq!(transaction.prepared.instances, vec![a, b]);
    assert!(Arc::ptr_eq(&session.active().unwrap().doc, &base.doc));
    assert_eq!(session.smart_links, links);
    assert_eq!(
        transaction.prepared.document.layer(independent),
        base.doc.layer(independent)
    );
    transaction.finish_with(&mut session, blank_cache).unwrap();
    assert_eq!(
        session.active().unwrap().history.past_len(),
        base.history.past_len() + 1
    );
    let LayerContent::Smart(smart) = &session.active().unwrap().doc.layer(a).unwrap().content
    else {
        unreachable!()
    };
    let verified = photocraft_project_verify::smart_source::load(&smart.source).unwrap();
    assert_eq!(verified.document.layers[0].name, "编辑后的内容");
    assert!(edit.prepare(&session, &child).is_err());
    session
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    assert_eq!(
        contents_hash(&session.active().unwrap().doc).unwrap(),
        contents_hash(&base.doc).unwrap()
    );
    session
        .execute("edit.redo", serde_json::Value::Null)
        .unwrap();
    assert_eq!(
        session.active().unwrap().selected_layers(),
        base.selected_layers()
    );
}
#[test]
fn smart_contents_noop_and_cancel_preserve_source_bytes_redo_and_links() {
    let (mut session, a, _, _) = session_fixture();
    session
        .edit("临时标题", |doc, _| {
            doc.name = "临时".into();
            Ok(())
        })
        .unwrap();
    session
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    assert!(session.active().unwrap().history.can_redo());
    let base = session.active().unwrap().clone();
    let links = session.smart_links.clone();
    let edit = SourceContentsEdit::new(&session, a).unwrap();
    let mut child = edit.document().clone();
    child.name = "仅子窗口标题".into();
    let transaction = edit.prepare(&session, &child).unwrap();
    assert!(transaction.prepared.instances.is_empty());
    transaction
        .finish_with(&mut session, |_, _| panic!("无变化不重算"))
        .unwrap();
    assert!(Arc::ptr_eq(&session.active().unwrap().doc, &base.doc));
    assert_eq!(session.smart_links, links);
    assert_eq!(
        session.active().unwrap().history.past_len(),
        base.history.past_len()
    );
    drop(edit);
    assert!(session.active().unwrap().history.can_redo());
    assert!(Arc::ptr_eq(&session.active().unwrap().doc, &base.doc));
}
#[test]
fn smart_contents_invalid_or_over_budget_child_can_be_corrected_without_publishing() {
    let (session, a, _, _) = session_fixture();
    let base = session.active().unwrap().clone();
    let links = session.smart_links.clone();
    let edit = SourceContentsEdit::new(&session, a).unwrap();
    let mut child = edit.document().clone();
    child.mode = ColorMode::Cmyk;
    assert!(edit.prepare(&session, &child).is_err());
    child = edit.document().clone();
    child.layers = (0..32)
        .map(|_| Layer::raster("超预算", child.pixel_format()))
        .collect();
    assert!(edit.prepare(&session, &child).is_err());
    assert!(Arc::ptr_eq(&session.active().unwrap().doc, &base.doc));
    assert_eq!(session.smart_links, links);
    child = edit.document().clone();
    child.layers[0].name = "修正后".into();
    assert!(edit.prepare(&session, &child).is_ok());
}
#[test]
fn smart_contents_full_source_identity_detects_resolution_and_rejects_stale_parent() {
    let (mut session, a, _, _) = session_fixture();
    let edit = SourceContentsEdit::new(&session, a).unwrap();
    let mut child = edit.document().clone();
    child.resolution_dpi += 1.0;
    let transaction = edit.prepare(&session, &child).unwrap();
    assert_eq!(transaction.prepared.instances.len(), 2);
    session.active_mut().unwrap().selected_layers = vec![a];
    assert!(edit.prepare(&session, &child).is_err());
}
