use super::*;
use photocraft_doc::{Pattern,Surface};
#[test]
fn library_changes_preserve_active_style_snapshot_history_and_document_resources() {
    let mut editor=Editor::new();
    editor.execute("file.new",json!({"width":32,"height":32})).unwrap();
    editor.execute("layer.new.layer",json!({})).unwrap();
    let layer=editor.active_layer_id().unwrap();
    let pattern=Pattern{id:"user-one".into(),name:"原图案".into(),width:16,height:16,surface:Surface::new(editor.active_doc().unwrap().doc.pixel_format())};
    editor.pattern_library.append(vec![pattern],&editor.session.patterns.items).unwrap();
    let original=editor.pattern_library.patterns()[0].clone();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    editor.begin_layer_properties(layer.0).unwrap();
    let mut fx=json!(photocraft_engine::layer_style::effect_from_params("patternOverlay",&Value::Null).unwrap());
    fx["PatternOverlay"]["id"]=json!(original.id);fx["PatternOverlay"]["name"]=json!(original.name);
    editor.preview_layer_properties(json!({"style":{"enabled":true,"items":[fx.clone()]}})).unwrap();
    let state=editor.rename_pattern_preset("user-one","新名字").unwrap();
    let renamed=editor.pattern_library.patterns()[0].clone();
    assert!(state["patternPresets"].as_array().unwrap().iter().any(|p|p["id"]==original.id));
    assert!(state["patternPresets"].as_array().unwrap().iter().any(|p|p["id"]==renamed.id));
    assert_eq!(editor.preview_document().unwrap().patterns,vec![original.clone()]);
    assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    fx["PatternOverlay"]["id"]=json!(renamed.id);fx["PatternOverlay"]["name"]=json!(renamed.name);
    editor.preview_layer_properties(json!({"style":{"enabled":true,"items":[fx]}})).unwrap();
    editor.delete_pattern_preset("user-one").unwrap();
    assert_eq!(editor.preview_document().unwrap().patterns,vec![renamed.clone()]);
    assert!(editor.import_pattern_presets(b"bad").is_err());
    assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    editor.commit_layer_properties().unwrap();
    assert_eq!(editor.active_doc().unwrap().doc.patterns,vec![renamed]);
    let saved=photocraft_format::save_to_bytes(&editor.active_doc().unwrap().doc,&Default::default()).unwrap();
    let mut reopened=Editor::new();reopened.open_project(&saved,None).unwrap();
    assert_eq!(reopened.content_hash().unwrap(),editor.content_hash().unwrap());
    assert_eq!(reopened.pattern_library()["presets"],json!([]));
    editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
    editor.redo().unwrap();assert_ne!(editor.content_hash().unwrap(),hash);
    editor.pattern_library.append(vec![original],&[]).unwrap();
    let snapshot=editor.pattern_library_snapshot().unwrap();
    editor.begin_layer_properties(layer.0).unwrap();
    editor.restore_pattern_library(&snapshot).unwrap();editor.cancel_layer_properties();
    assert_eq!(editor.pattern_library()["presets"].as_array().unwrap().len(),1);
}

/// U57 成功证据：修改图案库项**不改变**已应用的填充层快照。
///
/// 填充层提交时把图案资源副本写入文档；改名只影响用户库与后续新建，已提交的填充层
/// 仍指向原资源 id，所以工程重开后的渲染不变。
#[test]
fn fill_layer_snapshot_survives_library_rename_and_delete() {
    use photocraft_doc::{Fill,LayerContent,Pattern,Surface};
    let mut editor=Editor::new();
    editor.execute("file.new",json!({"width":32,"height":24})).unwrap();
    let pattern=Pattern{id:"user-fill-one".into(),name:"填充图案".into(),width:16,height:16,
        surface:Surface::new(editor.active_doc().unwrap().doc.pixel_format())};
    editor.pattern_library.append(vec![pattern],&editor.session.patterns.items).unwrap();
    let library=editor.pattern_library.patterns()[0].clone();
    let created=editor.new_fill_layer_inner("layer.newFillLayer.pattern",json!({"pattern":library.id,"scale":150})).unwrap();
    let layer=photocraft_doc::LayerId(created["layer"].as_u64().unwrap());
    // 已应用快照：文档内保存的图案资源。
    let snapshot=editor.active_doc().unwrap().doc.patterns.clone();
    assert!(snapshot.iter().any(|item|item.id==library.id),"图案资源已进入文档");
    let hash=editor.content_hash().unwrap();
    // 改名让库产生新资源 id，但不动文档。
    // 库操作按**库键**（导入时的身份）寻址，不是资源 id。
    editor.rename_pattern_preset("user-fill-one","改过的名字").unwrap();
    let renamed=editor.pattern_library.patterns()[0].clone();
    assert_ne!(renamed.id,library.id,"改名产生新资源 id");
    assert_eq!(editor.active_doc().unwrap().doc.patterns,snapshot,"改名不改已应用快照");
    assert_eq!(editor.content_hash().unwrap(),hash);
    // 删除库项同理：文档已持有副本，重开仍可渲染。
    editor.delete_pattern_preset("user-fill-one").unwrap();
    assert_eq!(editor.active_doc().unwrap().doc.patterns,snapshot,"删除库项不改已应用快照");
    assert_eq!(editor.content_hash().unwrap(),hash);
    let LayerContent::Fill(Fill::Pattern{id,..})=&editor.active_doc().unwrap().doc.layer(layer).unwrap().content else {
        panic!("仍是图案填充层");
    };
    assert_eq!(id,&library.id);
    let bytes=editor.save_project().unwrap();
    let mut reopened=Editor::new();
    reopened.open_project(&bytes,None).unwrap();
    assert_eq!(reopened.active_doc().unwrap().doc.patterns,snapshot);
    assert_eq!(photocraft_project_verify::verify(&bytes).unwrap().layer_count,2);
}
