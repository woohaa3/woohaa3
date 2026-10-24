//! 只检查状态与能力门，不合成、导出或采集绘制结果。
use photocraft_embed_editor::Editor;
use serde_json::{json, Value};

#[test]
fn layer_navigation_follows_collapsed_rows_and_preserves_content_and_history() {
    let mut editor=Editor::new();
    assert!(editor.execute("layer.selectAbove",Value::Null).is_err());
    editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"A"})).unwrap();
    let a=editor.state()["document"]["activeLayer"].clone();
    editor.execute("layer.new.layer",json!({"name":"B"})).unwrap();
    let b=editor.state()["document"]["activeLayer"].clone();
    let group=editor.execute("layer.groupLayers",Value::Null).unwrap()["layer"].clone();
    editor.execute("layer.setExpanded",json!({"layer":group,"expanded":false})).unwrap();
    editor.execute("layer.select",json!({"layer":b})).unwrap();
    let hash=editor.content_hash().unwrap();let before=editor.state()["document"].clone();
    editor.execute("layer.selectBelow",Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["activeLayer"],a);
    editor.execute("layer.selectAbove",Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["activeLayer"],group);
    editor.execute("layer.addBelowToSelection",Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["activeLayer"],a);
    let selected=editor.state()["document"]["selectedLayers"].as_array().unwrap().clone();
    assert_eq!(selected.len(),2);assert!(selected.contains(&a));assert!(selected.contains(&group));
    editor.execute("layer.addAboveToSelection",Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["selectedLayers"].as_array().unwrap().len(),2);
    editor.execute("layer.selectBottom",Value::Null).unwrap();
    assert_ne!(editor.state()["document"]["activeLayer"],group);
    editor.execute("layer.selectTop",Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["activeLayer"],group);
    for key in ["history","redoHistory"] {assert_eq!(editor.state()["document"][key],before[key]);}
    assert_eq!(editor.content_hash().unwrap(),hash);
    // 不经 Editor::save_project（该入口会生成缩略图）：直接序列化无像素 fixture。
    let mut doc=photocraft_doc::Document::new("干净工程",photocraft_doc::Size::new(16,16),photocraft_doc::ColorMode::Rgb,photocraft_doc::SampleType::U8);
    doc.layers=vec![photocraft_doc::Layer::raster("A",doc.pixel_format()),photocraft_doc::Layer::raster("B",doc.pixel_format())];
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();
    let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();
    let clean_hash=editor.content_hash().unwrap();
    assert_eq!(editor.state()["session"]["documents"][0]["dirty"],false);
    for id in ["layer.selectAbove","layer.selectBelow","layer.selectTop","layer.selectBottom","layer.addAboveToSelection","layer.addBelowToSelection"] {
        let commands=editor.commands();let command=commands.as_array().unwrap().iter().find(|c|c["id"]==id).unwrap();
        assert_eq!(command["allowed"],true);assert_eq!(command["enabled"],true);
        editor.execute(id,Value::Null).unwrap();
        assert_eq!(editor.state()["session"]["documents"][0]["dirty"],false);
        assert_eq!(editor.content_hash().unwrap(),clean_hash);
    }
}

#[test]
fn visibility_isolation_restores_the_original_snapshot_and_bulk_hide_is_one_step() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"A"})).unwrap();let a=editor.state()["document"]["activeLayer"].clone();
    editor.execute("layer.new.layer",json!({"name":"B"})).unwrap();let b=editor.state()["document"]["activeLayer"].clone();
    let initial=editor.state()["document"]["layers"].clone();
    editor.execute("layer.showOnly",json!({"layer":a})).unwrap();
    editor.execute("layer.showOnly",json!({"layer":b})).unwrap();
    editor.execute("layer.showOnly",json!({"layer":b})).unwrap();
    assert_eq!(editor.state()["document"]["layers"],initial);
    editor.execute("layer.select",json!({"layer":a})).unwrap();
    editor.execute("layer.select",json!({"layer":b,"mode":"add"})).unwrap();
    let before=editor.state()["document"].clone();
    editor.execute("layer.hideLayers",Value::Null).unwrap();
    let hidden=editor.state()["document"].clone();
    assert_eq!(hidden["history"].as_array().unwrap().len(),before["history"].as_array().unwrap().len()+1);
    for layer in hidden["layers"].as_array().unwrap() {if layer["id"]==a || layer["id"]==b {assert_eq!(layer["visible"],false);}}
    editor.undo().unwrap();assert_eq!(editor.state()["document"]["layers"],before["layers"]);
    editor.redo().unwrap();assert_eq!(editor.state()["document"]["layers"],hidden["layers"]);
    editor.execute("layer.hideLayers",Value::Null).unwrap();assert_eq!(editor.state()["document"]["layers"],before["layers"]);
}

#[test]
fn last_state_toggle_alternates_history_and_background_conversion_is_undoable() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let original=editor.state()["document"]["layers"].clone();
    assert_eq!(original[0]["background"],true);
    editor.execute("layer.new.layerFromBackground",Value::Null).unwrap();
    let converted=editor.state()["document"]["layers"].clone();
    assert_eq!(converted[0]["background"],false);assert_eq!(converted[0]["name"],"Layer 0");
    editor.execute("edit.toggleLastState",Value::Null).unwrap();assert_eq!(editor.state()["document"]["layers"],original);
    editor.execute("edit.toggleLastState",Value::Null).unwrap();assert_eq!(editor.state()["document"]["layers"],converted);
    editor.execute("layer.setProps",json!({"name":"新名称"})).unwrap();
    editor.execute("edit.toggleLastState",Value::Null).unwrap();assert_eq!(editor.state()["document"]["layers"],converted);
    editor.execute("edit.toggleLastState",Value::Null).unwrap();assert_eq!(editor.state()["document"]["layers"][0]["name"],"新名称");
}

#[test]
fn group_copy_counts_descendants_and_reorder_cannot_exceed_project_depth() {
    use photocraft_doc::{ColorMode, Document, Layer, SampleType, Size};
    let mut doc = Document::new("组工程", Size::new(16, 16), ColorMode::Rgb, SampleType::U8);
    let children = (0..61).map(|_| Layer::raster("空层", doc.pixel_format())).collect();
    doc.layers = vec![Layer::group("组", children), Layer::raster("目标", doc.pixel_format())];
    let bytes = photocraft_format::save_to_bytes(&doc, &Default::default()).unwrap();
    let mut editor = Editor::new(); editor.open_project(&bytes, None).unwrap();
    let state = editor.state();
    let group = state["document"]["layers"][1]["id"].clone();
    let target = state["document"]["layers"][0]["id"].clone();
    editor.execute("layer.select", json!({"layer":group})).unwrap();
    let before = editor.state();
    for (id, params) in [
        ("layer.duplicate", json!({})),
        ("layer.duplicate", json!({"layer":group})),
        ("layer.new.layerViaCopy", json!({})),
        ("layer.moveTo", json!({"layer":group,"target":target,"copy":true})),
        ("layer.moveTo", json!({"layers":[group],"target":target,"copy":true})),
    ] {
        assert!(editor.execute(id, params).unwrap_err().to_string().contains("64"), "{id}");
        assert_eq!(editor.state(), before);
    }
    let mut nested = Layer::group("最深空组", vec![]);
    for _ in 1..16 { nested = Layer::group("组", vec![nested]); }
    doc.layers = vec![nested, Layer::raster("目标", doc.pixel_format())];
    let bytes = photocraft_format::save_to_bytes(&doc, &Default::default()).unwrap();
    editor.open_project(&bytes, None).unwrap();
    let before = editor.state();
    let mut deepest = &before["document"]["layers"][1];
    for _ in 1..16 { deepest = &deepest["children"][0]; }
    let layer = before["document"]["layers"][0]["id"].clone();
    for copy in [false, true] {
        let error = editor.execute("layer.moveTo", json!({"layer":layer,"target":deepest["id"],"position":"into","copy":copy})).unwrap_err();
        assert!(error.to_string().contains("16"));
        assert_eq!(editor.state(), before);
    }
    editor.execute("layer.moveTo", json!({"layer":layer,"target":deepest["id"],"position":"above"})).unwrap();
    editor.undo().unwrap();
    assert_eq!(editor.state()["document"]["layers"], before["document"]["layers"]);
}

#[test]
fn fill_commands_expose_menu_and_refuse_invalid_or_locked_writes_without_rendering() {
    let ids=["edit.fillForeground","edit.fillBackground","edit.fillForegroundPreserve","edit.fillBackgroundPreserve"];
    let mut editor=Editor::new();
    for id in ids {assert!(editor.execute(id,json!({"color":"#ff0000"})).is_err());}
    editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",Value::Null).unwrap();
    let commands=editor.commands();
    for id in ids {
        let command=commands.as_array().unwrap().iter().find(|command|command["id"]==id).unwrap();
        assert_eq!(command["allowed"],true);assert_eq!(command["enabled"],true);assert_eq!(command["menu"],json!(["Edit"]));
    }
    let before=editor.state();
    for id in ids {assert!(editor.execute(id,json!({"color":"#ff0000","contents":"history"})).is_err());}
    assert_eq!(editor.state(),before);
    editor.execute("layer.lockLayers",json!({"pixels":true})).unwrap();
    let locked=editor.state();
    let commands=editor.commands();
    for id in ids {
        let command=commands.as_array().unwrap().iter().find(|command|command["id"]==id).unwrap();
        assert_eq!(command["enabled"],false);assert!(command["disabledReason"].as_str().unwrap().contains("锁定"));
        assert!(editor.execute(id,json!({"color":"#ff0000"})).is_err());
    }
    assert_eq!(editor.state(),locked);
    assert!(editor.execute("edit.fillHistory",Value::Null).is_err());
}

#[test]
fn adjustment_draft_is_isolated_cancelable_and_committed_as_one_step() {
    for (kind,updates) in [
        ("brightnessContrast",vec![json!({"brightness":20}),json!({"contrast":40})]),
        ("hueSaturation",vec![json!({"hue":30}),json!({"saturation":40,"lightness":-10})]),
        ("curves",vec![json!({"points":[[0,0],[128,160],[255,255]]}),json!({"points":[[0,0],[100,170],[255,255]]})]),
    ] {
        let mut editor=Editor::new();
        editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
        editor.execute(&format!("layer.newAdjustmentLayer.{kind}"),json!({})).unwrap();
        let before=editor.state();let hash=editor.content_hash().unwrap();let revision=editor.revision().unwrap();
        let layer=before["document"]["activeLayer"].as_u64().unwrap();
        let original=editor.begin_adjustment(layer).unwrap();
        for update in &updates {editor.preview_adjustment(update.clone()).unwrap();}
        assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
        assert_eq!(editor.revision().unwrap(),revision);
        assert!(editor.execute("edit.undo",Value::Null).is_err());
        assert!(editor.begin_text(json!({"x":1,"y":1})).is_err());
        assert!(editor.begin_transform().is_err());
        assert!(editor.save_project().is_err());assert!(editor.export_bundle().is_err());
        assert!(editor.open_project(b"not a project",None).is_err());
        assert!(editor.begin_adjustment(layer).is_err());
        editor.cancel_adjustment();assert_eq!(editor.state(),before);
        assert_eq!(editor.begin_adjustment(layer).unwrap(),original);
        let mut last=Value::Null;
        for update in &updates {last=editor.preview_adjustment(update.clone()).unwrap();}
        // 后续部分更新必须保留同一会话之前的参数。
        for (key,value) in updates[0].as_object().unwrap() {
            if !updates[1].as_object().unwrap().contains_key(key) {assert_eq!(last["params"][key].as_f64(),value.as_f64());}
        }
        editor.commit_adjustment().unwrap();
        assert_ne!(editor.content_hash().unwrap(),hash);
        let committed=editor.state();
        let committed_hash=editor.content_hash().unwrap();
        editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
        editor.redo().unwrap();assert_eq!(editor.content_hash().unwrap(),committed_hash);
        assert_eq!(editor.state()["document"]["layers"],committed["document"]["layers"]);
        // 未修改的草稿和改回初始参数的草稿都不增加历史。
        let stable=editor.state();editor.begin_adjustment(layer).unwrap();editor.commit_adjustment().unwrap();
        assert_eq!(editor.state(),stable);
        editor.begin_adjustment(layer).unwrap();
        editor.preview_adjustment(updates[0].clone()).unwrap();
        editor.cancel_adjustment();assert_eq!(editor.state(),stable);
    }
}

#[test]
fn invalid_adjustment_parameters_block_stale_commit_and_can_be_corrected() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.newAdjustmentLayer.curves",json!({})).unwrap();
    let layer=editor.state()["document"]["activeLayer"].as_u64().unwrap();
    let before=editor.state();let initial=editor.begin_adjustment(layer).unwrap();
    let good=json!({"points":[[0,0],[128,180],[255,255]]});
    editor.preview_adjustment(good.clone()).unwrap();
    for bad in [json!({}),json!({"layer":layer}),json!({"eyedropper":{"point":"white","at":[1,1]}}),
        json!({"red":[[0,0],[255,255]]}),json!({"points":[[0,0],[0,10]]}),
        json!({"points":[[0,0],[256,255]]}),json!({"points":[[0,"x"],[255,255]]}),json!({"points":[[0,0]]})] {
        assert!(editor.preview_adjustment(bad).is_err());
        assert!(editor.commit_adjustment().is_err());assert_eq!(editor.state(),before);
    }
    editor.preview_adjustment(json!({"points":initial["params"]["points"]})).unwrap();
    editor.commit_adjustment().unwrap();assert_eq!(editor.state(),before);
    editor.begin_adjustment(layer).unwrap();editor.preview_adjustment(good).unwrap();
    editor.close();assert!(editor.commit_adjustment().is_err());
    assert!(editor.begin_adjustment(layer).is_err());
}

#[test]
fn layer_selection_and_capacity_do_not_require_rendering() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"第一层"})).unwrap();
    let first = editor.state()["document"]["activeLayer"].clone();
    editor.execute("layer.new.layer", json!({"name":"第二层"})).unwrap();
    editor.execute("layer.select", json!({"layer":first,"mode":"replace"})).unwrap();
    assert_eq!(editor.state()["document"]["activeLayer"], first);
    let mut layers = editor.state()["document"]["layers"].as_array().unwrap().len();
    while layers < 64 {
        editor.execute("layer.new.layer", json!({})).unwrap();
        layers += 1;
    }
    assert!(editor.execute("layer.new.layer", json!({})).is_err());
    assert!(editor.execute("image.crop", json!({})).is_err());
    assert!(editor.execute("layer.new.group", json!({})).is_err());
    assert_eq!(editor.state()["document"]["layers"].as_array().unwrap().len(), 64);
}

#[test]
fn fixed_font_is_registered_and_checked_without_drawing() {
    assert!(Editor::register_fixed_font(b"wrong font").is_err());
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../assets/fonts/NotoSansSC-Regular.otf")).unwrap();
    Editor::register_fixed_font(&bytes).unwrap();
    Editor::register_fixed_font(&bytes).unwrap();
    let mut engine = photocraft_text::shared().lock().unwrap();
    assert!(!engine.fonts.faces("Noto Sans SC").is_empty());
}

#[test]
fn empty_stroke_lifecycle_rejects_without_mutating_state() {
    let mut editor = Editor::new();
    let before = editor.state();
    assert!(editor.begin_stroke(json!({"points":[[1,2]]})).is_err());
    assert!(editor.append_stroke(json!({"points":[[1,2]]})).is_err());
    assert!(editor.append_stroke(json!({"points":[]})).is_err());
    assert!(editor.commit_stroke().is_err());
    editor.cancel_stroke();
    editor.cancel_stroke();
    assert_eq!(editor.state(), before);
}

#[test]
fn whole_document_turn_updates_dimensions_and_selection_and_undo_restores_them() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":100,"height":60})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"空层"})).unwrap();
    editor.execute("select.rect", json!({"x":10,"y":5,"width":20,"height":15})).unwrap();
    let before = editor.state();
    editor.execute("image.imageRotation.90cw", json!({})).unwrap();
    let turned = editor.state();
    assert_eq!(turned["document"]["width"], 60);
    assert_eq!(turned["document"]["height"], 100);
    assert_ne!(turned["document"]["selectionOutline"], before["document"]["selectionOutline"]);
    editor.undo().unwrap();
    let restored = editor.state();
    assert_eq!(restored["document"]["width"], 100);
    assert_eq!(restored["document"]["height"], 60);
    assert_eq!(restored["document"]["selectionOutline"], before["document"]["selectionOutline"]);
    editor.redo().unwrap();
    assert_eq!(editor.state()["document"]["selectionOutline"], turned["document"]["selectionOutline"]);
}

#[test]
fn transform_draft_preserves_formal_history_until_confirmation() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"空层"})).unwrap();
    editor.execute("layer.setProps", json!({"name":"重命名"})).unwrap();
    editor.undo().unwrap();
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    editor.begin_transform().unwrap();
    // 空层没有可变换内容；只检查失败恢复和会话门禁，不执行像素变换。
    assert!(editor.preview_transform(json!([1,0,0,1,3,4])).is_err());
    assert!(editor.preview_transform(json!([1,0,0,1,5,8])).is_err());
    assert_eq!(editor.state(), before, "预览不能修改正式状态或重做分支");
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert!(editor.save_project().is_err());
    assert!(editor.export_bundle().is_err());
    assert!(editor.execute("layer.new.layer", json!({})).is_err());
    assert!(editor.begin_stroke(json!({"points":[]})).is_err());
    assert!(editor.preview_transform(json!([0,0,0,0,0,0])).is_err());
    editor.cancel_transform();
    assert_eq!(editor.state(), before);
    editor.begin_transform().unwrap();
    editor.preview_transform(json!([1.,0.,0.,1.,0.,0.])).unwrap();
    editor.commit_transform().unwrap();
    assert_eq!(editor.state(), before, "原位确认不能占用历史");
    editor.begin_transform().unwrap();
    editor.close();
    assert!(!editor.has_document());
}

#[test]
fn move_rejects_invalid_empty_and_locked_targets_without_creating_a_draft() {
    let mut editor = Editor::new();
    assert!(editor.begin_move(json!({"x":0,"y":0})).is_err());
    editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"空层"})).unwrap();
    let before = editor.state();
    assert!(editor.begin_move(json!({"x":null,"y":0})).is_err());
    assert!(!editor.begin_move(json!({"x":0,"y":0,"duplicate":true})).unwrap());
    assert!(!editor.begin_move(json!({"x":-10,"y":-10,"autoSelect":true})).unwrap());
    assert_eq!(editor.state(), before);
    editor.execute("layer.setProps",json!({"locks":{"position":true}})).unwrap();
    let locked = editor.state();
    assert!(editor.begin_move(json!({"x":0,"y":0})).is_err());
    assert!(editor.begin_transform().is_err());
    assert_eq!(editor.state(), locked);
    editor.execute("layer.new.layer",json!({"name":"可继续操作"})).unwrap();
}

#[test]
fn selection_boundary_transform_preserves_pixels_identity_and_commits_one_step() {
    let mut editor = Editor::new();
    assert!(editor.begin_selection_transform().is_err());
    editor.execute("file.new",json!({"width":100,"height":80})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"空层"})).unwrap();
    assert!(editor.begin_selection_transform().is_err());
    editor.execute("select.rect",json!({"x":10,"y":10,"width":20,"height":15})).unwrap();
    editor.execute("layer.setProps",json!({"locks":{"position":true}})).unwrap();
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    assert_eq!(before["document"]["selectionFrame"],json!([10,10,30,25]));
    // 仅变换选区掩码，不处理非空图像、合成或导出。
    editor.begin_selection_transform().unwrap();
    editor.preview_transform(json!([1,0,0,1,7,9])).unwrap();
    editor.preview_transform(json!([1,0,0,1,12,6])).unwrap();
    assert_eq!(editor.state(),before);
    assert_eq!(editor.content_hash().unwrap(),hash);
    assert!(editor.save_project().is_err());
    assert!(editor.execute("select.deselect",json!({})).is_err());
    editor.cancel_transform();
    assert_eq!(editor.state(),before);
    editor.begin_selection_transform().unwrap();
    editor.preview_transform(json!([1,0,0,1,12,6])).unwrap();
    editor.commit_transform().unwrap();
    let after = editor.state();
    assert_eq!(after["document"]["selectionFrame"],json!([22,16,42,31]));
    assert_eq!(after["document"]["layers"],before["document"]["layers"]);
    assert_eq!(editor.content_hash().unwrap(),hash);
    assert_eq!(after["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
    editor.undo().unwrap();
    assert_eq!(editor.state()["document"]["selectionFrame"],before["document"]["selectionFrame"]);
    editor.redo().unwrap();
    assert_eq!(editor.state()["document"]["selectionFrame"],after["document"]["selectionFrame"]);
}

#[test]
fn color_sampling_rejects_invalid_coordinates_and_active_gestures_without_rendering() {
    let mut editor = Editor::new();
    assert!(editor.sample_color(0.0,0.0).is_err());
    editor.execute("file.new",json!({"width":40,"height":30})).unwrap();
    let before=editor.state();
    // 所有坐标都在合成前被拒绝，不采集任何图像像素。
    for (x,y) in [(-0.1,0.0),(40.0,0.0),(0.0,30.0),(f64::NAN,0.0),(0.0,f64::INFINITY)] {
        assert_eq!(editor.sample_color(x,y).unwrap(),None);
    }
    assert_eq!(editor.state(),before);
    editor.execute("select.rect",json!({"x":1,"y":1,"width":4,"height":4})).unwrap();
    editor.begin_selection_transform().unwrap();
    assert!(editor.sample_color(0.0,0.0).is_err());
    editor.cancel_transform();
}

#[test]
fn mask_target_view_and_link_state_share_the_engine_without_rendering() {
    let mut editor=Editor::new();
    editor.execute("file.new",json!({"width":80,"height":60})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"空层"})).unwrap();
    let layer=editor.state()["document"]["activeLayer"].as_u64().unwrap();
    assert!(editor.layer_thumbnail(999,false,64).is_err());
    assert!(editor.layer_thumbnail(layer,true,64).is_err());
    assert!(editor.execute("channel.target.layerMask",Value::Null).is_err());
    editor.execute("layer.layerMask.revealAll",Value::Null).unwrap();
    let linked_hash=editor.content_hash().unwrap();
    let before=editor.state();
    assert_eq!(before["document"]["layers"][0]["maskLinked"],true);
    editor.execute("channel.target.layerMask",Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["editTarget"],"mask");
    editor.execute("view.layerMask",json!({"mode":"toggleGray"})).unwrap();
    assert_eq!(editor.state()["document"]["layerMaskView"]["mode"],"gray");
    assert_eq!(editor.state()["document"]["history"],before["document"]["history"]);
    assert_eq!(editor.content_hash().unwrap(),linked_hash);
    editor.execute("layer.layerMask.linked",json!({"linked":false})).unwrap();
    let unlinked_hash=editor.content_hash().unwrap();
    assert_ne!(unlinked_hash,linked_hash,"链接状态必须参与净变化，才能保存仅切换链接的编辑");
    assert_eq!(editor.state()["document"]["transformFrame"],json!([0,0,80,60]),"空层的独立蒙版仍有完整变换框");
    editor.begin_transform().unwrap();
    editor.preview_transform(json!([1,0,0,1,0,0])).unwrap();
    editor.cancel_transform();
    editor.undo().unwrap(); assert_eq!(editor.content_hash().unwrap(),linked_hash);
    editor.redo().unwrap(); assert_eq!(editor.content_hash().unwrap(),unlinked_hash);
    editor.execute("layer.layerMask.enabled",json!({"enabled":false})).unwrap();
    assert_eq!(editor.state()["document"]["layers"][0]["maskEnabled"],false);
    editor.execute("view.layerMask",json!({"mode":"off"})).unwrap();
    editor.execute("channel.target.composite",Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["editTarget"],"pixels");
    assert!(editor.state()["document"]["layerMaskView"].is_null());
    editor.execute("channel.target.layerMask",Value::Null).unwrap();
    editor.execute("view.layerMask",json!({"mode":"gray"})).unwrap();
    editor.execute("layer.layerMask.delete",Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["editTarget"],"pixels");
    assert!(editor.state()["document"]["layerMaskView"].is_null());
    editor.undo().unwrap();
    editor.execute("channel.target.layerMask",Value::Null).unwrap();
    editor.execute("view.layerMask",json!({"mode":"gray"})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"另一层"})).unwrap();
    assert_eq!(editor.state()["document"]["editTarget"],"pixels");
    assert!(editor.state()["document"]["layerMaskView"].is_null());
    let before=editor.state();
    assert!(editor.execute("channel.target.layerMask",Value::Null).is_err());
    assert_eq!(editor.state(),before);
}

#[test]
fn mask_creation_selection_undo_without_rendering() {
    // 只检查选区掩码、空层结构和无预览的工程字节，不执行图像合成。
    for operation in ["revealAll", "hideAll", "revealSelection", "hideSelection"] {
        let mut editor=Editor::new();
        editor.execute("file.new",json!({"width":20,"height":16})).unwrap();
        editor.execute("layer.new.layer",json!({"name":"空层"})).unwrap();
        let layer=editor.state()["document"]["activeLayer"].as_u64().unwrap();
        editor.execute("select.rect",json!({"x":3,"y":4,"width":5,"height":6})).unwrap();
        let before=editor.state();
        let before_hash=editor.content_hash().unwrap();
        editor.execute(&format!("layer.layerMask.{operation}"),json!({"layer":layer})).unwrap();
        let after=editor.state();
        assert_eq!(after["document"]["editTarget"],"mask");
        assert_eq!(after["document"]["history"].as_array().unwrap().len(), before["document"]["history"].as_array().unwrap().len()+1);
        if operation.ends_with("Selection") { assert_eq!(after["document"]["hasSelection"],false); }
        let hash=editor.content_hash().unwrap();
        assert_ne!(hash,before_hash);
        for blocked in ["revealAll","hideAll","revealSelection","hideSelection","fromTransparency"] {
            for params in [Value::Null,json!({"layer":layer}),json!({"layer":null}),json!({"layer":"空层"})] {
                assert!(editor.execute(&format!("layer.layerMask.{blocked}"),params).is_err());
                assert_eq!(editor.state(),after);
            }
        }
        assert!(editor.commands().as_array().unwrap().iter().filter(|c|c["id"]=="layer.layerMask.revealAll").all(|c|c["enabled"]==false));
        editor.undo().unwrap();
        assert_eq!(editor.content_hash().unwrap(),before_hash);
        assert_eq!(editor.state()["document"]["selectionFrame"],before["document"]["selectionFrame"]);
        editor.redo().unwrap();
        assert_eq!(editor.content_hash().unwrap(),hash);
        editor.execute("layer.layerMask.delete",json!({"layer":layer})).unwrap();
        assert_eq!(editor.state()["document"]["editTarget"],"pixels");
        editor.undo().unwrap(); assert_eq!(editor.content_hash().unwrap(),hash);
        editor.execute("layer.layerMask.apply",json!({"layer":layer})).unwrap();
        assert_eq!(editor.state()["document"]["layers"][0]["hasMask"],false);
        editor.undo().unwrap(); assert_eq!(editor.content_hash().unwrap(),hash);
    }
}

#[test]
fn text_draft_gates_writes_save_and_other_gestures_without_rendering() {
    let mut editor=Editor::new();
    assert!(editor.text_geometry(json!({"start":0,"end":0})).is_err());
    assert!(editor.begin_text(json!({"x":10,"y":10,"box":[10,10,30,20]})).is_err());
    editor.execute("file.new",json!({"width":100,"height":80})).unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    // 段落框明确新建，不运行图层拾取、文字排版或绘制。
    let info=editor.begin_text(json!({"x":10,"y":10,"box":[10,10,30,20]})).unwrap();
    // 未产生文字层时拒绝几何查询，不为无输入草稿运行排版。
    assert!(editor.text_geometry(json!({"start":0,"end":0})).is_err());
    assert_eq!(info["new"],true);assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    assert!(editor.execute("layer.new.layer",Value::Null).is_err());
    assert!(editor.save_project().is_err());assert!(editor.export_bundle().is_err());
    assert!(editor.begin_transform().is_err());assert!(editor.begin_stroke(json!({"points":[]})).is_err());
    assert!(editor.begin_text(json!({"x":1,"y":1})).is_err());
    assert!(editor.preview_text(json!({"text":"x","orientation":"diagonal"})).is_err());
    assert_eq!(editor.state(),before);
    editor.cancel_text();assert_eq!(editor.state(),before);
    editor.begin_text(json!({"x":10,"y":10,"box":[10,10,30,20]})).unwrap();
    editor.commit_text().unwrap();assert_eq!(editor.state(),before);
    assert!(editor.preview_text(json!({"text":"x"})).is_err());
    editor.begin_text(json!({"x":10,"y":10,"box":[10,10,30,20]})).unwrap();
    editor.close();assert!(!editor.has_document());
}

#[test]
fn layer_properties_preview_keeps_state_and_history_until_one_confirmation() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"空层"})).unwrap();
    let before=editor.state();let layer=before["document"]["activeLayer"].as_u64().unwrap();let hash=editor.content_hash().unwrap();
    assert!(editor.begin_layer_properties(u64::MAX).is_err());
    assert_eq!(editor.begin_layer_properties(layer).unwrap()["opacity"],1.0);
    for opacity in [0.9,0.6,0.4] {editor.preview_layer_properties(json!({"opacity":opacity})).unwrap();}
    assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    assert!(editor.execute("edit.undo",Value::Null).is_err());
    assert!(editor.begin_adjustment(layer).is_err());assert!(editor.begin_text(json!({"x":1,"y":1})).is_err());
    assert!(editor.begin_transform().is_err());assert!(editor.save_project().is_err());assert!(editor.export_bundle().is_err());
    for params in [json!({}),json!({"opacity":null}),json!({"opacity":-1}),json!({"opacity":2}),json!({"opacity":0.5,"fill":2}),json!({"layer":layer,"opacity":0.5})] {
        assert!(editor.preview_layer_properties(params).is_err());assert!(editor.commit_layer_properties().is_err());
        assert_eq!(editor.state(),before);
    }
    editor.cancel_layer_properties();assert_eq!(editor.state(),before);
    editor.begin_layer_properties(layer).unwrap();editor.preview_layer_properties(json!({"opacity":0.4})).unwrap();editor.commit_layer_properties().unwrap();
    assert_ne!(editor.content_hash().unwrap(),hash);
    let committed=editor.content_hash().unwrap();editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
    editor.redo().unwrap();assert_eq!(editor.content_hash().unwrap(),committed);
    let stable=editor.state();editor.begin_layer_properties(layer).unwrap();
    editor.preview_layer_properties(json!({"opacity":0.7})).unwrap();editor.preview_layer_properties(json!({"opacity":0.4})).unwrap();
    editor.commit_layer_properties().unwrap();assert_eq!(editor.state(),stable);
    editor.begin_layer_properties(layer).unwrap();editor.close();assert!(editor.commit_layer_properties().is_err());
}

#[test]
fn invalid_transform_does_not_confirm_initial_snapshot_and_identity_keeps_redo() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"空层"})).unwrap();
    editor.execute("layer.setProps",json!({"name":"重命名"})).unwrap();editor.undo().unwrap();
    let before=editor.state();editor.begin_transform().unwrap();
    // 空图层只检查领域状态，不变换有效图像像素。
    editor.preview_transform(json!([1,0,0,1,0,0])).unwrap();
    assert!(editor.preview_transform(json!([0,0,0,0,0,0])).is_err());
    assert!(editor.commit_transform().is_err());assert_eq!(editor.state(),before);
    editor.preview_transform(json!([1,0,0,1,0,0])).unwrap();editor.commit_transform().unwrap();
    assert_eq!(editor.state(),before);editor.redo().unwrap();
    assert_eq!(editor.state()["document"]["layers"][0]["name"],"重命名");
}

#[test]
fn layer_range_toggle_and_batch_reorder_are_one_structural_edit_without_rendering() {
    let mut editor=Editor::new();
    editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    for name in ["底层","中层","上层","顶层"] {
        editor.execute("layer.new.layer",json!({"name":name})).unwrap();
    }
    let state=editor.state();
    let rows=state["document"]["layers"].as_array().unwrap();
    let ids:Vec<_>=rows.iter().map(|row|row["id"].as_u64().unwrap()).collect();
    let baseline=editor.content_hash().unwrap();
    let history=state["document"]["history"].clone();
    editor.execute("layer.select",json!({"layer":ids[0],"mode":"replace"})).unwrap();
    editor.execute("layer.select",json!({"layer":ids[2],"mode":"range"})).unwrap();
    assert_eq!(editor.state()["document"]["selectedLayers"].as_array().unwrap().len(),3);
    editor.execute("layer.select",json!({"layer":ids[1],"mode":"toggle"})).unwrap();
    assert_eq!(editor.state()["document"]["selectedLayers"].as_array().unwrap().len(),2);
    assert_eq!(editor.content_hash().unwrap(),baseline);
    assert_eq!(editor.state()["document"]["history"],history);
    // 调用者反转数组也不能反转层叠顺序；批量移动只产生一步历史。
    editor.execute("layer.moveTo",json!({"layers":[ids[2],ids[0]],"target":ids[3],"position":"below"})).unwrap();
    let moved=editor.state();
    let order:Vec<_>=moved["document"]["layers"].as_array().unwrap().iter().map(|row|row["id"].as_u64().unwrap()).collect();
    let mut expected=vec![ids[1],ids[3],ids[0],ids[2]];
    expected.extend_from_slice(&ids[4..]); // file.new 自带的初始空层留在原处。
    assert_eq!(order,expected);
    assert_eq!(moved["document"]["history"].as_array().unwrap().len(),history.as_array().unwrap().len()+1);
    let changed=editor.content_hash().unwrap();assert_ne!(changed,baseline);
    editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),baseline);
    editor.redo().unwrap();assert_eq!(editor.content_hash().unwrap(),changed);
    assert_eq!(editor.state()["document"]["selectedLayers"].as_array().unwrap().len(),2);
    let stable=editor.state();
    assert!(editor.execute("layer.moveTo",json!({"layers":[ids[0],ids[2]],"target":ids[0]})).is_err());
    assert_eq!(editor.state(),stable);
}

#[test]
fn batch_layer_locks_are_atomic_strict_and_block_locked_writes_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"下层"})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"上层"})).unwrap();
    let state=editor.state();let rows=state["document"]["layers"].as_array().unwrap();
    let (a,b)=(rows[0]["id"].as_u64().unwrap(),rows[1]["id"].as_u64().unwrap());
    editor.execute("layer.select",json!({"layer":b,"mode":"add"})).unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    for invalid in [Value::Null,json!([]),json!({"all":null}),json!({"all":"true"}),json!({"unknown":true}),json!({"layer":a,"all":true})] {
        assert!(editor.execute("layer.lockLayers",invalid).is_err());assert_eq!(editor.state(),before);
    }
    editor.execute("layer.lockLayers",json!({"position":true})).unwrap();
    let locked=editor.state();assert_ne!(editor.content_hash().unwrap(),hash);
    assert_eq!(locked["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
    for row in locked["document"]["layers"].as_array().unwrap().iter().filter(|row|row["id"]==a || row["id"]==b) {assert_eq!(row["locks"]["position"],true);assert_eq!(row["effectiveLocks"]["position"],true);}
    assert!(editor.begin_transform().is_err());
    editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);editor.redo().unwrap();
    editor.execute("layer.lockLayers",json!({"all":true})).unwrap();
    let stable=editor.state();
    assert!(editor.begin_layer_properties(a).is_err());
    for params in [json!({"layer":a,"opacity":0.5}),json!({"layer":a,"blend":"Multiply"}),json!({"layer":a,"locks":{"all":"no"}}),json!({"layer":a,"locked":null})] {
        assert!(editor.execute("layer.setProps",params).is_err());assert_eq!(editor.state(),stable);
    }
    assert!(editor.execute("layer.moveTo",json!({"layer":a,"target":b})).is_err());assert_eq!(editor.state(),stable);
    assert!(editor.execute("layer.arrange.sendBackward",json!({"layer":a})).is_err());assert_eq!(editor.state(),stable);
    let commands=editor.commands();
    for id in ["edit.transform","layer.arrange.sendBackward"] {
        assert_eq!(commands.as_array().unwrap().iter().find(|entry|entry["id"]==id).unwrap()["enabled"],false);
    }
    editor.execute("layer.lockLayers",json!({"all":false,"position":false})).unwrap();
    assert_eq!(editor.content_hash().unwrap(),hash);
    editor.begin_transform().unwrap();editor.cancel_transform();
    editor.execute("layer.lockLayers",json!({"transparency":true})).unwrap();
    editor.execute("layer.lockLayers",json!({"pixels":true})).unwrap();
    for row in editor.state()["document"]["layers"].as_array().unwrap().iter().filter(|row|row["id"]==a || row["id"]==b) {assert_eq!(row["locks"]["pixels"],true);assert_eq!(row["locks"]["transparency"],false);}
}

#[test]
fn multi_copy_capacity_counts_all_targets_and_rejects_without_edits() {
    let mut editor = Editor::new();
    editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let mut ids = Vec::new();
    for _ in 0..62 {
        editor.execute("layer.new.layer",json!({})).unwrap();
        ids.push(editor.state()["document"]["activeLayer"].clone());
    }
    editor.execute("layer.select",json!({"layer":ids[0],"mode":"replace"})).unwrap();
    editor.execute("layer.select",json!({"layer":ids[1],"mode":"add"})).unwrap();
    let before = editor.state();
    for (command,params) in [
        ("layer.duplicate",json!({})),
        ("layer.new.layerViaCopy",json!({})),
        // 此命令忽略 layer 参数，不能借此绕过批量容量门禁。
        ("layer.new.layerViaCopy",json!({"layer":ids[0]})),
        ("layer.moveTo",json!({"layers":[ids[0],ids[1]],"target":ids[2],"copy":true})),
    ] {
        let error=editor.execute(command,params).unwrap_err().to_string();
        assert!(error.contains("64"),"{command}: {error}");
        assert_eq!(editor.state(),before);
    }
    // 显式复制一个目标仍可恰好达到上限。
    editor.execute("layer.duplicate",json!({"layer":ids[0]})).unwrap();
    assert_eq!(editor.state()["document"]["layers"].as_array().unwrap().len(),64);
    editor.undo().unwrap();
    assert_eq!(editor.state()["document"]["layers"],before["document"]["layers"]);
}

#[test]
fn layout_commands_report_native_gates_and_reject_without_history_changes() {
    let mut editor=Editor::new();
    editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    for _ in 0..3 {editor.execute("layer.new.layer",json!({})).unwrap();}
    let before=editor.state();
    let commands=editor.commands();
    let layout:Vec<_>=commands.as_array().unwrap().iter().filter(|command| {
        command["id"].as_str().is_some_and(|id|id.starts_with("layer.align.")||id.starts_with("layer.distribute."))
    }).collect();
    assert_eq!(layout.len(),14);
    for command in &layout {
        assert_eq!(command["allowed"],true);
        assert_eq!(command["enabled"],false);
        assert!(editor.execute(command["id"].as_str().unwrap(),Value::Null).is_err());
        assert_eq!(editor.state(),before);
    }
    for params in [json!({"to":0}),json!({"to":"unknown"}),json!({"layer":1}),json!([])] {
        assert!(editor.execute("layer.align.leftEdges",params).is_err());
        assert_eq!(editor.state(),before);
    }
    editor.begin_transform().unwrap();
    assert!(editor.execute("layer.align.leftEdges",json!({"to":"canvas"})).is_err());
    editor.cancel_transform();assert_eq!(editor.state(),before);
}

#[test]
fn batch_clipping_changes_content_and_one_history_step_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let mut ids=Vec::new();
    for name in ["基底","中层","顶层"] {
        editor.execute("layer.new.layer",json!({"name":name})).unwrap();
        ids.push(editor.state()["document"]["activeLayer"].as_u64().unwrap());
    }
    for id in &ids {editor.execute("layer.select",json!({"layer":id,"mode":"add"})).unwrap();}
    let before=editor.state();let hash=editor.content_hash().unwrap();
    editor.execute("layer.createClippingMask",Value::Null).unwrap();
    let clipped=editor.state();let clipped_hash=editor.content_hash().unwrap();assert_ne!(clipped_hash,hash);
    assert_eq!(clipped["document"]["selectedLayers"],before["document"]["selectedLayers"]);
    assert_eq!(clipped["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
    for row in clipped["document"]["layers"].as_array().unwrap() {
        assert_eq!(row["clipped"],ids[1..].contains(&row["id"].as_u64().unwrap()));
    }
    assert!(editor.execute("layer.createClippingMask",Value::Null).is_err());assert_eq!(editor.state(),clipped);
    editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
    let undone=editor.state();assert!(editor.execute("layer.releaseClippingMask",Value::Null).is_err());assert_eq!(editor.state(),undone);
    editor.redo().unwrap();assert_eq!(editor.content_hash().unwrap(),clipped_hash);
    editor.execute("layer.releaseClippingMask",Value::Null).unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
    // 显式目标只改变该层，不隐式修改其他已选层。
    editor.execute("layer.createClippingMask",json!({"layer":ids[2]})).unwrap();
    editor.execute("layer.setProps",json!({"layer":ids[1],"clipped":true})).unwrap();
    let result=editor.state();
    for id in &ids[1..] {assert_eq!(result["document"]["layers"].as_array().unwrap().iter().find(|row|row["id"]==*id).unwrap()["clipped"],true);}
    editor.execute("layer.releaseClippingMask",Value::Null).unwrap();
    // 删除基底释放原剪贴组，复用上游结构规则。
    editor.execute("layer.createClippingMask",Value::Null).unwrap();
    editor.execute("layer.delete",json!({"layer":ids[0]})).unwrap();
    assert!(editor.state()["document"]["layers"].as_array().unwrap().iter().all(|row|row["clipped"]==false));
    editor.undo().unwrap();assert!(editor.state()["document"]["layers"].as_array().unwrap().iter().any(|row|row["clipped"]==true));
}

#[test]
fn clipping_rejects_invalid_or_locked_targets_before_any_edit() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let bottom=editor.state()["document"]["activeLayer"].as_u64().unwrap();
    let before=editor.state();
    assert!(editor.execute("layer.createClippingMask",Value::Null).unwrap_err().to_string().contains("基底"));
    assert!(editor.execute("layer.setProps",json!({"clipped":true})).is_err());assert_eq!(editor.state(),before);
    let commands=editor.commands();assert_eq!(commands.as_array().unwrap().iter().find(|command|command["id"]=="layer.createClippingMask").unwrap()["enabled"],false);
    for _ in 0..2 {editor.execute("layer.new.layer",json!({})).unwrap();}
    let top=editor.state()["document"]["activeLayer"].as_u64().unwrap();
    editor.execute("layer.setProps",json!({"layer":top,"locked":true})).unwrap();
    let stable=editor.state();
    for (command,params) in [
        ("layer.createClippingMask",Value::Null), ("layer.releaseClippingMask",Value::Null),
        ("layer.createClippingMask",json!({"layer":999})), ("layer.createClippingMask",json!({"layer":"top"})),
        ("layer.createClippingMask",json!({"layers":[bottom,top]})), ("layer.releaseClippingMask",json!([])),
        ("layer.setProps",json!({"clipped":null})), ("layer.setProps",json!({"clipped":"true"})),
        ("layer.setProps",json!({"clipped":true})),
    ] {assert!(editor.execute(command,params).is_err());assert_eq!(editor.state(),stable);}
    editor.execute("layer.setProps",json!({"layer":top,"locked":false})).unwrap();
    editor.begin_transform().unwrap();assert!(editor.execute("layer.createClippingMask",Value::Null).is_err());editor.cancel_transform();
    editor.execute("layer.createClippingMask",Value::Null).unwrap();
}

#[test]
fn batch_clipping_checks_nonactive_targets_before_edit_and_keeps_locked_base() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let mut ids=Vec::new();
    for _ in 0..3 {
        editor.execute("layer.new.layer",json!({})).unwrap();
        ids.push(editor.state()["document"]["activeLayer"].as_u64().unwrap());
    }
    for id in &ids {editor.execute("layer.select",json!({"layer":id,"mode":"add"})).unwrap();}
    editor.execute("layer.setProps",json!({"layer":ids[1],"locked":true})).unwrap();
    let before=editor.state();
    assert!(editor.execute("layer.createClippingMask",Value::Null).is_err());assert_eq!(editor.state(),before);
    editor.execute("layer.setProps",json!({"layer":ids[1],"locked":false})).unwrap();
    // 最低所选层不被创建命令修改，其全部锁定不应阻止上层创建。
    editor.execute("layer.setProps",json!({"layer":ids[0],"locked":true})).unwrap();
    editor.execute("layer.createClippingMask",Value::Null).unwrap();
    let state=editor.state();
    let base=state["document"]["layers"].as_array().unwrap().iter().find(|row|row["id"]==ids[0]).unwrap();
    assert_eq!(base["clipped"],false);assert_eq!(base["locks"]["all"],true);
}

#[test]
fn clipboard_commands_reject_external_payloads_and_drafts_without_rendering() {
    let ids=["edit.copy","edit.copyMerged","edit.cut","edit.paste","edit.pasteSpecial.pasteInPlace"];
    let mut editor=Editor::new();
    for id in ids {assert!(editor.execute(id,Value::Null).is_err());}
    editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",Value::Null).unwrap();
    let commands=editor.commands();
    for id in ids {
        let command=commands.as_array().unwrap().iter().find(|command|command["id"]==id).unwrap();
        assert_eq!(command["allowed"],true);
        assert!(!command["menu"].as_array().unwrap().is_empty());
        if id.starts_with("edit.paste") {assert_eq!(command["enabled"],false);}
    }
    let before=editor.state();
    for id in ids {
        assert!(editor.execute(id,json!({"payload":"canvas nodes","target":"mask"})).is_err());
        assert_eq!(editor.state(),before);
    }
    let layer=before["document"]["activeLayer"].as_u64().unwrap();
    editor.begin_layer_properties(layer).unwrap();
    for id in ids {assert!(editor.execute(id,Value::Null).is_err());}
    editor.cancel_layer_properties();
    assert_eq!(editor.state(),before);
    assert!(editor.execute("file.newFromClipboard",Value::Null).is_err());
}


#[test]
fn visibility_sweep_is_strict_cancelable_atomic_and_allows_locked_layer_eyes_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"A"})).unwrap();let a=editor.state()["document"]["activeLayer"].clone();
    editor.execute("layer.new.layer",json!({"name":"B"})).unwrap();let b=editor.state()["document"]["activeLayer"].clone();
    editor.execute("layer.setProps",json!({"layer":a,"locks":{"all":true}})).unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    editor.begin_layer_visibility(a.as_u64().unwrap()).unwrap();
    editor.preview_layer_properties(json!({"layers":[a,b],"visible":false})).unwrap();
    assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    assert!(editor.execute("edit.undo",Value::Null).is_err());
    editor.cancel_layer_properties();assert_eq!(editor.state(),before);
    editor.begin_layer_visibility(a.as_u64().unwrap()).unwrap();
    for params in [json!({"layers":[a,a],"visible":false}),json!({"layers":[b],"visible":false}),json!({"layers":[a,9999999999u64],"visible":false}),json!({"layers":[],"visible":true}),json!({"layers":[a],"visible":null}),json!({"opacity":0.5}),json!({"layers":[a],"visible":false,"name":"bad"})] {
        assert!(editor.preview_layer_properties(params).is_err());assert!(editor.commit_layer_properties().is_err());assert_eq!(editor.state(),before);
    }
    editor.preview_layer_properties(json!({"layers":[a],"visible":false})).unwrap();
    editor.preview_layer_properties(json!({"layers":[a,b],"visible":false})).unwrap();
    editor.commit_layer_properties().unwrap();
    let after=editor.state();assert_eq!(after["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
    for layer in after["document"]["layers"].as_array().unwrap() {if layer["id"]==a || layer["id"]==b {assert_eq!(layer["visible"],false);}}
    editor.undo().unwrap();assert_eq!(editor.state()["document"]["layers"],before["document"]["layers"]);
    editor.redo().unwrap();assert_eq!(editor.state()["document"]["layers"],after["document"]["layers"]);
}

#[test]
fn selected_layer_opacity_and_fill_share_one_candidate_and_reject_locked_members_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"A"})).unwrap();let a=editor.state()["document"]["activeLayer"].clone();
    editor.execute("layer.new.layer",json!({"name":"B"})).unwrap();let b=editor.state()["document"]["activeLayer"].clone();
    editor.execute("layer.select",json!({"layer":a,"mode":"add"})).unwrap();
    let before=editor.state();editor.begin_layer_properties(a.as_u64().unwrap()).unwrap();
    editor.preview_layer_properties(json!({"opacity":0.5,"fill":0.25})).unwrap();assert_eq!(editor.state(),before);
    editor.commit_layer_properties().unwrap();let after=editor.state();
    for layer in after["document"]["layers"].as_array().unwrap() {if layer["id"]==a || layer["id"]==b {assert_eq!(layer["opacity"],0.5);assert_eq!(layer["fill"],0.25);}}
    assert_eq!(after["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
    editor.undo().unwrap();assert_eq!(editor.state()["document"]["layers"],before["document"]["layers"]);
    editor.execute("layer.setProps",json!({"layer":b,"locks":{"all":true}})).unwrap();let locked=editor.state();
    editor.begin_layer_properties(a.as_u64().unwrap()).unwrap();assert!(editor.preview_layer_properties(json!({"opacity":0.5})).is_err());assert!(editor.commit_layer_properties().is_err());editor.cancel_layer_properties();assert_eq!(editor.state(),locked);
}

#[test]
fn deselect_layers_is_view_only_and_reverse_checks_every_selected_lock_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let a=editor.execute("layer.new.layer",json!({"name":"A"})).unwrap()["layer"].clone();
    let b=editor.execute("layer.new.layer",json!({"name":"B"})).unwrap()["layer"].clone();
    editor.execute("layer.select",json!({"layer":a,"mode":"add"})).unwrap();
    let initial=editor.state()["document"].clone();let hash=editor.content_hash().unwrap();
    editor.execute("select.deselectLayers",Value::Null).unwrap();
    assert!(editor.state()["document"]["activeLayer"].is_null());assert_eq!(editor.state()["document"]["selectedLayers"],json!([]));
    assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.state()["document"]["history"],initial["history"]);
    editor.execute("layer.select",json!({"layer":b})).unwrap();editor.execute("layer.select",json!({"layer":a,"mode":"add"})).unwrap();
    editor.execute("layer.arrange.reverse",Value::Null).unwrap();let reversed=editor.state()["document"]["layers"].clone();assert_ne!(reversed,initial["layers"]);
    editor.undo().unwrap();assert_eq!(editor.state()["document"]["layers"],initial["layers"]);
    editor.execute("layer.setProps",json!({"layer":b,"locks":{"all":true}})).unwrap();
    let before=editor.state();assert!(editor.execute("layer.arrange.reverse",Value::Null).is_err());assert_eq!(editor.state(),before);
}

#[test]
fn new_layer_options_are_validated_before_atomic_creation_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let before=editor.state();
    for params in [json!({"opacity":-0.1}),json!({"opacity":1.1}),json!({"opacity":"1"}),json!({"clipToPrevious":1}),json!({"fillNeutral":"yes"}),json!({"name":"x".repeat(201)}),json!({"color":"invalid"}),json!({"mode":"invalid"}),json!({"position":"invalid"})] {
        assert!(editor.execute("layer.new.layer",params).is_err());assert_eq!(editor.state(),before);
    }
    let a=editor.execute("layer.new.layer",json!({"name":"A"})).unwrap()["layer"].clone();
    let lower=editor.execute("layer.new.layer",json!({"name":"Below","position":"below","mode":"Multiply","opacity":0.5})).unwrap()["layer"].clone();
    let state=editor.state()["document"].clone();let rows=state["layers"].as_array().unwrap();
    let ai=rows.iter().position(|layer|layer["id"]==a).unwrap();let li=rows.iter().position(|layer|layer["id"]==lower).unwrap();assert_eq!(ai+1,li);
    assert_eq!(rows[li]["blend"],"Multiply");assert_eq!(rows[li]["opacity"],0.5);assert_eq!(state["nextLayerName"],"Layer 1");
    editor.undo().unwrap();assert_eq!(editor.state()["document"]["layers"].as_array().unwrap().len(),2);
    editor.redo().unwrap();assert_eq!(editor.state()["document"]["layers"],state["layers"]);
}

#[test]
fn labels_and_links_have_atomic_history_strict_arguments_and_view_only_linked_selection_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let a=editor.execute("layer.new.layer",json!({"name":"A"})).unwrap()["layer"].clone();
    let b=editor.execute("layer.new.layer",json!({"name":"B"})).unwrap()["layer"].clone();
    editor.execute("layer.select",json!({"layer":a,"mode":"add"})).unwrap();let before=editor.state();let hash=editor.content_hash().unwrap();
    for (id,params) in [("layer.setLabelColor",json!({"color":"red","unknown":true})),("layer.linkLayers",json!({"layers":[a,b]})),("layer.selectLinkedLayers",json!({"layer":a}))] {
        assert!(editor.execute(id,params).is_err());assert_eq!(editor.state(),before);
    }
    editor.execute("layer.setLabelColor",json!({"color":"red"})).unwrap();assert_ne!(editor.content_hash().unwrap(),hash);
    let labeled=editor.state()["document"].clone();editor.execute("layer.linkLayers",Value::Null).unwrap();let linked=editor.state()["document"].clone();
    assert_eq!(linked["history"].as_array().unwrap().len(),labeled["history"].as_array().unwrap().len()+1);
    assert!(linked["layers"][0]["linkGroup"].as_u64().is_some());assert_eq!(linked["layers"][0]["linkGroup"],linked["layers"][1]["linkGroup"]);
    let linked_hash=editor.content_hash().unwrap();editor.undo().unwrap();assert_eq!(editor.state()["document"]["layers"],labeled["layers"]);editor.redo().unwrap();assert_eq!(editor.content_hash().unwrap(),linked_hash);
    editor.execute("layer.select",json!({"layer":a})).unwrap();editor.execute("layer.selectLinkedLayers",Value::Null).unwrap();assert_eq!(editor.state()["document"]["selectedLayers"].as_array().unwrap().len(),2);assert_eq!(editor.content_hash().unwrap(),linked_hash);
    editor.execute("layer.linkLayers",Value::Null).unwrap();assert_ne!(editor.content_hash().unwrap(),linked_hash);
}

#[test]
fn hidden_layers_and_hidden_ancestors_reject_move_and_stroke_before_any_edit_without_rendering() {
    use photocraft_doc::{ColorMode,Document,Layer,SampleType,Size};
    let mut doc=Document::new("隐藏目标",Size::new(16,16),ColorMode::Rgb,SampleType::U8);
    let child=Layer::raster("内容",doc.pixel_format());let child_id=child.id;
    let mut group=Layer::group("隐藏组",vec![child]);group.visible=false;doc.layers=vec![group];
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();
    editor.execute("layer.select",json!({"layer":child_id.0})).unwrap();let before=editor.state();let hash=editor.content_hash().unwrap();
    let error=editor.begin_move(json!({"x":5,"y":5,"autoSelect":false})).unwrap_err();assert!(error.to_string().contains("隐藏"));
    assert!(editor.begin_stroke(json!({"points":[]})).unwrap_err().to_string().contains("隐藏"));
    assert!(editor.execute("paint.stroke",json!({"points":[]})).unwrap_err().to_string().contains("隐藏"));
    assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    for params in [json!({"x":"5","y":5}),json!({"x":5,"y":5,"target":"invalid"}),json!({"x":5,"y":5,"mode":"toggle"}),json!({"x":5,"y":5,"extra":true})] {
        assert!(editor.execute("layer.pickAt",params).is_err());assert_eq!(editor.state(),before);
    }
    let picked=editor.execute("layer.pickAt",json!({"x":5,"y":5,"target":"group"})).unwrap();assert!(picked["layer"].is_null());assert_eq!(editor.state(),before);
}

#[test]
fn move_picker_groups_and_adds_selection_without_content_or_history_writes() {
    use photocraft_doc::{ColorMode,Document,Layer,SampleType,Size};
    let mut doc=Document::new("拾取",Size::new(16,16),ColorMode::Rgb,SampleType::U8);
    let mut a=Layer::raster("A",doc.pixel_format());a.surface_mut().unwrap().fill_rect(photocraft_geom::Rect::new(1,1,3,3),&[1.,0.,0.,1.]);let a_id=a.id;
    let mut b=Layer::raster("B",doc.pixel_format());b.surface_mut().unwrap().fill_rect(photocraft_geom::Rect::new(8,8,10,10),&[0.,1.,0.,1.]);let b_id=b.id;
    let group=Layer::group("组",vec![b]);let group_id=group.id;doc.layers=vec![a,group];
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();
    editor.execute("layer.select",json!({"layer":a_id.0})).unwrap();let hash=editor.content_hash().unwrap();let history=editor.state()["document"]["history"].clone();
    assert_eq!(editor.execute("layer.pickAt",json!({"x":9,"y":9,"target":"group","mode":"add"})).unwrap()["layer"],group_id.0);
    let selected=editor.state()["document"]["selectedLayers"].clone();assert!(selected.as_array().unwrap().contains(&json!(a_id.0)));assert!(selected.as_array().unwrap().contains(&json!(group_id.0)));
    assert_eq!(editor.execute("layer.pickAt",json!({"x":9,"y":9,"target":"layer","mode":"replace"})).unwrap()["layer"],b_id.0);
    assert_eq!(editor.state()["document"]["selectedLayers"],json!([b_id.0]));assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.state()["document"]["history"],history);
}

#[test]
fn layer_via_cut_rejects_locked_mask_and_invalid_inputs_atomically_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();editor.execute("layer.new.layer",json!({})).unwrap();
    let before=editor.state();assert!(editor.execute("layer.new.layerViaCut",json!({"layer":1})).is_err());assert_eq!(editor.state(),before);
    editor.execute("layer.lockLayers",json!({"pixels":true})).unwrap();let locked=editor.state();
    assert!(editor.execute("layer.new.layerViaCut",Value::Null).is_err());assert_eq!(editor.state(),locked);
    let commands=editor.commands();assert_eq!(commands.as_array().unwrap().iter().find(|command|command["id"]=="layer.new.layerViaCut").unwrap()["enabled"],false);
    editor.execute("layer.lockLayers",json!({"pixels":false})).unwrap();editor.execute("layer.layerMask.revealAll",Value::Null).unwrap();editor.execute("channel.target.layerMask",Value::Null).unwrap();let masked=editor.state();
    assert!(editor.execute("layer.new.layerViaCut",Value::Null).unwrap_err().to_string().contains("蒙版"));assert_eq!(editor.state(),masked);
}

#[test]
fn layer_via_cut_commits_once_clears_selection_and_obeys_capacity_without_rendering() {
    use photocraft_doc::{ColorMode,Document,Layer,SampleType,Size};
    let mut doc=Document::new("剪切",Size::new(16,16),ColorMode::Rgb,SampleType::U8);
    let mut layer=Layer::raster("像素",doc.pixel_format());layer.surface_mut().unwrap().fill_rect(photocraft_geom::Rect::new(0,0,8,8),&[1.,0.,0.,1.]);doc.layers=vec![layer];
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();
    editor.execute("select.rect",json!({"x":1,"y":1,"width":4,"height":4})).unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    editor.execute("layer.new.layerViaCut",Value::Null).unwrap();let after=editor.state();let cut_hash=editor.content_hash().unwrap();
    assert_ne!(cut_hash,hash);assert_eq!(after["document"]["layers"].as_array().unwrap().len(),2);
    assert_eq!(after["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);assert_eq!(after["document"]["hasSelection"],false);
    editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.state()["document"]["selectionFrame"],before["document"]["selectionFrame"]);
    editor.redo().unwrap();assert_eq!(editor.content_hash().unwrap(),cut_hash);
    while editor.state()["document"]["layers"].as_array().unwrap().len()<64 {editor.execute("layer.new.layer",json!({})).unwrap();}
    let full=editor.state();assert!(editor.execute("layer.new.layerViaCut",Value::Null).is_err());assert_eq!(editor.state(),full);
}

#[test]
fn single_line_marquees_use_authoritative_extent_and_reject_outside_coordinates_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":12})).unwrap();
    let hash=editor.content_hash().unwrap();
    editor.execute("select.rect",json!({"x":99,"y":11,"width":2,"height":8,"line":"row"})).unwrap();
    assert_eq!(editor.state()["document"]["selectionFrame"],json!([0,11,16,12]));assert_eq!(editor.content_hash().unwrap(),hash);
    editor.execute("select.rect",json!({"x":15,"y":99,"line":"column"})).unwrap();
    assert_eq!(editor.state()["document"]["selectionFrame"],json!([15,0,16,12]));let before=editor.state();
    for params in [json!({"x":16,"line":"column"}),json!({"y":-1,"line":"row"}),json!({"x":1,"line":"diagonal"}),json!({"y":1,"line":"row","ellipse":true})] {assert!(editor.execute("select.rect",params).is_err());assert_eq!(editor.state(),before);}
    editor.undo().unwrap();assert_eq!(editor.state()["document"]["selectionFrame"],json!([0,11,16,12]));
}

#[test]
fn clipping_separator_commits_chain_once_preserves_create_selection_and_rejects_partial_release_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let base=editor.state()["document"]["activeLayer"].clone();
    let a=editor.execute("layer.new.layer",json!({"name":"A"})).unwrap()["layer"].clone();
    let b=editor.execute("layer.new.layer",json!({"name":"B"})).unwrap()["layer"].clone();
    let c=editor.execute("layer.new.layer",json!({"name":"C"})).unwrap()["layer"].clone();
    let selected=editor.state()["document"]["selectedLayers"].clone();
    for (upper,lower) in [(&a,&base),(&b,&a),(&c,&b)] {editor.execute("layer.toggleClippingAt",json!({"upper":upper,"lower":lower})).unwrap();assert_eq!(editor.state()["document"]["selectedLayers"],selected);}
    editor.execute("layer.setProps",json!({"layer":c,"locks":{"all":true}})).unwrap();let locked=editor.state();let hash=editor.content_hash().unwrap();
    assert!(editor.execute("layer.toggleClippingAt",json!({"upper":a,"lower":base})).is_err());assert_eq!(editor.state(),locked);assert_eq!(editor.content_hash().unwrap(),hash);
    editor.execute("layer.setProps",json!({"layer":c,"locks":{"all":false}})).unwrap();let before=editor.state();
    for params in [json!({"upper":a,"lower":c}),json!({"upper":999,"lower":base}),json!({"upper":a,"lower":base,"extra":true})] {assert!(editor.execute("layer.toggleClippingAt",params).is_err());assert_eq!(editor.state(),before);}
    editor.execute("layer.toggleClippingAt",json!({"upper":a,"lower":base})).unwrap();let released=editor.state();
    for layer in released["document"]["layers"].as_array().unwrap() {assert_ne!(layer["clipped"],true);}
    assert_eq!(released["document"]["activeLayer"],a);assert_eq!(released["document"]["selectedLayers"],json!([a]));
    assert_eq!(released["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
    let released_hash=editor.content_hash().unwrap();editor.undo().unwrap();assert_eq!(editor.state()["document"]["layers"],before["document"]["layers"]);editor.redo().unwrap();assert_eq!(editor.content_hash().unwrap(),released_hash);
}

#[test]
fn exact_selection_hit_reads_low_coverage_and_sparse_pixels_without_content_writes_or_rendering() {
    use photocraft_doc::{ColorMode,Document,Layer,LayerMask,SampleType,Size};
    let mut doc=Document::new("稀疏选区",Size::new(1024,1024),ColorMode::Rgb,SampleType::U8);doc.layers=vec![Layer::raster("图层",doc.pixel_format())];
    let mut selection=LayerMask::hide_all().surface;selection.write_pixel(1,1,&[0.1]);selection.write_pixel(1001,1001,&[0.4]);doc.selection=Some(selection);
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();let before=editor.state();let hash=editor.content_hash().unwrap();
    assert!(editor.selection_contains(1.9,1.9).unwrap());assert!(editor.selection_contains(1001.,1001.).unwrap());
    for (x,y) in [(2.,1.),(-0.1,1.),(1024.,1.),(1.,1024.)] {assert!(!editor.selection_contains(x,y).unwrap());}
    assert!(editor.selection_contains(f64::NAN,1.).is_err());assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
}

#[test]
fn layer_search_all_and_isolation_are_view_only_strict_and_keep_clean_project_without_rendering() {
    use photocraft_doc::{ColorMode,Document,Layer,SampleType,Size};
    let mut doc=Document::new("查找",Size::new(16,16),ColorMode::Rgb,SampleType::U8);doc.layers=vec![Layer::raster("Photo One",doc.pixel_format()),Layer::raster("photo Two",doc.pixel_format()),Layer::raster("Other",doc.pixel_format())];
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();let hash=editor.content_hash().unwrap();let history=editor.state()["document"]["history"].clone();
    editor.execute("select.findLayers",json!({"name":"PHOTO"})).unwrap();let found=editor.state()["document"]["selectedLayers"].clone();assert_eq!(found.as_array().unwrap().len(),2);
    editor.execute("select.isolateLayers",Value::Null).unwrap();assert_eq!(editor.state()["document"]["isolatedLayers"],found);
    editor.execute("select.deselectLayers",Value::Null).unwrap();
    assert_eq!(editor.commands().as_array().unwrap().iter().find(|c|c["id"]=="select.isolateLayers").unwrap()["enabled"],true);
    editor.execute("select.isolateLayers",json!({"on":false})).unwrap();assert_eq!(editor.state()["document"]["isolatedLayers"],json!([]));
    editor.execute("select.allLayers",Value::Null).unwrap();assert_eq!(editor.state()["document"]["selectedLayers"].as_array().unwrap().len(),3);
    let before=editor.state();for (id,params) in [("select.allLayers",json!({"extra":1})),("select.findLayers",json!({"name":""})),("select.findLayers",json!({"name":"nothing"})),("select.isolateLayers",json!({"on":1}))] {assert!(editor.execute(id,params).is_err());assert_eq!(editor.state(),before);}
    assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.state()["document"]["history"],history);assert_eq!(editor.state()["session"]["documents"][0]["dirty"],false);
}

#[test]
fn batch_hidden_cleanup_repairs_clipping_rejects_locked_descendants_and_is_one_undo_without_rendering() {
    use photocraft_doc::{ColorMode,Document,Layer,SampleType,Size};
    let mut doc=Document::new("隐藏清理",Size::new(16,16),ColorMode::Rgb,SampleType::U8);
    let mut base=Layer::raster("基底",doc.pixel_format());base.visible=false;
    let mut clipped=Layer::raster("剪贴",doc.pixel_format());clipped.clipped=true;let clipped_id=clipped.id;
    let mut child=Layer::raster("锁定子层",doc.pixel_format());child.locks.all=true;let child_id=child.id;
    let mut group=Layer::group("隐藏组",vec![child]);group.visible=false;doc.layers=vec![base,clipped,group];
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();let locked=editor.state();
    assert!(editor.execute("layer.delete.hiddenLayers",Value::Null).is_err());assert_eq!(editor.state(),locked);
    editor.execute("layer.setProps",json!({"layer":child_id.0,"locks":{"all":false}})).unwrap();let before=editor.state();let hash=editor.content_hash().unwrap();
    let deleted=editor.execute("layer.delete.hiddenLayers",Value::Null).unwrap();assert_eq!(deleted["deleted"],3);let after=editor.state();assert_eq!(after["document"]["layers"].as_array().unwrap().len(),1);assert_eq!(after["document"]["layers"][0]["id"],clipped_id.0);assert_eq!(after["document"]["layers"][0]["clipped"],false);
    assert_eq!(after["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);editor.redo().unwrap();
    let after=editor.state();assert!(editor.execute("layer.delete.hiddenLayers",Value::Null).is_err());assert_eq!(editor.state(),after);
}

#[test]
fn empty_cleanup_preserves_masked_rasters_and_rejects_last_layer_without_rendering() {
    use photocraft_doc::{ColorMode,Document,Layer,LayerMask,SampleType,Size};
    let mut doc=Document::new("空层清理",Size::new(16,16),ColorMode::Rgb,SampleType::U8);
    let mut kept=Layer::raster("带蒙版",doc.pixel_format());kept.mask=Some(LayerMask::reveal_all());let kept_id=kept.id;
    doc.layers=vec![kept,Layer::group("空组",vec![Layer::raster("空子层",doc.pixel_format())])];
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();let before=editor.state();
    assert_eq!(editor.execute("file.scripts.deleteAllEmptyLayers",Value::Null).unwrap()["deleted"],2);assert_eq!(editor.state()["document"]["layers"][0]["id"],kept_id.0);
    editor.undo().unwrap();assert_eq!(editor.state()["document"]["layers"],before["document"]["layers"]);
    editor.execute("layer.select",json!({"layer":kept_id.0})).unwrap();editor.execute("layer.layerMask.delete",Value::Null).unwrap();let empty=editor.state();
    assert!(editor.execute("file.scripts.deleteAllEmptyLayers",Value::Null).is_err());assert_eq!(editor.state(),empty);
}

#[test]
fn blend_preview_is_batch_cancelable_strict_and_noop_keeps_redo_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let a=editor.execute("layer.new.layer",json!({"name":"A"})).unwrap()["layer"].clone();let b=editor.execute("layer.new.layer",json!({"name":"B"})).unwrap()["layer"].clone();editor.execute("layer.select",json!({"layer":a,"mode":"add"})).unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    editor.begin_layer_properties(a.as_u64().unwrap()).unwrap();editor.preview_layer_properties(json!({"blend":"Multiply"})).unwrap();assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    assert!(editor.preview_layer_properties(json!({"blend":"Pass Through"})).is_err());assert!(editor.commit_layer_properties().is_err());assert_eq!(editor.state(),before);editor.cancel_layer_properties();
    editor.begin_layer_properties(a.as_u64().unwrap()).unwrap();editor.preview_layer_properties(json!({"blend":"Screen"})).unwrap();editor.commit_layer_properties().unwrap();let after=editor.state();
    for layer in after["document"]["layers"].as_array().unwrap() {if layer["id"]==a || layer["id"]==b {assert_eq!(layer["blend"],"Screen");}}
    assert_eq!(after["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);editor.undo().unwrap();let undone=editor.state();
    editor.begin_layer_properties(a.as_u64().unwrap()).unwrap();editor.preview_layer_properties(json!({"blend":"Normal"})).unwrap();editor.commit_layer_properties().unwrap();assert_eq!(editor.state(),undone);assert_eq!(editor.content_hash().unwrap(),hash);
    for mode in [json!(false),json!("invalid"),json!("Pass Through")] {let params=json!({"mode":mode,"points":[]});assert!(editor.begin_stroke(params.clone()).is_err());assert!(editor.execute("paint.stroke",params).is_err());assert_eq!(editor.state(),undone);}
}

#[test]
fn forced_new_text_is_strict_cancelable_capacity_checked_and_hidden_text_rejects_without_rendering() {
    use photocraft_doc::*;
    let mut doc=Document::new("文字",Size::new(200,100),ColorMode::Rgb,SampleType::U8);
    let layer=Layer::new("标题",LayerContent::Text(TextLayer{text:"原文".into(),font_family:"Inter".into(),..Default::default()}));let id=layer.id;
    doc.layers=vec![layer];let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();
    let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();let hash=editor.content_hash().unwrap();let before=editor.state()["document"].clone();
    for p in [json!({"x":20,"y":20,"forceNew":"yes"}),json!({"layer":id.0,"forceNew":true})] {assert!(editor.begin_text(p).is_err());}
    let info=editor.begin_text(json!({"x":20,"y":20,"forceNew":true})).unwrap();assert_eq!(info["new"],true);assert_eq!(info["layer"],Value::Null);assert_eq!(editor.content_hash().unwrap(),hash);editor.cancel_text();assert_eq!(editor.state()["document"],before);
    editor.execute("layer.setProps",json!({"visible":false})).unwrap();assert!(editor.begin_text(json!({"layer":id.0})).is_err());
    while doc.layers.len()<64 {doc.layers.push(Layer::raster("空",doc.pixel_format()));}
    let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();let hash=editor.content_hash().unwrap();
    assert!(editor.begin_text(json!({"x":20,"y":20,"forceNew":true})).is_err());assert_eq!(editor.content_hash().unwrap(),hash);
}

#[test]
fn mask_property_command_is_strict_and_draft_exclusive_without_rendering() {
    let mut editor=photocraft_embed_editor::Editor::new();
    editor.execute("file.new",serde_json::json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.layerMask.hideAll",serde_json::Value::Null).unwrap();
    let original=editor.content_hash().unwrap();
    for params in [serde_json::json!({}),serde_json::json!({"density":101}),serde_json::json!({"density":null}),serde_json::json!({"feather":1001}),serde_json::json!({"feather":1,"document":99999}),serde_json::json!({"density":50,"unknown":1})] {
        assert!(editor.execute("layer.layerMask.edit",params).is_err());assert_eq!(editor.content_hash().unwrap(),original);
    }
    editor.execute("layer.layerMask.edit",serde_json::json!({"density":37,"feather":4.25})).unwrap();
    assert_ne!(editor.content_hash().unwrap(),original);
    editor.execute("edit.undo",serde_json::Value::Null).unwrap();assert_eq!(editor.content_hash().unwrap(),original);
    editor.execute("edit.redo",serde_json::Value::Null).unwrap();let changed=editor.content_hash().unwrap();
    editor.execute("layer.layerMask.edit",serde_json::json!({"density":37,"feather":4.25})).unwrap();
    editor.execute("edit.undo",serde_json::Value::Null).unwrap();assert_eq!(editor.content_hash().unwrap(),original);
    editor.execute("edit.redo",serde_json::Value::Null).unwrap();assert_eq!(editor.content_hash().unwrap(),changed);
}

#[test]
fn translated_selection_geometry_can_cross_document_bounds_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    let pixels=editor.content_hash().unwrap();
    editor.execute("select.rect",json!({"x":-10,"y":-10,"width":20,"height":20})).unwrap();
    assert!(editor.selection_contains(0.5,0.5).unwrap());assert!(!editor.selection_contains(15.5,15.5).unwrap());
    assert_eq!(editor.content_hash().unwrap(),pixels);
    editor.execute("select.lasso",json!({"points":[[-10,-10],[10,-10],[10,10],[-10,10]],"mode":"replace"})).unwrap();
    assert!(editor.selection_contains(0.5,0.5).unwrap());assert!(!editor.selection_contains(15.5,15.5).unwrap());
    assert_eq!(editor.content_hash().unwrap(),pixels);
}

#[test]
fn purge_history_is_state_only_strict_and_draft_gated_without_rendering() {
    let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16})).unwrap();
    editor.execute("layer.new.layer",json!({"name":"A"})).unwrap();editor.execute("layer.new.layer",json!({"name":"B"})).unwrap();
    let hash=editor.content_hash().unwrap();let revision=editor.revision().unwrap();
    let before=editor.state()["document"]["history"].as_array().unwrap().len();
    assert!(editor.execute("edit.purge.undo",json!({"document":1})).is_err());
    editor.execute("edit.purge.undo",Value::Null).unwrap();assert_eq!(editor.state()["document"]["history"].as_array().unwrap().len(),before-1);
    assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.revision().unwrap(),revision);
    let layer=editor.state()["document"]["activeLayer"].as_u64().unwrap();editor.begin_layer_properties(layer).unwrap();
    assert!(editor.execute("edit.purge.histories",Value::Null).is_err());editor.cancel_layer_properties();
    editor.execute("edit.undo",Value::Null).unwrap();let current=editor.content_hash().unwrap();
    editor.execute("edit.purge.histories",json!({})).unwrap();
    assert_eq!(editor.content_hash().unwrap(),current);assert_eq!(editor.state()["document"]["history"].as_array().unwrap().len(),1);assert_eq!(editor.state()["document"]["redoHistory"].as_array().unwrap().len(),0);
    let commands=editor.commands();
    for id in ["edit.purge.undo","edit.purge.histories","edit.purge.clipboard"] {
      let command=commands.as_array().unwrap().iter().find(|c|c["id"]==id).unwrap();assert_eq!(command["allowed"],true);assert_eq!(command["enabled"],false);
    }
    let result=editor.execute("edit.purge.videoCache",Value::Null).unwrap();assert_eq!(result["bytes"],0);assert_eq!(editor.content_hash().unwrap(),current);
}

#[test]
fn history_state_jump_is_one_revision_and_rejects_invalid_targets_without_changes() {
 let mut e=Editor::new();e.execute("file.new",json!({"width":8,"height":6})).unwrap();
 let start=e.content_hash().unwrap();
 for name in ["one","two","three"]{e.execute("layer.new.layer",json!({"name":name})).unwrap();}
 let end=e.content_hash().unwrap();let revision=e.revision().unwrap();
 e.execute("history.selectState",json!({"state":0})).unwrap();assert_eq!(e.content_hash().unwrap(),start);assert_eq!(e.revision().unwrap(),revision+1);
 assert_eq!(e.state()["document"]["redoHistory"].as_array().unwrap().len(),3);
 e.execute("history.selectState",json!({"state":3})).unwrap();assert_eq!(e.content_hash().unwrap(),end);assert_eq!(e.revision().unwrap(),revision+2);
 let state=e.state();for p in [json!({"state":-1}),json!({"state":0.5}),json!({"state":"1"}),json!({"state":4}),json!({"state":1,"extra":true}),Value::Null]{assert!(e.execute("history.selectState",p).is_err());assert_eq!(e.state(),state);assert_eq!(e.content_hash().unwrap(),end);}
 e.execute("history.selectState",json!({"state":3})).unwrap();assert_eq!(e.revision().unwrap(),revision+2);
}

#[test]
fn history_snapshots_are_session_only_and_restore_once_with_undo_and_strict_errors() {
 let mut e=Editor::new();e.execute("file.new",json!({"width":8,"height":6})).unwrap();
 let start=e.content_hash().unwrap();let revision=e.revision().unwrap();
 let first=e.execute("history.newSnapshot",json!({"name":"Before"})).unwrap()["snapshot"].clone();
 assert_eq!(e.content_hash().unwrap(),start);assert_eq!(e.revision().unwrap(),revision);
 e.execute("layer.new.layer",json!({"name":"After"})).unwrap();let edited=e.content_hash().unwrap();
 e.execute("history.renameSnapshot",json!({"snapshot":first,"name":"Original"})).unwrap();assert_eq!(e.content_hash().unwrap(),edited);
 assert_eq!(e.state()["document"]["historySnapshots"][0]["name"],"Original");
 let current=e.revision().unwrap();e.execute("history.selectSnapshot",json!({"snapshot":first})).unwrap();assert_eq!(e.content_hash().unwrap(),start);assert_eq!(e.revision().unwrap(),current+1);
 e.undo().unwrap();assert_eq!(e.content_hash().unwrap(),edited);
 let second=e.execute("history.newSnapshot",json!({"from":"currentLayer"})).unwrap()["snapshot"].clone();assert_ne!(first,second);
 let state=e.state();for (id,p) in [("history.newSnapshot",json!({"name":"  "})),("history.newSnapshot",json!({"from":"bad"})),("history.newSnapshot",json!({"extra":1})),("history.renameSnapshot",json!({"snapshot":first,"name":"bad\nname"})),("history.renameSnapshot",json!({"snapshot":first})),("history.deleteSnapshot",json!({"snapshot":999}))]{assert!(e.execute(id,p).is_err());assert_eq!(e.state(),state);assert_eq!(e.content_hash().unwrap(),edited);}
 e.execute("history.deleteSnapshot",json!({"snapshot":first})).unwrap();assert_eq!(e.state()["document"]["historySnapshots"].as_array().unwrap().len(),1);assert_eq!(e.content_hash().unwrap(),edited);
 e.execute("history.selectSnapshot",json!({"snapshot":second})).unwrap();assert_eq!(e.state()["document"]["layers"].as_array().unwrap().len(),1);
}

#[test]
fn text_refresh_is_atomic_one_step_strict_and_gated_by_locks_and_drafts() {
 let mut editor=Editor::new();assert!(editor.execute("type.updateAllTextLayers",Value::Null).is_err());
 editor.execute("file.new",json!({"width":64,"height":48})).unwrap();assert!(editor.execute("type.updateAllTextLayers",json!({})).is_err());
 let a=editor.execute("type.create",json!({"x":2,"y":4,"text":"Hello","font":"Inter","size":12})).unwrap()["layer"].clone();
 let b=editor.execute("type.create",json!({"box":[2,4,40,30],"text":"World","font":"Inter","size":10})).unwrap()["layer"].clone();
 let before=editor.state()["document"].clone();let hash=editor.content_hash().unwrap();
 for params in [json!([]),json!({"layer":a}),json!({"unknown":true})]{assert!(editor.execute("type.updateAllTextLayers",params).is_err());assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.state()["document"],before);}
 let result=editor.execute("type.updateAllTextLayers",Value::Null).unwrap();assert_eq!(result["updated"],2);
 let after=editor.state()["document"].clone();assert_eq!(after["history"].as_array().unwrap().len(),before["history"].as_array().unwrap().len()+1);assert_eq!(after["revision"].as_u64(),before["revision"].as_u64().map(|n|n+1));
 for id in [&a,&b]{assert_eq!(after["layers"].as_array().unwrap().iter().find(|layer|layer["id"]==*id).unwrap()["text"],before["layers"].as_array().unwrap().iter().find(|layer|layer["id"]==*id).unwrap()["text"]);}
 editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);editor.redo().unwrap();
 editor.execute("layer.setProps",json!({"layer":a,"locked":true})).unwrap();let locked=editor.state()["document"].clone();let locked_hash=editor.content_hash().unwrap();assert_eq!(editor.commands().as_array().unwrap().iter().find(|command|command["id"]=="type.updateAllTextLayers").unwrap()["enabled"],false);assert!(editor.execute("type.updateAllTextLayers",Value::Null).is_err());assert_eq!(editor.state()["document"],locked);assert_eq!(editor.content_hash().unwrap(),locked_hash);
 editor.begin_text(json!({"layer":b})).unwrap();assert!(editor.execute("type.updateAllTextLayers",Value::Null).is_err());editor.cancel_text();assert_eq!(editor.content_hash().unwrap(),locked_hash);
}

#[test]
fn text_defaults_are_session_only_preserve_content_and_feed_new_drafts() {
 let mut editor=Editor::new();editor.execute("file.new",json!({"width":64,"height":48})).unwrap();
 assert!(editor.execute("type.loadDefaultTypeStyles",Value::Null).is_err());assert!(editor.execute("type.saveDefaultTypeStyles",Value::Null).is_err());
 let a=editor.execute("type.create",json!({"x":2,"y":4,"text":"Source","font":"Inter","size":18,"fauxBold":true,"align":"center","color":"#ff0000"})).unwrap()["layer"].clone();
 let before=editor.state()["document"].clone();let hash=editor.content_hash().unwrap();
 for params in [json!([]),json!({"layer":a}),json!({"bad":true})]{assert!(editor.execute("type.saveDefaultTypeStyles",params).is_err());assert_eq!(editor.state()["document"],before);}
 editor.execute("type.saveDefaultTypeStyles",Value::Null).unwrap();assert_eq!(editor.state()["document"],before);assert_eq!(editor.content_hash().unwrap(),hash);
 let info=editor.begin_text(json!({"x":3,"y":5,"forceNew":true})).unwrap();assert_eq!(info["character"]["font_family"],"Inter");assert_eq!(info["character"]["size_pt"],json!(18.0));assert_eq!(info["paragraph"]["align"],"Center");
 let preview=editor.preview_text(json!({"text":"New text","color":"#00ff00"})).unwrap();assert_eq!(preview["character"]["size_pt"],json!(18.0));assert_eq!(preview["character"]["font_family"],"Inter");assert_eq!(editor.content_hash().unwrap(),hash);editor.cancel_text();assert_eq!(editor.state()["document"],before);
 let b=editor.execute("type.create",json!({"x":3,"y":7,"text":"Target","font":"Noto Sans SC","size":10})).unwrap()["layer"].clone();let prior=editor.state()["document"].clone();let prior_hash=editor.content_hash().unwrap();
 for params in [json!({"layer":1.5}),json!({"layer":b,"size":55})]{assert!(editor.execute("type.loadDefaultTypeStyles",params).is_err());assert_eq!(editor.state()["document"],prior);}
 editor.execute("type.loadDefaultTypeStyles",json!({"layer":b})).unwrap();let after=editor.state()["document"].clone();assert_eq!(after["history"].as_array().unwrap().len(),prior["history"].as_array().unwrap().len()+1);assert_ne!(editor.content_hash().unwrap(),prior_hash);editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),prior_hash);editor.redo().unwrap();
 editor.execute("layer.setProps",json!({"layer":b,"locked":true})).unwrap();let locked=editor.state()["document"].clone();assert!(editor.execute("type.loadDefaultTypeStyles",json!({"layer":b})).is_err());assert_eq!(editor.state()["document"],locked);
 // A different Editor starts without defaults; none are added to project content.
 let mut other=Editor::new();other.execute("file.new",json!({"width":64,"height":48})).unwrap();let clean=other.begin_text(json!({"x":1,"y":2})).unwrap();assert!(clean["character"].is_null());
}

#[test]
fn missing_font_query_and_replacements_are_read_only_or_atomic_and_strict() {
 let mut editor=Editor::new();editor.execute("file.new",json!({"width":64,"height":48})).unwrap();assert!(editor.missing_fonts().unwrap().is_empty());
 let a=editor.execute("type.create",json!({"x":1,"y":2,"text":"Missing A","font":"Missing Family A","size":8})).unwrap()["layer"].clone();
 editor.execute("type.create",json!({"x":2,"y":3,"text":"Missing B","font":"Missing Family B","size":8})).unwrap();
 let hash=editor.content_hash().unwrap();let before=editor.state()["document"].clone();assert_eq!(editor.missing_fonts().unwrap(),vec!["Missing Family A","Missing Family B"]);assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.state()["document"],before);
 for params in [Value::Null,json!({}),json!({"map":{"Unknown":"Inter"}}),json!({"map":{"Missing Family A":"Not Installed"}}),json!({"map":{"Missing Family A":"Inter"},"extra":true})]{assert!(editor.execute("type.resolveMissingFonts",params).is_err());assert_eq!(editor.content_hash().unwrap(),hash);assert_eq!(editor.state()["document"],before);}
 editor.execute("type.resolveMissingFonts",json!({"map":{}})).unwrap();assert_eq!(editor.state()["document"],before);
 let result=editor.execute("type.resolveMissingFonts",json!({"map":{"Missing Family A":"Inter"}})).unwrap();assert_eq!(result["replaced"],1);assert_eq!(editor.missing_fonts().unwrap(),vec!["Missing Family B"]);assert_eq!(editor.state()["document"]["history"].as_array().unwrap().len(),before["history"].as_array().unwrap().len()+1);editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
 editor.execute("layer.setProps",json!({"layer":a,"locked":true})).unwrap();let locked=editor.state()["document"].clone();assert!(editor.execute("type.replaceAllMissingFonts",Value::Null).is_err());assert_eq!(editor.state()["document"],locked);
 editor.execute("layer.setProps",json!({"layer":a,"locked":false})).unwrap();let replace_hash=editor.content_hash().unwrap();let history=editor.state()["document"]["history"].as_array().unwrap().len();assert_eq!(editor.execute("type.replaceAllMissingFonts",Value::Null).unwrap()["replaced"],2);assert!(editor.missing_fonts().unwrap().is_empty());assert_eq!(editor.state()["document"]["history"].as_array().unwrap().len(),history+1);editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),replace_hash);assert_eq!(editor.missing_fonts().unwrap().len(),2);
}

#[test]
fn move_hover_uses_native_target_bounds_without_selection_revision_or_content_changes() {
 use photocraft_doc::{ColorMode,Document,Layer,SampleType,Size};
 let mut doc=Document::new("Hover",Size::new(16,16),ColorMode::Rgb,SampleType::U8);let mut a=Layer::raster("A",doc.pixel_format());a.surface_mut().unwrap().fill_rect(photocraft_geom::Rect::new(1,1,3,3),&[1.,0.,0.,1.]);let a_id=a.id;
 let mut b=Layer::raster("B",doc.pixel_format());b.surface_mut().unwrap().fill_rect(photocraft_geom::Rect::new(8,8,10,10),&[0.,1.,0.,1.]);let b_id=b.id;let group=Layer::group("Group",vec![b]);let group_id=group.id;doc.layers=vec![a,group];
 let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();let mut editor=Editor::new();editor.open_project(&bytes,None).unwrap();editor.execute("layer.select",json!({"layer":a_id.0})).unwrap();let before=editor.state();let hash=editor.content_hash().unwrap();
 assert_eq!(editor.move_hover_at(json!({"x":9,"y":9,"target":"layer"})).unwrap(),json!({"layer":b_id.0,"frame":[8,8,10,10]}));assert_eq!(editor.move_hover_at(json!({"x":9,"y":9,"target":"group"})).unwrap(),json!({"layer":group_id.0,"frame":[8,8,10,10]}));assert!(editor.move_hover_at(json!({"x":15,"y":15})).unwrap().is_null());
 for params in [json!({"x":9,"y":9,"select":true}),json!({"x":"9","y":9}),json!({"x":9,"y":9,"target":"unknown"})]{assert!(editor.move_hover_at(params).is_err());}
 assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
 editor.execute("layer.setProps",json!({"layer":group_id.0,"visible":false})).unwrap();let hidden=editor.state();assert!(editor.move_hover_at(json!({"x":9,"y":9})).unwrap().is_null());assert_eq!(editor.state(),hidden);
}

#[test]
fn rasterize_public_commands_are_strict_draft_gated_and_restore_type_on_undo() {
 let mut editor=Editor::new();editor.execute("file.new",json!({"width":32,"height":24})).unwrap();let text=editor.execute("type.create",json!({"x":2,"y":12,"text":"Text","font":"Inter","size":8})).unwrap()["layer"].clone();let hash=editor.content_hash().unwrap();
 for id in ["layer.rasterize.type","layer.rasterize.allLayers","type.rasterizeTypeLayer"] {
  let before=editor.state()["document"].clone();
  let command=editor.commands().as_array().unwrap().iter().find(|command|command["id"]==id).unwrap().clone();assert_eq!(command["allowed"],true);assert_eq!(command["enabled"],true);
  assert!(editor.execute(id,json!({"coalesce":"unsafe"})).is_err());assert_eq!(editor.state()["document"],before);assert_eq!(editor.content_hash().unwrap(),hash);
  editor.begin_text(json!({"layer":text})).unwrap();assert!(editor.execute(id,Value::Null).is_err());editor.cancel_text();assert_eq!(editor.content_hash().unwrap(),hash);
  assert_eq!(editor.execute(id,Value::Null).unwrap()["rasterized"],1);let after=editor.state()["document"].clone();assert_eq!(after["revision"].as_u64(),before["revision"].as_u64().map(|n|n+1));assert_eq!(after["history"].as_array().unwrap().len(),before["history"].as_array().unwrap().len()+1);assert_ne!(editor.content_hash().unwrap(),hash);
  editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
 }
}

#[test]
fn clear_paint_mode_is_native_candidate_cancelable_and_one_history_for_brush_and_pencil() {
    for command in ["paint.stroke","paint.pencil"] {
        let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":12,"background":"transparent"})).unwrap();
        editor.execute("edit.fillForeground",json!({"color":"#ff0000"})).unwrap();
        let before=editor.state();let hash=editor.content_hash().unwrap();
        let params=json!({"strokeCommand":command,"mode":"Clear","size":4,"hardness":1.0,"points":[[4,4],[10,4]]});
        editor.begin_stroke(params.clone()).unwrap();assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);editor.cancel_stroke();assert_eq!(editor.state(),before);
        editor.begin_stroke(params).unwrap();editor.commit_stroke().unwrap();
        let document=photocraft_format::load_from_bytes(&editor.save_project().unwrap()).unwrap();let layer=document.layer(document.top_layer().unwrap()).unwrap();assert_eq!(layer.surface().unwrap().rgba(7,4)[3],0.);
        assert_ne!(editor.content_hash().unwrap(),hash);assert_eq!(editor.state()["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
        editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
    }
}

#[test]
fn history_delete_state_is_strict_atomic_drops_future_and_keeps_snapshots(){
 let mut e=Editor::new();e.execute("file.new",json!({"width":12,"height":8})).unwrap();let opened=e.content_hash().unwrap();
 e.execute("layer.new.layer",json!({"name":"A"})).unwrap();let a=e.content_hash().unwrap();e.execute("history.newSnapshot",json!({"name":"保留"})).unwrap();e.execute("layer.new.layer",json!({"name":"B"})).unwrap();e.execute("layer.new.layer",json!({"name":"C"})).unwrap();
 let before=e.state();for p in [json!({"state":0}),json!({"state":-1}),json!({"state":0.5}),json!({"state":"1"}),json!({"state":4}),json!({"state":null}),json!({"state":1,"extra":true})]{assert!(e.execute("history.deleteState",p).is_err());assert_eq!(e.state(),before);}
 e.execute("history.deleteState",json!({"state":2})).unwrap();assert_eq!(e.content_hash().unwrap(),a);let state=e.state();assert_eq!(state["document"]["history"].as_array().unwrap().len(),2);assert_eq!(state["document"]["redoHistory"],json!([]));assert_eq!(state["document"]["historySnapshots"],before["document"]["historySnapshots"]);
 assert!(e.redo().is_err());e.execute("history.deleteState",Value::Null).unwrap();assert_eq!(e.content_hash().unwrap(),opened);let base=e.state();assert!(e.execute("history.deleteState",Value::Null).is_err());assert_eq!(e.state(),base);
}

#[test]
fn history_follow_key_changes_at_cap_but_not_for_view_only_or_snapshot_names(){
 let mut e=Editor::new();e.execute("file.new",json!({"width":12,"height":8})).unwrap();e.set_history_limit(1).unwrap();e.execute("layer.new.layer",json!({})).unwrap();
 let key=e.state()["document"]["historyFollowKey"].clone();let hash=e.content_hash().unwrap();
 let snap=e.execute("history.newSnapshot",json!({"name":"Saved"})).unwrap()["snapshot"].clone();e.execute("history.renameSnapshot",json!({"snapshot":snap,"name":"Renamed"})).unwrap();e.execute("select.deselectLayers",json!({})).unwrap();assert_eq!(e.state()["document"]["historyFollowKey"],key);assert_eq!(e.content_hash().unwrap(),hash);
 e.execute("layer.new.layer",json!({})).unwrap();let first=e.state()["document"]["historyFollowKey"].clone();e.execute("layer.new.layer",json!({})).unwrap();let second=e.state()["document"]["historyFollowKey"].clone();assert_ne!(first,second);assert_eq!(e.state()["document"]["history"].as_array().unwrap().len(),2);
 e.undo().unwrap();assert_ne!(e.state()["document"]["historyFollowKey"],second);let stable=e.state();assert_eq!(e.state(),stable);
}

#[test]
fn properties_frame_and_whole_layer_transform_ignore_pixel_selection_atomically(){
 let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":16,"background":"transparent"})).unwrap();
 editor.execute("layer.new.layer",Value::Null).unwrap();editor.execute("edit.fillForeground",json!({"color":"#ff0000"})).unwrap();
 editor.execute("select.rect",json!({"x":4,"y":4,"width":4,"height":4})).unwrap();
 let before=editor.state();let hash=editor.content_hash().unwrap();
 assert_eq!(before["document"]["transformFrame"],json!([4,4,8,8]));assert_eq!(before["document"]["layerTransformFrame"],json!([0,0,16,16]));
 assert!(editor.begin_move(json!({"x":0,"y":0,"autoSelect":false,"duplicate":false,"wholeLayer":true})).unwrap());
 editor.preview_transform(json!([2,0,0,2,0,0])).unwrap();assert_eq!(editor.state(),before);editor.cancel_transform();assert_eq!(editor.state(),before);
 editor.begin_move(json!({"x":0,"y":0,"autoSelect":false,"duplicate":false,"wholeLayer":true})).unwrap();editor.preview_transform(json!([2,0,0,2,0,0])).unwrap();editor.commit_transform().unwrap();
 let after=editor.state();assert_eq!(after["document"]["layerTransformFrame"],json!([0,0,32,32]));assert_eq!(after["document"]["selectionFrame"],before["document"]["selectionFrame"]);
 assert_eq!(after["document"]["history"].as_array().unwrap().len(),before["document"]["history"].as_array().unwrap().len()+1);
 editor.undo().unwrap();assert_eq!(editor.content_hash().unwrap(),hash);
}


#[test]
fn move_marquee_selects_intersecting_layers_groups_and_adds_without_content_or_history_changes() {
 use photocraft_doc::*;
 let mut doc=Document::new("Marquee",Size::new(64,64),ColorMode::Rgb,SampleType::U8);
 let mut a=Layer::raster("A",doc.pixel_format());let a_id=a.id;a.surface_mut().unwrap().write_pixel(8,8,&[1.,0.,0.,1.]);
 let mut b=Layer::raster("B",doc.pixel_format());let b_id=b.id;b.surface_mut().unwrap().write_pixel(40,8,&[1.,0.,0.,1.]);
 let mut locked=Layer::raster("Locked",doc.pixel_format());locked.locks.all=true;locked.surface_mut().unwrap().write_pixel(8,8,&[1.,0.,0.,1.]);
 doc.layers=vec![a,b,locked];let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();
 let mut e=Editor::new();e.open_project(&bytes,None).unwrap();let hash=e.content_hash().unwrap();let before=e.state()["document"].clone();
 let result=e.execute("layer.selectInRect",json!({"x":-10,"y":-10,"width":20,"height":20})).unwrap();assert_eq!(result["layers"],json!([a_id.0]));
 e.execute("layer.selectInRect",json!({"x":70,"y":30,"width":-31,"height":-23,"mode":"add"})).unwrap();assert_eq!(e.state()["document"]["selectedLayers"],json!([a_id.0,b_id.0]));
 let selected=e.state()["document"]["selectedLayers"].clone();e.execute("layer.selectInRect",json!({"x":-30,"y":-30,"width":1,"height":1})).unwrap();assert_eq!(e.state()["document"]["selectedLayers"],selected);
 assert_eq!(e.content_hash().unwrap(),hash);for key in ["history","redoHistory","dirty"]{assert_eq!(e.state()["document"][key],before[key]);}
 let stable=e.state();for bad in [json!({"x":0,"y":0,"width":1,"height":1,"target":"all"}),json!({"x":0,"y":0,"width":1,"height":1,"layer":a_id.0}),json!({"x":0,"y":0,"width":1,"height":1,"mode":"toggle"}),json!({"x":1e30,"y":0,"width":1,"height":1})]{assert!(e.execute("layer.selectInRect",bad).is_err());assert_eq!(e.state(),stable);}
 let group=e.execute("layer.groupLayers",Value::Null).unwrap()["layer"].clone();let hash=e.content_hash().unwrap();let count=e.state()["document"]["history"].clone();
 e.execute("layer.selectInRect",json!({"x":-10,"y":-10,"width":20,"height":20,"target":"group"})).unwrap();assert_eq!(e.state()["document"]["selectedLayers"],json!([group]));assert_eq!(e.content_hash().unwrap(),hash);assert_eq!(e.state()["document"]["history"],count);
 e.execute("select.deselectLayers",json!({})).unwrap();assert_eq!(e.state()["document"]["selectedLayers"],json!([]));assert_eq!(e.content_hash().unwrap(),hash);
}
