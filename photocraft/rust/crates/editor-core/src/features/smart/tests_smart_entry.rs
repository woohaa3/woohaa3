use super::*;
use photocraft_doc::{Affine, ColorMode, Document, Layer, LayerContent, SampleType, Size, SmartObject, SmartSource};
use std::sync::Arc;
#[test]
fn smart_transparent_source_can_begin_transform_and_move_without_cached_pixels() {
    let mut child=Document::new("源",Size::new(16,12),ColorMode::Rgb,SampleType::U8);
    child.layers=vec![Layer::raster("空",child.pixel_format())];
    let source=SmartSource::Embedded{file_name:"source.pcraft".into(),bytes:Arc::new(photocraft_format::save_to_bytes(&child,&Default::default()).unwrap())};
    let mut doc=Document::new("父",Size::new(40,30),ColorMode::Rgb,SampleType::U8);
    let layer=Layer::new("对象",LayerContent::Smart(SmartObject::new(source,Affine::IDENTITY,None)));
    let id=layer.id;doc.layers=vec![layer];
    let mut editor=Editor::new();editor.session.add_document(doc,None);
    editor.session.active_mut().unwrap().active_layer=Some(id);
    editor.session.active_mut().unwrap().selected_layers=vec![id];
    let base=editor.session.active().unwrap().clone();
    assert_eq!(crate::layer_preview::transform_frame(&base),photocraft_doc::Rect::new(0,0,16,12));
    assert!(editor.session.disabled_reason("edit.transform").is_none());
    editor.begin_transform().unwrap();
    editor.preview_transform(json!([1,0,0,1,0,0])).unwrap();
    editor.commit_transform().unwrap();
    assert!(Arc::ptr_eq(&editor.session.active().unwrap().doc,&base.doc));
    assert!(editor.begin_move(json!({"x":3,"y":4,"autoSelect":false})).unwrap());
    editor.cancel_transform();
    assert!(Arc::ptr_eq(&editor.session.active().unwrap().doc,&base.doc));
    assert_eq!(editor.session.active().unwrap().history.past_len(),base.history.past_len());
}
