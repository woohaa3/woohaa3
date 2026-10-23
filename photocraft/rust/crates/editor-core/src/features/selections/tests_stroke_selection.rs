use super::*;

#[test]
fn stroke_damage_is_consumed_without_a_document_write_and_cancel_clears_it() {
    let mut editor=Editor::new();
    assert_eq!(editor.take_stroke_damage(),json!([]));
    editor.execute("file.new",json!({"width":100,"height":80})).unwrap();
    let before=editor.state();let hash=editor.content_hash().unwrap();
    // 只注入范围元数据，不调用绘画或合成器。
    editor.stroke_damage=photocraft_geom::Rect::new(10,20,30,40);
    assert_eq!(editor.take_stroke_damage(),json!([{"x":10,"y":20,"width":20,"height":20}]));
    assert_eq!(editor.take_stroke_damage(),json!([]));
    assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
    editor.stroke_damage=photocraft_geom::Rect::new(10,20,30,40);
    editor.cancel_stroke();assert_eq!(editor.take_stroke_damage(),json!([]));
    editor.close();assert_eq!(editor.take_stroke_damage(),json!([]));
}
use photocraft_geom::Rect;

#[test]
fn temporary_stroke_mask_is_clipped_without_changing_the_document() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
    let original = editor.state();
    let mask = Editor::stroke_selection(&editor.active_doc().unwrap().doc);
    assert_eq!(mask.content_bounds(), Rect::new(0, 0, 40, 30));
    assert_eq!(editor.state(), original);
    let state = editor.session.active_mut().unwrap();
    let doc = std::sync::Arc::make_mut(&mut state.doc);
    let mut selection = photocraft_doc::LayerMask::hide_all().surface;
    selection.fill_rect(Rect::new(-5, 5, 15, 20), &[0.5]);
    doc.selection = Some(selection);
    let clipped = Editor::stroke_selection(doc);
    assert_eq!(clipped.content_bounds(), Rect::new(0, 5, 15, 20));
    assert_eq!(clipped.read_region(Rect::new(0, 5, 1, 6)), doc.selection.as_ref().unwrap().read_region(Rect::new(0, 5, 1, 6)));
    assert_eq!(doc.selection.as_ref().unwrap().content_bounds(), Rect::new(-5, 5, 15, 20));
}

#[test]
fn failed_live_stroke_restores_the_original_selection_and_revision() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    assert!(editor.begin_stroke(json!({"points":[]})).is_err());
    assert_eq!(editor.state(), before);
    assert_eq!(editor.content_hash().unwrap(), hash);
}
