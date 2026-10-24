//! Horizontal/vertical formatting shares the same selected-target transaction as anti-aliasing.
use photocraft_engine::Session;
use serde_json::Value;
use crate::{EditorError,Result};
pub const IDS:&[&str]=&["type.orientation.horizontal","type.orientation.vertical"];
pub fn disabled_reason(s:&Session,id:&str)->Option<String>{if IDS.contains(&id){crate::text_antialias::target_reason(s,id)}else{None}}
pub fn execute(s:&mut Session,id:&str,p:Value)->Result<Value>{if !IDS.contains(&id){return Err(EditorError::CapabilityDisabled(id.into()));}crate::text_antialias::execute_format(s,id,p)}
#[cfg(test)] mod tests{
 use super::*;use serde_json::json;
 #[test] fn selected_text_orientations_are_atomic_undoable_and_archivable(){
  let mut s=Session::new();s.execute("file.new",json!({"width":64,"height":64})).unwrap();let mut ids=Vec::new();for text in ["Ab","Cd"]{ids.push(photocraft_doc::LayerId(s.execute("type.create",json!({"text":text,"font":"Inter","size":10,"x":10,"y":10})).unwrap()["layer"].as_u64().unwrap()));}s.active_mut().unwrap().selected_layers=ids;
  let before=s.active().unwrap().clone();execute(&mut s,IDS[1],Value::Null).unwrap();let after=s.active().unwrap();for id in after.selected_layers(){let photocraft_doc::LayerContent::Text(text)=&after.doc.layer(id).unwrap().content else{panic!()};assert_eq!(text.orientation,photocraft_doc::text::Orientation::Vertical);}
  assert_eq!(after.history.past_len(),before.history.past_len()+1);let bytes=photocraft_format::save_to_bytes(&after.doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);s.execute("edit.redo",Value::Null).unwrap();execute(&mut s,IDS[0],Value::Null).unwrap();
  s.execute("layer.lockLayers",json!({"pixels":true})).unwrap();let before=s.active().unwrap().clone();assert!(disabled_reason(&s,IDS[1]).is_some());for p in [Value::Null,json!({"layer":1})]{assert!(execute(&mut s,IDS[1],p).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));}
 }
 #[test] fn oversized_text_format_and_draft_preserve_formal_document(){
  let mut s=Session::new();s.execute("file.new",json!({"width":64,"height":64})).unwrap();
  let layer=photocraft_doc::Layer::new("Oversized",photocraft_doc::LayerContent::Text(photocraft_doc::TextLayer{text:"W".repeat(50),font_family:"Inter".into(),size_pt:1024.,..Default::default()}));
  let id=layer.id;let state=s.active_mut().unwrap();std::sync::Arc::make_mut(&mut state.doc).layers.push(layer);state.active_layer=Some(id);state.selected_layers=vec![id];
  let before=s.active().unwrap().clone();
  let result=execute(&mut s,IDS[1],Value::Null);
  assert!(result.is_err());
  assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
  assert_eq!(before.history.past_len(),s.active().unwrap().history.past_len());
  let mut draft=crate::text_preview::TextPreview::new(&before,json!({"layer":before.active_layer.unwrap().0})).unwrap();
  assert!(draft.update(json!({"text":"W".repeat(50),"orientation":"vertical"})).is_err());
  assert!(draft.commit(&mut s).is_err());
  assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
 }

}
