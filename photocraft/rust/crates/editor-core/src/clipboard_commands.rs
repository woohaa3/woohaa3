//! 文档内部剪贴板：不读取系统或宿主节点载荷，失败不发布部分结果。
use crate::error::{EditorError, Result};
use photocraft_doc::LayerContent;
use photocraft_engine::Session;
use serde_json::{Value, json};

pub(crate) const IDS: [&str; 5] = [
    "edit.copy",
    "edit.copyMerged",
    "edit.cut",
    "edit.paste",
    "edit.pasteSpecial.pasteInPlace",
];
fn error(id: &str, message: impl ToString) -> EditorError {
    EditorError::CommandFailed {
        id: id.into(),
        message: message.to_string(),
    }
}
fn paste(id: &str) -> bool {
    id.starts_with("edit.paste")
}

fn check(session: &Session, id: &str, params: &Value) -> Result<()> {
    if !params.is_null()
        && !params.as_object().is_some_and(|p| {
            p.is_empty()
                || (id == "edit.cut" && p.len() == 1 && p.contains_key("color"))
                || (id == "edit.paste" && p.len() == 1 && p.contains_key("center"))
        })
    {
        return Err(error(id, "剪贴板操作不接受外部载荷或指定目标"));
    }
    if let Some(center) = params.get("center") {
        if !center.as_array().is_some_and(|p| {
            p.len() == 2
                && p.iter().all(|v| {
                    v.as_f64()
                        .is_some_and(|v| v.is_finite() && v.abs() <= 1_000_000.)
                })
        }) {
            return Err(error(id, "粘贴中心必须是有效文档坐标"));
        }
    }
    if id == "edit.cut" {
        crate::fill_commands::color(id, params)?;
    }
    let state = session.active().ok_or(EditorError::NoDocument)?;
    if paste(id) {
        let clip = session
            .clipboard
            .as_ref()
            .ok_or_else(|| error(id, "图片内部剪贴板为空，请先复制图片内容"))?;
        if clip.bounds.is_empty() {
            return Err(error(id, "复制内容为空"));
        }
        if crate::layer_preview::mask_target(state) {
            let layer = state
                .active_layer
                .and_then(|id| state.doc.layer(id))
                .ok_or_else(|| error(id, "没有活动图层"))?;
            if layer.mask.is_none() || state.doc.effective_locks(layer.id).all {
                return Err(error(id, "蒙版不存在或图层已锁定"));
            }
        } else {
            let count = clip.layers.as_ref().map_or(1, |doc| crate::layer_preview::layer_count(&doc.layers));
            if count == 0 || crate::layer_preview::layer_count(&state.doc.layers).saturating_add(count) > 64 {
                return Err(error(id, "粘贴后超过图层上限（64 层）"));
            }
            fn supported(layers: &[photocraft_doc::Layer]) -> bool {
                layers.iter().all(|layer| match &layer.content {
                    LayerContent::Raster(_) | LayerContent::Text(_) | LayerContent::Adjustment(_) => true,
                    LayerContent::Group(group) => group.artboard.is_none() && supported(&group.children),
                    _ => false,
                })
            }
            if clip.layers.as_ref().is_some_and(|doc| !supported(&doc.layers)) {
                return Err(error(id, "剪贴板包含尚未开放的图层类型"));
            }
            if let Some(copies)=&clip.layers {
                if !photocraft_project_verify::style_support::supported_document(copies) {return Err(error(id,"剪贴板图案资源无效"));}
                let mut patterns=state.doc.patterns.clone();
                for pattern in &copies.patterns {
                    if let Some(existing)=patterns.iter().find(|p|p.id==pattern.id) {
                        if existing!=pattern {return Err(error(id,"同名图案身份冲突，无法粘贴"));}
                    } else {patterns.push(pattern.clone());}
                }
                if !photocraft_project_verify::pattern_support::supported(&patterns) {return Err(error(id,"粘贴后图案资源超过工程上限"));}
            }
            let path = state.active_layer.and_then(|id| state.doc.path_of(id));
            let destination = path.as_ref().map_or(1, Vec::len);
            let height = clip.layers.as_ref().map_or(1, |doc| crate::layer_preview::layer_depth(&doc.layers));
            if destination + height - 1 > photocraft_project_verify::MAX_DOCUMENT_DEPTH {
                return Err(error(id, "粘贴后超过工程层级上限（16 层）"));
            }
            if path.as_ref().filter(|path| path.len()>1).and_then(|path|state.doc.layer_at(&path[..path.len()-1]))
                .is_some_and(|parent|state.doc.effective_locks(parent.id).all) {
                return Err(error(id, "父组已全部锁定，请先解锁再粘贴"));
            }
        }
    } else if id != "edit.copyMerged" {
        let layer = state
            .active_layer
            .and_then(|id| state.doc.layer(id))
            .ok_or_else(|| error(id, "没有活动图层"))?;
        let mask = crate::layer_preview::mask_target(state);
        if mask && layer.mask.is_none() {
            return Err(error(id, "目标图层没有蒙版"));
        }
        if id == "edit.cut" {
            if !mask && crate::layer_preview::selected_roots(state).len() > 1 {
                return Err(error(id, "请只选择一个图层再剪切像素"));
            }
            let locks = state.doc.effective_locks(layer.id);
            if locks.all || (!mask && locks.pixels) {
                return Err(error(id, "目标图层已锁定"));
            }
            if !mask && !matches!(layer.content, LayerContent::Raster(_)) {
                return Err(error(id, "剪切需要像素层或蒙版"));
            }
        }
    }
    if id != "edit.cut" || !crate::layer_preview::mask_target(state) {
        if let Some(reason) = session.disabled_reason(id) {
            return Err(error(id, reason));
        }
    }
    Ok(())
}

pub(crate) fn disabled_reason(session: &Session, id: &str) -> Option<String> {
    if !IDS.contains(&id) {
        return None;
    }
    let params = if id == "edit.cut" {
        json!({"color":"#ffffff"})
    } else {
        Value::Null
    };
    check(session, id, &params)
        .err()
        .map(|error| error.to_string())
}

pub(crate) fn execute(session: &mut Session, id: &str, params: &Value) -> Result<Value> {
    check(session, id, params)?;
    let base = session.active().ok_or(EditorError::NoDocument)?.clone();
    let mask = crate::layer_preview::mask_target(&base);
    let mut scratch = Session::new();
    scratch.add_document((*base.doc).clone(), None);
    *scratch.active_mut().unwrap() = base;
    scratch.tools = session.tools.clone();
    scratch.clipboard = session.clipboard.clone();
    let mut routed = if params.is_object() && id == "edit.paste" {
        params.clone()
    } else {
        json!({})
    };
    if mask {
        routed["target"] = json!("mask");
    }
    let result = if id == "edit.cut" {
        let color = crate::fill_commands::color(id, params)?;
        if mask {
            // 上游 Cut 不路由蒙版；Copy + 定向背景填充仍只产生一次文档历史。
            let copied = scratch
                .execute("edit.copy", routed.clone())
                .map_err(|e| error(id, e))?;
            scratch.tools.background = color;
            scratch.tools.other_colors = [color; 2];
            scratch
                .execute("edit.fillBackground", routed)
                .map_err(|e| error(id, e))?;
            copied
        } else {
            scratch.tools.background = color;
            scratch.execute(id, json!({})).map_err(|e| error(id, e))?
        }
    } else {
        scratch.execute(id, routed).map_err(|e| error(id, e))?
    };
    if paste(id) && !mask {
        let original = &session.active().unwrap().doc;
        let next = &scratch.active().unwrap().doc;
        let inserted = next.walk().into_iter()
            .filter(|(path, _, layer)| original.layer(layer.id).is_none() &&
                (path.len()==1 || next.layer_at(&path[..path.len()-1]).is_some_and(|parent|original.layer(parent.id).is_some())))
            .map(|(_, _, layer)| layer.id)
            .collect::<Vec<_>>();
        if !inserted.is_empty() {
            let state = scratch.active_mut().unwrap();
            state.selected_layers = inserted;
            state.layer_anchor = state.active_layer;
            state
                .history
                .set_current_layers(photocraft_ops::LayerTarget {
                    active: state.active_layer,
                    selected: state.selected_layers.clone(),
                });
        }
    }
    if !photocraft_project_verify::style_support::supported_document(&scratch.active().unwrap().doc) {
        return Err(error(id,"剪贴板结果无法通过样式及图案核验"));
    }
    *session.active_mut().unwrap() = scratch.active().unwrap().clone();
    session.clipboard = scratch.clipboard;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn session() -> Session {
        let mut s = Session::new();
        s.execute("file.new", json!({"width":16,"height":16}))
            .unwrap();
        s.execute("layer.new.layer", json!({"name":"空层"}))
            .unwrap();
        s
    }
    fn empty_clip(s: &mut Session, count: usize) {
        // 只构造空图层结构，不合成或复制有效像素。
        let st = s.active().unwrap();
        let mut layers = (*st.doc).clone();
        let layer = layers.layers.last().unwrap().clone();
        layers.layers = (0..count).map(|_| layer.duplicate()).collect();
        let surface = layer.surface().unwrap().clone();
        s.clipboard = Some(photocraft_engine::edit_cmds::Clip {
            surface,
            bounds: photocraft_geom::Rect::new(0, 0, 16, 16),
            layers: Some(Box::new(layers)),
            resolution: Some(72.),
        });
    }

    #[test]
    fn pattern_paste_is_self_contained_bounded_and_conflicts_are_atomic() {
        use photocraft_doc::{Pattern,Surface,Effect,FxCommon,BlendMode};
        let mut s=session();empty_clip(&mut s,1);
        let pattern=Pattern{id:"pattern".into(),name:"图案".into(),width:16,height:16,surface:Surface::new(s.active().unwrap().doc.pixel_format())};
        let copies=s.clipboard.as_mut().unwrap().layers.as_mut().unwrap();
        copies.patterns=vec![pattern.clone()];
        copies.layers[0].effects.items=vec![Effect::PatternOverlay{common:FxCommon::new(BlendMode::Normal,1.0),id:pattern.id.clone(),name:pattern.name.clone(),scale:1.0,angle:0.0,link:true,phase:(0.0,0.0)}];
        let before=s.active().unwrap().clone();
        execute(&mut s,"edit.pasteSpecial.pasteInPlace",&Value::Null).unwrap();
        assert_eq!(s.active().unwrap().doc.patterns,vec![pattern.clone()]);
        let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
        s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);
        let doc=Arc::make_mut(&mut s.active_mut().unwrap().doc);let mut conflict=pattern.clone();conflict.width=17;doc.patterns=vec![conflict];
        let before=s.active().unwrap().clone();assert!(execute(&mut s,"edit.paste",&Value::Null).unwrap_err().to_string().contains("冲突"));assert!(Arc::ptr_eq(&s.active().unwrap().doc,&before.doc));
        Arc::make_mut(&mut s.active_mut().unwrap().doc).patterns=(0..64).map(|i|Pattern{id:format!("existing-{i}"),..pattern.clone()}).collect();
        let before=s.active().unwrap().clone();assert!(execute(&mut s,"edit.paste",&Value::Null).unwrap_err().to_string().contains("上限"));assert!(Arc::ptr_eq(&s.active().unwrap().doc,&before.doc));
        assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len());
    }

    #[test]
    fn paste_capacity_includes_existing_group_descendants_without_rendering() {
        let mut s = session();
        empty_clip(&mut s, 1);
        let state = s.active_mut().unwrap();
        let doc = Arc::make_mut(&mut state.doc);
        let template = doc.layers.last().unwrap().clone();
        let children = (0..62).map(|_| template.duplicate()).collect();
        doc.layers = vec![photocraft_doc::Layer::group("组", children), template];
        let before = state.clone();
        let error = execute(&mut s, "edit.paste", &Value::Null).unwrap_err();
        assert!(error.to_string().contains("64"));
        assert!(Arc::ptr_eq(&before.doc, &s.active().unwrap().doc));
        assert_eq!(before.history.past_len(), s.active().unwrap().history.past_len());
    }

    #[test]
    fn group_paste_within_group_preserves_tree_selection_history_and_project() {
        let mut source = session(); empty_clip(&mut source,2);
        let mut clip = source.clipboard.take().unwrap();
        let layers = &mut clip.layers.as_mut().unwrap().layers;
        let child = layers.remove(0);
        layers.insert(0, photocraft_doc::Layer::group("复制组",vec![child]));
        let mut doc = (*source.active().unwrap().doc).clone();
        let target = doc.layers.pop().unwrap(); let target_id = target.id;
        let parent = photocraft_doc::Layer::group("目标组",vec![target]); let parent_id = parent.id;
        doc.layers=vec![parent];
        let mut s = Session::new(); s.add_document(doc,None);s.clipboard=Some(clip);
        s.execute("layer.select",json!({"layer":target_id.0})).unwrap();
        let before=s.active().unwrap().clone();
        execute(&mut s,"edit.pasteSpecial.pasteInPlace",&Value::Null).unwrap();
        let pasted=s.active().unwrap().clone();
        let selected=pasted.selected_layers();
        assert_eq!(selected.len(),2);
        assert!(selected.iter().all(|id|before.doc.layer(*id).is_none()));
        assert_eq!(pasted.doc.layer(parent_id).unwrap().children().unwrap().len(),3);
        assert_eq!(pasted.history.past_len(),before.history.past_len()+1);
        let bytes=photocraft_format::save_to_bytes(&pasted.doc,&Default::default()).unwrap();
        let summary=photocraft_project_verify::verify(&bytes).unwrap();
        assert_eq!(summary.layer_count,5);assert_eq!(summary.depth,3);
        let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        let registry=crate::document_content::AssetRegistry::default();
        assert_eq!(crate::document_content::document_content_hash(&loaded,&registry),crate::document_content::document_content_hash(&pasted.doc,&registry));
        s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);
        s.execute("edit.redo",Value::Null).unwrap();assert_eq!(s.active().unwrap().selected_layers(),selected);
        s.execute("edit.undo",Value::Null).unwrap();
        s.execute("layer.setProps",json!({"layer":parent_id.0,"locked":true})).unwrap();
        assert!(check(&s,"edit.paste",&Value::Null).unwrap_err().to_string().contains("父组"));
    }

    #[test]
    fn group_clipboard_cannot_exceed_destination_depth_or_hide_unsupported_objects() {
        let mut s=session();empty_clip(&mut s,1);
        let layer=s.active().unwrap().doc.layers.last().unwrap().clone();let target=layer.id;
        let mut nested=layer;
        for _ in 1..16 {nested=photocraft_doc::Layer::group("组",vec![nested]);}
        std::sync::Arc::make_mut(&mut s.active_mut().unwrap().doc).layers=vec![nested];
        s.active_mut().unwrap().active_layer=Some(target);
        let clip=s.clipboard.as_mut().unwrap().layers.as_mut().unwrap();
        let child=clip.layers.pop().unwrap();clip.layers=vec![photocraft_doc::Layer::group("组",vec![child])];
        let before=s.active().unwrap().clone();
        assert!(execute(&mut s,"edit.paste",&Value::Null).unwrap_err().to_string().contains("16"));
        assert!(std::sync::Arc::ptr_eq(&s.active().unwrap().doc,&before.doc));
        let clip=s.clipboard.as_mut().unwrap().layers.as_mut().unwrap();
        let fill=photocraft_doc::Layer::new("未开放",LayerContent::Fill(photocraft_doc::Fill::Solid(photocraft_doc::Color::WHITE)));
        clip.layers=vec![photocraft_doc::Layer::group("组",vec![fill])];
        assert!(execute(&mut s,"edit.paste",&Value::Null).unwrap_err().to_string().contains("尚未开放"));
    }
    #[test]
    fn paste_empty_layer_collection_is_one_step_and_roundtrips_without_preview() {
        let mut s = session();
        empty_clip(&mut s, 2);
        let before = s.active().unwrap().clone();
        execute(&mut s, "edit.pasteSpecial.pasteInPlace", &Value::Null).unwrap();
        assert_eq!(
            s.active().unwrap().doc.layers.len(),
            before.doc.layers.len() + 2
        );
        assert_eq!(
            s.active().unwrap().history.past_len(),
            before.history.past_len() + 1
        );
        let bytes = photocraft_format::save_to_bytes(&s.active().unwrap().doc, &Default::default())
            .unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();
        assert_eq!(
            photocraft_format::load_from_bytes(&bytes)
                .unwrap()
                .layers
                .len(),
            4
        );
        s.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(s.active().unwrap().doc.layers.len(), 2);
        s.execute("edit.redo", Value::Null).unwrap();
        assert_eq!(s.active().unwrap().doc.layers.len(), 4);
        assert!(s.clipboard.is_some());
        assert_eq!(s.active().unwrap().selected_layers.len(), 2);
    }
    #[test]
    fn rejected_parameters_capacity_locks_and_empty_copy_preserve_document_clipboard_and_redo() {
        let mut s = session();
        empty_clip(&mut s, 63);
        let before = s.active().unwrap().clone();
        for params in [
            json!({}),
            json!({"target":"mask"}),
            json!({"layers":[]}),
            json!({"center":["bad",0]}),
            json!([]),
        ] {
            assert!(execute(&mut s, "edit.paste", &params).is_err());
        }
        assert!(disabled_reason(&s, "edit.paste").is_some());
        assert!(Arc::ptr_eq(&before.doc, &s.active().unwrap().doc));
        empty_clip(&mut s, 1);
        for id in ["edit.copy", "edit.cut"] {
            let p = if id == "edit.cut" {
                json!({"color":"#123456"})
            } else {
                Value::Null
            };
            assert!(execute(&mut s, id, &p).is_err());
            assert_eq!(
                s.clipboard
                    .as_ref()
                    .unwrap()
                    .layers
                    .as_ref()
                    .unwrap()
                    .layers
                    .len(),
                1
            );
            assert!(Arc::ptr_eq(&before.doc, &s.active().unwrap().doc));
            assert_eq!(
                before.history.past_len(),
                s.active().unwrap().history.past_len()
            );
        }
        s.execute("layer.lockLayers", json!({"pixels":true}))
            .unwrap();
        assert!(execute(&mut s, "edit.cut", &json!({"color":"#ffffff"})).is_err());
        s.execute("edit.undo", Value::Null).unwrap();
        let st = s.active().unwrap().clone();
        assert!(execute(&mut s, "edit.paste", &json!({"payload":"node JSON"})).is_err());
        assert_eq!(
            st.history.redo_labels().collect::<Vec<_>>(),
            s.active()
                .unwrap()
                .history
                .redo_labels()
                .collect::<Vec<_>>()
        );
        assert!(Arc::ptr_eq(&st.doc, &s.active().unwrap().doc));
    }
    #[test]
    fn mask_capacity_and_lock_gate_uses_current_target() {
        let mut s = session();
        empty_clip(&mut s, 63);
        s.execute("layer.layerMask.revealAll", Value::Null).unwrap();
        s.execute("channel.target.layerMask", Value::Null).unwrap();
        assert!(disabled_reason(&s, "edit.paste").is_none());
        s.execute("layer.lockLayers", json!({"pixels":true}))
            .unwrap();
        assert!(disabled_reason(&s, "edit.cut").is_none());
        s.execute("layer.lockLayers", json!({"all":true})).unwrap();
        for id in ["edit.cut", "edit.paste"] {
            assert!(disabled_reason(&s, id).is_some());
        }
    }
}
