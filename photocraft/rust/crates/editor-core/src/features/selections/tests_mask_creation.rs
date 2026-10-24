use super::*;
#[test]
fn selection_masks_preserve_coverage_and_roundtrip_without_compositing() {
    for (operation,inside,outside) in [("revealAll",1.0,1.0),("hideAll",0.0,0.0),("revealSelection",1.0,0.0),("hideSelection",0.0,1.0)] {
        let mut editor=Editor::new();
        editor.execute("file.new",json!({"width":20,"height":16})).unwrap();
        editor.execute("layer.new.layer",Value::Null).unwrap();
        editor.execute("select.rect",json!({"x":3,"y":4,"width":5,"height":6})).unwrap();
        editor.execute(&format!("layer.layerMask.{operation}"),Value::Null).unwrap();
        let state=editor.session.active().unwrap();
        let layer=state.active_layer.unwrap();
        let mask=state.doc.layer(layer).unwrap().mask.as_ref().unwrap();
        // 掩码覆盖率是领域状态，不采集合成图或像素变换结果。
        assert_eq!(mask.surface.sample_channel(4,5,0),inside);
        assert_eq!(mask.surface.sample_channel(0,0,0),outside);
        let bytes=photocraft_format::save_to_bytes(&state.doc,&Default::default()).unwrap();
        let mut reopened=Editor::new();
        reopened.open_project(&bytes,None).unwrap();
        assert_eq!(reopened.content_hash().unwrap(),editor.content_hash().unwrap());
        let state=reopened.session.active().unwrap();
        let mask=state.doc.layers.iter().find_map(|layer|layer.mask.as_ref()).unwrap();
        assert_eq!(mask.surface.sample_channel(4,5,0),inside);
        assert_eq!(mask.surface.sample_channel(0,0,0),outside);
    }
}

/// 新建蒙版不能把视图切到蒙版通道（A7）。
///
/// 曾经「加图层蒙版」会顺手 `channel.target.layerMask`：画布随即改画灰度蒙版平面，
/// 「显示全部」的蒙版是纯白，于是整块画布变白，用户以为预览坏了（2026-10-24 审片 A7，
/// preflight #5）。合成通道必须保持不变；要看蒙版仍有显式的通道切换与 Alt 点缩略图。
#[test]
fn creating_a_pixel_mask_keeps_the_composite_channel() {
    for operation in ["revealAll","hideAll"] {
        let mut editor = Editor::new();
        editor.execute("file.new",json!({"width":20,"height":16})).unwrap();
        editor.execute("layer.new.layer",Value::Null).unwrap();
        editor.execute(&format!("layer.layerMask.{operation}"),Value::Null).unwrap();
        let snapshot = editor.channel_snapshot().unwrap();
        assert_eq!(snapshot["target"], json!({ "kind": "composite" }),
            "加蒙版后视图仍应在合成通道（{operation}）");
    }
    // 选区蒙版同样不能切通道。
    let mut editor = Editor::new();
    editor.execute("file.new",json!({"width":20,"height":16})).unwrap();
    editor.execute("layer.new.layer",Value::Null).unwrap();
    editor.execute("select.rect",json!({"x":3,"y":4,"width":5,"height":6})).unwrap();
    editor.execute("layer.layerMask.revealSelection",Value::Null).unwrap();
    assert_eq!(editor.channel_snapshot().unwrap()["target"], json!({ "kind": "composite" }));
}
