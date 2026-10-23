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
