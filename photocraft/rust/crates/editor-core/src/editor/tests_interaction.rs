use super::*;
use photocraft_geom::Rect;

#[test]
fn region_preview_rejection_preserves_the_document_and_uses_the_same_draft() {
    let mut editor=Editor::new();
    assert_eq!(editor.render_region(json!({"x":0,"y":0,"width":1,"height":1})),Err(EditorError::NoDocument));
    editor.execute("file.new",json!({"width":8000,"height":6000})).unwrap();
    editor.execute("layer.new.layer",json!({})).unwrap();
    let id=editor.active_layer_id().unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    editor.begin_layer_properties(id.0).unwrap();
    editor.preview_layer_properties(json!({"opacity":0.4})).unwrap();
    // 只检查快照来源与参数拒绝，不运行合成器或读取有效像素。
    assert_eq!(editor.preview_document().unwrap().layer(id).unwrap().opacity,0.4);
    assert_eq!(editor.active_doc().unwrap().doc.layer(id).unwrap().opacity,1.0);
    for params in [json!({"x":8000,"y":0,"width":1,"height":1}),json!({"x":0,"y":0,"width":8000,"height":6000}),json!({"x":-1,"y":0,"width":1,"height":1})] {
        assert!(matches!(editor.render_region(params),Err(EditorError::RenderFailed(_))));
        assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    }
    editor.cancel_layer_properties();
    assert_eq!(editor.preview_document().unwrap().layer(id).unwrap().opacity,1.0);
    editor.close();
    assert_eq!(editor.render_region(json!({"x":0,"y":0,"width":1,"height":1})),Err(EditorError::NoDocument));
}

#[test]
fn frame_projection_uses_the_selection_not_only_occupied_content() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":100,"height":80})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"几何样本"})).unwrap();
    let state = editor.session.active_mut().unwrap();
    let id = state.active_layer.unwrap();
    // 直接构造稀疏数据样本；不运行笔刷、合成器或图像输出。
    std::sync::Arc::make_mut(&mut state.doc).layer_mut(id).unwrap().surface_mut().unwrap()
        .fill_rect(Rect::new(10, 10, 30, 20), &[1.0, 0.0, 0.0, 1.0]);
    assert_eq!(editor.state()["document"]["transformFrame"], json!([10,10,30,20]));
    editor.execute("select.rect", json!({"x":5,"y":5,"width":15,"height":40})).unwrap();
    assert_eq!(editor.state()["document"]["transformFrame"], json!([5,5,20,45]));
    editor.execute("select.rect", json!({"x":60,"y":60,"width":10,"height":10})).unwrap();
    assert!(editor.state()["document"]["transformFrame"].is_null());
    editor.execute("select.deselect", Value::Null).unwrap();
    editor.execute("layer.new.layer", json!({})).unwrap();
    assert!(editor.state()["document"]["transformFrame"].is_null());
}
