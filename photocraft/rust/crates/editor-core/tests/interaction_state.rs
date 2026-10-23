//! 只检查状态与能力门，不合成、导出或采集绘制结果。
use photocraft_embed_editor::Editor;
use serde_json::{json, Value};

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
    // U41（change: 2026-10-22-add-photocraft-adjustment-workflows）放开分通道曲线与黑灰白场吸管，
    // 因此这两项从「必须拒绝」改为下方单独校验；其余结构/类型/几何错误仍然拒绝。
    for bad in [json!({}),json!({"layer":layer}),
        json!({"points":[[0,0],[0,10]]}),
        json!({"points":[[0,0],[256,255]]}),json!({"points":[[0,"x"],[255,255]]}),json!({"points":[[0,0]]}),
        json!({"red":[[0,0],[0,10]]}),json!({"eyedropper":{"point":"guess","at":[1,1]}})] {
        assert!(editor.preview_adjustment(bad).is_err());
        assert!(editor.commit_adjustment().is_err());assert_eq!(editor.state(),before);
    }
    // 分通道曲线与吸管现在是合法参数：接受且仍只改草稿。
    editor.preview_adjustment(json!({"red":[[0,0],[255,255]]})).unwrap();
    editor.preview_adjustment(json!({"eyedropper":{"point":"white","at":[1,1]}})).unwrap();
    assert_eq!(editor.state(),before);
    assert!(editor.preview_adjustment(json!({"points":[[0,0],[0,10]]})).is_err());
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
    assert!(editor.preview_text(json!({"text":"x","orientation":"vertical"})).is_err());
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
