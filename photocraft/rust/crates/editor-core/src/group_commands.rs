//! 分组结构操作在隔离会话完成校验后发布，一次操作只记一步历史。
use photocraft_doc::{Document, Layer, LayerId};
use photocraft_engine::{DocState, Session};
use serde_json::{Value, json};
use crate::error::{EditorError, Result};

pub(crate) const IDS: &[&str] = &["layer.new.group", "layer.groupLayers", "layer.ungroupLayers", "layer.setExpanded"];
fn error(id: &str, message: impl Into<String>) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.into() }
}

fn targets(state: &DocState, params: &Value) -> Vec<LayerId> {
    params.get("layer").and_then(Value::as_u64).map(LayerId).map_or_else(
        || crate::layer_preview::selected_roots(state), |id| vec![id])
}

fn height(layer: &Layer) -> usize {
    1 + layer.children().and_then(|children| children.iter().map(height).max()).unwrap_or(0)
}

fn locked_parent(doc: &Document, id: LayerId) -> bool {
    doc.path_of(id).is_some_and(|path| path.len() > 1 && doc.layer_at(&path[..path.len()-1]).is_some_and(|parent| doc.effective_locks(parent.id).all))
}

pub(crate) fn check(session: &Session, id: &str, params: &Value) -> Result<()> {
    if id == "layer.setProps" {
        if let Some(blend) = params.get("blend") {
            let mode = blend.as_str().and_then(photocraft_engine::commands::blend_from_str)
                .ok_or_else(|| error(id, "混合模式无效"))?;
            let state = session.active().ok_or(EditorError::NoDocument)?;
            let target = params["layer"].as_u64().map(LayerId).or(state.active_layer);
            let group = target.and_then(|target| state.doc.layer(target)).is_some_and(Layer::is_group);
            if !photocraft_doc::BlendMode::LAYER_MODES.contains(&mode)
                && !(group && mode == photocraft_doc::BlendMode::PassThrough) {
                return Err(error(id, "该图层尚未开放此混合模式"))
            }
        }
        return Ok(())
    }
    if !IDS.contains(&id) { return Ok(()) }
    if !params.is_null() {
        let fields = params.as_object().ok_or_else(|| error(id, "分组参数必须为对象"))?;
        let allowed: &[&str] = match id {
            "layer.new.group" => &["name"],
            "layer.groupLayers" => &["layer", "name"],
            "layer.ungroupLayers" => &["layer"],
            _ => &["layer", "expanded", "all"],
        };
        if fields.keys().any(|key| !allowed.contains(&key.as_str())) { return Err(error(id, "分组命令包含不支持的参数")) }
    }
    if params.get("layer").is_some_and(|value| value.as_u64().is_none()) { return Err(error(id, "图层 id 必须为非负整数")) }
    if params.get("name").is_some_and(|value| value.as_str().is_none_or(|name| name.encode_utf16().count() > 200)) { return Err(error(id, "组名称不能超过 200 个字符")) }
    for key in ["expanded", "all"] {
        if params.get(key).is_some_and(|value| !value.is_boolean()) { return Err(error(id, "展开参数必须为布尔值")) }
    }
    let state = session.active().ok_or(EditorError::NoDocument)?;
    if id == "layer.setExpanded" { return Ok(()) }
    let count = crate::layer_preview::layer_count(&state.doc.layers);
    if id != "layer.ungroupLayers" && count >= photocraft_project_verify::MAX_LAYERS { return Err(error(id, "图层已达工程上限（64 层）")) }
    if id == "layer.new.group" {
        if state.active_layer.is_some_and(|id| locked_parent(&state.doc, id)) { return Err(error(id, "父组已全部锁定，请先解锁")) }
        return Ok(())
    }
    let ids = targets(state, params);
    if ids.is_empty() { return Err(error(id, "请先选择图层")) }
    if id == "layer.ungroupLayers" && count == ids.len() { return Err(error(id, "文档至少需要保留一个图层，不能取消最后一个空组")) }
    for target in &ids {
        let layer = state.doc.layer(*target).ok_or_else(|| error(id, "图层不存在"))?;
        if state.doc.effective_locks(*target).all { return Err(error(id, "所选图层或父组已全部锁定，请先解锁")) }
        if id == "layer.ungroupLayers" && !layer.is_group() { return Err(error(id, "请只选择要取消编组的组")) }
    }
    if id == "layer.groupLayers" {
        let depth = ids.iter().filter_map(|id| state.doc.path_of(*id)).max().map_or(1, |path| path.len());
        if ids.iter().filter_map(|id| state.doc.layer(*id)).any(|layer| depth + height(layer) > photocraft_project_verify::MAX_DOCUMENT_DEPTH) {
            return Err(error(id, "编组超过工程层级上限（16 层）"))
        }
    }
    Ok(())
}

pub(crate) fn disabled_reason(session: &Session, id: &str) -> Option<String> {
    if !IDS.contains(&id) { return None }
    check(session, id, &Value::Null).err().map(|err| match err { EditorError::CommandFailed { message, .. } => message, other => other.to_string() })
}

pub(crate) fn execute(session: &mut Session, id: &str, params: Value) -> Result<Value> {
    check(session, id, &params)?;
    if id == "layer.setExpanded" {
        return session.execute(id, params).map_err(|err| error(id, err.to_string()))
    }
    let base = session.active().ok_or(EditorError::NoDocument)?.clone();
    let mut scratch = Session::new();
    scratch.add_document((*base.doc).clone(), None);
    *scratch.active_mut().unwrap() = base.clone();
    let mut selected = Vec::new();
    let result = if id == "layer.ungroupLayers" {
        for target in targets(&base, &params) {
            selected.extend(base.doc.layer(target).and_then(Layer::children).into_iter().flatten().map(|layer| layer.id));
            scratch.execute(id, json!({"layer":target.0})).map_err(|err| error(id, err.to_string()))?;
        }
        Value::Null
    } else {
        scratch.execute(id, params).map_err(|err| error(id, err.to_string()))?
    };
    let next = scratch.active().unwrap();
    if crate::layer_preview::layer_count(&next.doc.layers) > photocraft_project_verify::MAX_LAYERS
        || next.doc.layers.iter().map(height).max().unwrap_or(0) > photocraft_project_verify::MAX_DOCUMENT_DEPTH {
        return Err(error(id, "分组结果超过工程层数或层级上限"))
    }
    let active = if id == "layer.ungroupLayers" { selected.last().copied().or(next.active_layer) } else { next.active_layer };
    if id != "layer.ungroupLayers" { selected = next.selected_layers(); }
    if selected.is_empty() { selected.extend(active); }
    crate::preview_history::commit_selected(session, next.doc.clone(), active, selected,
        match id { "layer.new.group" => "新建组", "layer.groupLayers" => "编组图层", _ => "取消编组" })
        .map_err(|err| error(id, err.to_string()))?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{document_content::{AssetRegistry, document_content_hash}, Editor};

    fn session() -> Session {
        let mut s = Session::new();
        s.execute("file.new", json!({"width":16,"height":16})).unwrap();
        s.execute("layer.new.layer", json!({"name":"甲"})).unwrap();
        s.execute("layer.new.layer", json!({"name":"乙"})).unwrap();
        s
    }
    fn select_pair(s: &mut Session) -> Vec<LayerId> {
        let ids = s.active().unwrap().doc.layers.iter().skip(1).map(|layer|layer.id).collect::<Vec<_>>();
        s.execute("layer.select", json!({"layer":ids[0].0})).unwrap();
        s.execute("layer.select", json!({"layer":ids[1].0,"mode":"add"})).unwrap();
        ids
    }

    #[test]
    fn grouping_expansion_ungroup_and_serialization_keep_one_history_boundary() {
        let mut s = session(); let ids = select_pair(&mut s);
        let before = s.active().unwrap().clone();
        let gid = LayerId(execute(&mut s, "layer.groupLayers", json!({"name":"组"})).unwrap()["layer"].as_u64().unwrap());
        let grouped = s.active().unwrap().clone();
        assert_eq!(grouped.doc.layer(gid).unwrap().children().unwrap().iter().map(|layer|layer.id).collect::<Vec<_>>(), ids);
        assert_eq!(grouped.selected_layers(), vec![gid]);
        assert_eq!(grouped.history.past_len(), before.history.past_len()+1);
        let registry = AssetRegistry::default(); let hash = document_content_hash(&grouped.doc,&registry).unwrap();
        execute(&mut s, "layer.setExpanded", json!({"layer":gid.0,"expanded":false})).unwrap();
        assert_eq!(s.active().unwrap().revision,grouped.revision);
        assert_eq!(s.active().unwrap().history.past_len(),grouped.history.past_len());
        assert_eq!(document_content_hash(&s.active().unwrap().doc,&registry).unwrap(),hash);
        let bytes = photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();
        let loaded = photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(document_content_hash(&loaded,&registry).unwrap(),hash);
        execute(&mut s,"layer.ungroupLayers",Value::Null).unwrap();
        assert_eq!(s.active().unwrap().selected_layers(),ids);
        assert_eq!(s.active().unwrap().history.past_len(),grouped.history.past_len()+1);
        assert_eq!(s.active().unwrap().doc.layers.iter().map(|l|l.name.as_str()).collect::<Vec<_>>(),vec!["Background","甲","乙"]);
        s.execute("edit.undo",Value::Null).unwrap();
        assert!(s.active().unwrap().doc.layer(gid).is_some());
        assert_eq!(s.active().unwrap().selected_layers(),vec![gid]);
        s.execute("edit.redo",Value::Null).unwrap();
        assert_eq!(s.active().unwrap().selected_layers(),ids);
        s.execute("edit.undo",Value::Null).unwrap();s.execute("edit.undo",Value::Null).unwrap();
        assert_eq!(s.active().unwrap().doc.layers,before.doc.layers);
        assert_eq!(s.active().unwrap().selected_layers(),ids);
    }

    #[test]
    fn multiple_groups_ungroup_atomically_and_reselect_all_children() {
        let mut s = session();
        let ids = select_pair(&mut s);
        let a = execute(&mut s,"layer.groupLayers",json!({"layer":ids[0].0})).unwrap()["layer"].as_u64().unwrap();
        let b = execute(&mut s,"layer.groupLayers",json!({"layer":ids[1].0})).unwrap()["layer"].as_u64().unwrap();
        s.execute("layer.select",json!({"layer":a})).unwrap();
        s.execute("layer.select",json!({"layer":b,"mode":"add"})).unwrap();
        let before = s.active().unwrap().clone();
        execute(&mut s,"layer.ungroupLayers",Value::Null).unwrap();
        assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);
        assert_eq!(s.active().unwrap().selected_layers(),ids);
        s.execute("edit.undo",Value::Null).unwrap();
        assert_eq!(s.active().unwrap().selected_layers(),vec![LayerId(a),LayerId(b)]);
    }

    #[test]
    fn invalid_parameters_locks_and_limits_preserve_document_history_and_redo() {
        let mut s = session(); let ids = select_pair(&mut s);
        for (id,params) in [
            ("layer.new.group",json!([])), ("layer.new.group",json!({"layer":ids[0].0})),
            ("layer.groupLayers",json!({"name":4})), ("layer.groupLayers",json!({"layer":"bad"})),
            ("layer.setExpanded",json!({"expanded":null})), ("layer.setExpanded",json!({"all":"yes"})),
            ("layer.ungroupLayers",Value::Null),
        ] {
            let before = s.active().unwrap().clone();
            assert!(execute(&mut s,id,params).is_err(),"{id}");
            assert_eq!(s.active().unwrap().doc,before.doc);
            assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len());
        }
        s.execute("layer.setProps",json!({"layer":ids[0].0,"locks":{"all":true}})).unwrap();
        assert!(execute(&mut s,"layer.groupLayers",Value::Null).unwrap_err().to_string().contains("锁定"));
        let doc = std::sync::Arc::make_mut(&mut s.active_mut().unwrap().doc);
        let mut nested = Layer::group("深组",vec![]); let inner = nested.id;
        for _ in 1..16 { nested=Layer::group("深组",vec![nested]); }
        doc.layers = vec![nested];
        s.active_mut().unwrap().active_layer=Some(inner);
        let before = s.active().unwrap().clone();
        assert!(execute(&mut s,"layer.groupLayers",Value::Null).unwrap_err().to_string().contains("16"));
        assert_eq!(s.active().unwrap().doc,before.doc);
        // 新空组作为同级插入，恰好第 16 层仍可保存。
        execute(&mut s,"layer.new.group",Value::Null).unwrap();
        let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();
        assert_eq!(photocraft_project_verify::verify(&bytes).unwrap().depth,16);
    }

    #[test]
    fn only_group_passthrough_is_writable_and_locked_destination_rejects_reorder() {
        let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
        let pixel=editor.state()["document"]["activeLayer"].clone();
        for blend in ["Pass Through","Reflect","unknown"] {
            assert!(editor.execute("layer.setProps",json!({"layer":pixel,"blend":blend})).is_err());
        }
        let group=editor.execute("layer.new.group",Value::Null).unwrap()["layer"].clone();
        editor.execute("layer.setProps",json!({"layer":group,"blend":"Normal"})).unwrap();
        editor.execute("layer.setProps",json!({"layer":group,"blend":"Pass Through"})).unwrap();
        editor.execute("layer.setProps",json!({"layer":group,"locks":{"all":true}})).unwrap();
        let before=editor.state();
        assert!(editor.execute("layer.moveTo",json!({"layer":pixel,"target":group,"position":"into"})).unwrap_err().to_string().contains("父组"));
        assert_eq!(editor.state(),before);
        editor.execute("layer.setExpanded",json!({"layer":group,"expanded":false})).unwrap();
        assert_eq!(editor.state()["document"]["revision"],before["document"]["revision"]);
    }

    #[test]
    fn photoshop_blends_keep_distinct_content_and_roundtrip_without_rendering() {
        let mut editor=Session::new();
        editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
        let mut hashes=std::collections::BTreeSet::new();
        for mode in photocraft_doc::BlendMode::LAYER_MODES {
            let before=editor.active().unwrap().doc.clone();
            check(&editor,"layer.setProps",&json!({"blend":mode.label()})).unwrap();
            editor.execute("layer.setProps",json!({"blend":mode.label()})).unwrap();
            let state=editor.active().unwrap();
            let hash=document_content_hash(&state.doc,&AssetRegistry::default()).unwrap();
            assert!(hashes.insert(hash.clone()), "{mode:?}");
            let bytes=photocraft_format::save_to_bytes(&state.doc,&Default::default()).unwrap();
            photocraft_project_verify::verify(&bytes).unwrap();
            let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
            assert_eq!(loaded.layers[0].blend,mode);
            assert_eq!(document_content_hash(&loaded,&AssetRegistry::default()).unwrap(),hash);
            if mode != photocraft_doc::BlendMode::Normal {
                editor.execute("edit.undo",Value::Null).unwrap();
                assert_eq!(editor.active().unwrap().doc.layers,before.layers);
                editor.execute("edit.redo",Value::Null).unwrap();
            }
        }
        assert_eq!(hashes.len(),27);
    }

    #[test]
    fn clipping_in_groups_stays_with_siblings_and_roundtrips_without_compositing() {
        let mut s=session();let ids=select_pair(&mut s);
        let group=execute(&mut s,"layer.groupLayers",Value::Null).unwrap()["layer"].as_u64().unwrap();
        let params=json!({"layer":ids[1].0});
        crate::clipping_commands::check(&s,"layer.createClippingMask",&params).unwrap();
        s.execute("layer.createClippingMask",params).unwrap();
        let registry=AssetRegistry::default();
        let clipped=document_content_hash(&s.active().unwrap().doc,&registry).unwrap();
        let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();
        let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(document_content_hash(&loaded,&registry).unwrap(),clipped);
        // 组内最低层不能借根级 Background 创建跨组剪贴关系。
        assert!(crate::clipping_commands::check(&s,"layer.createClippingMask",&json!({"layer":ids[0].0})).is_err());
        execute(&mut s,"layer.ungroupLayers",json!({"layer":group})).unwrap();
        assert!(s.active().unwrap().doc.layer(ids[1]).unwrap().clipped);
        s.execute("edit.undo",Value::Null).unwrap();
        assert_eq!(document_content_hash(&s.active().unwrap().doc,&registry).unwrap(),clipped);
    }
}
