//! Painting aids belong to the document session, never its content or undo stack.
use crate::error::{EditorError,Result};
use photocraft_engine::{Session,DocState,symmetry_cmds::PaintingSymmetry};
use serde_json::{Value,json};
pub const IDS:&[&str]=&["paint.setSymmetry","paint.symmetryFromPath","paint.symmetryDisable"];
pub fn execute(session:&mut Session,id:&str,params:Value)->Result<()> {
 let fail=|message:String|EditorError::CommandFailed{id:id.into(),message};
 let fields=params.as_object().ok_or_else(||fail("绘画对称参数必须为对象".into()))?;
 let keys:&[&str]=match id {"paint.setSymmetry"=>&["mode","center","rotation"],"paint.symmetryFromPath"=>&["name"],_=>&[]};
 if fields.keys().any(|key|!keys.contains(&key.as_str())) || id=="paint.symmetryFromPath" && fields.get("name").is_none_or(|v|v.as_str().is_none_or(|name|name.is_empty() || name.len()>1024)) {return Err(fail("绘画对称参数无效".into()));}
 let base=session.active().ok_or(EditorError::NoDocument)?;
 let mut scratch=Session::new();scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 scratch.execute(id,params).map_err(|e|fail(e.to_string()))?;
 session.active_mut().unwrap().symmetry=scratch.active().unwrap().symmetry.clone();
 Ok(())
}
pub fn inspect(state:&DocState)->Value {
 let mut value=state.symmetry.as_ref().map(PaintingSymmetry::inspect).unwrap_or(Value::Null);
 if let Some(symmetry)=&state.symmetry {
  let segments=match symmetry {PaintingSymmetry::Preset(p)=>p.segments([state.doc.size.width as f64,state.doc.size.height as f64]),PaintingSymmetry::Path(p)=>p.segments.clone()};
  value["segments"]=json!(segments);
 }
 value
}
pub fn paths(state:&DocState)->Vec<String> {
 let mut paths=Vec::new();if state.doc.work_path.is_some(){paths.push("work".into());}
 if state.active_layer.and_then(|id|state.doc.layer(id)).is_some_and(|layer|matches!(layer.content,photocraft_doc::LayerContent::Shape(_)) || layer.vector_mask.is_some()){paths.push("layer".into());}
 paths.extend(state.doc.paths.iter().map(|path|path.name.clone()));paths
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn tool_state_is_strict_atomic_and_never_content_or_history() {
  let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":12})).unwrap();
  let base=s.active().unwrap().clone();
  for mode in ["vertical","horizontal","dual","diagonal"] {
   execute(&mut s,"paint.setSymmetry",json!({"mode":mode,"center":[8,6],"rotation":15})).unwrap();
   let after=s.active().unwrap();assert_eq!(after.doc,base.doc);assert_eq!(after.revision,base.revision);assert_eq!(after.history.past_len(),base.history.past_len());assert_eq!(inspect(after)["mode"],mode);
  }
  let before=s.active().unwrap().symmetry.clone();
  for (id,p) in [("paint.setSymmetry",json!({"mode":"bad"})),("paint.setSymmetry",json!({"mode":"vertical","center":[1]})),("paint.setSymmetry",json!({"mode":"vertical","extra":true})),("paint.symmetryFromPath",json!({"name":"missing"})),("paint.symmetryFromPath",json!({"name":2}))] {assert!(execute(&mut s,id,p).is_err());assert_eq!(s.active().unwrap().symmetry,before);assert_eq!(s.active().unwrap().doc,base.doc);}
  execute(&mut s,"paint.symmetryDisable",json!({})).unwrap();assert!(s.active().unwrap().symmetry.is_none());assert_eq!(s.active().unwrap().revision,base.revision);
 }
}
#[cfg(test)] mod path_tests {
 use super::*;
 #[test] fn path_axis_uses_existing_geometry_and_remains_session_only() {
  let mut s=Session::new();s.execute("file.new",json!({"width":12,"height":12})).unwrap();
  s.execute("path.set",json!({"name":"work","path":{"subpaths":[{"closed":false,"knots":[[6,0],[6,12]]}]}})).unwrap();
  let base=s.active().unwrap().clone();assert_eq!(paths(&base),vec!["work"]);
  execute(&mut s,"paint.symmetryFromPath",json!({"name":"work"})).unwrap();
  let state=s.active().unwrap();assert_eq!(inspect(state)["source"],"work");assert_eq!(inspect(state)["segments"].as_array().unwrap().len(),1);assert_eq!(state.doc,base.doc);assert_eq!(state.revision,base.revision);
 }
}
