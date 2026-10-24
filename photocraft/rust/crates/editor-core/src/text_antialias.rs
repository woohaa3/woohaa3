//! Seven existing native AA modes, restricted to the current selected Type layers.
use photocraft_doc::LayerContent;
use photocraft_engine::Session;
use serde_json::{Value,json};
use crate::{EditorError,Result};
pub const IDS:&[&str]=&["type.antiAlias.none","type.antiAlias.sharp","type.antiAlias.crisp","type.antiAlias.strong","type.antiAlias.smooth","type.antiAlias.windowsLcd","type.antiAlias.windows"];
fn fail(id:&str,message:impl ToString)->EditorError {EditorError::CommandFailed{id:id.into(),message:message.to_string()}}
fn targets(s:&Session,id:&str)->Result<Vec<u64>>{
 let base=s.active().ok_or(EditorError::NoDocument)?;
 let mut ids=Vec::new();let mut text_len=0usize;
 for target in base.selected_layers(){
  let layer=base.doc.layer(target).ok_or_else(||fail(id,"目标图层不存在"))?;let LayerContent::Text(text)=&layer.content else{continue};
  let locks=base.doc.effective_locks(target);if locks.all || locks.pixels{return Err(fail(id,"文字图层或父组已锁定"));}
  text_len+=text.text.encode_utf16().count();if text_len>100000{return Err(fail(id,"单次文字格式更新超过100000字符"));}ids.push(target.0);
 }
 if ids.is_empty(){return Err(fail(id,"请先选择文字图层"));}
 Ok(ids)
}
pub fn disabled_reason(s:&Session,id:&str)->Option<String>{if !IDS.contains(&id){return None;}targets(s,id).err().map(|e|e.to_string())}
pub fn execute(s:&mut Session,id:&str,p:Value)->Result<Value>{
 if !IDS.contains(&id){return Err(EditorError::CapabilityDisabled(id.into()));}
 execute_format(s,id,p)
}
pub(crate) fn target_reason(s:&Session,id:&str)->Option<String>{targets(s,id).err().map(|e|e.to_string())}
pub(crate) fn execute_format(s:&mut Session,id:&str,p:Value)->Result<Value>{
 if !p.is_null() && !p.as_object().is_some_and(|f|f.is_empty()){return Err(fail(id,"文字格式命令只操作当前选中文字层，不接受外部目标"));}
 if s.active_job().is_some(){return Err(fail(id,"文档后台任务尚未结束"));}
 let ids=targets(s,id)?;let base=s.active().unwrap();
 validate_bounds(&base.doc,&ids,id)?;
 // Layout-only candidate check runs before native commands allocate raster caches.
 if let Some(mode)=id.strip_prefix("type.orientation."){
  let mut candidate=(*base.doc).clone();
  for target in &ids{let LayerContent::Text(text)=&mut candidate.layer_mut(photocraft_doc::LayerId(*target)).unwrap().content else{unreachable!()};text.orientation=if mode=="vertical"{photocraft_doc::text::Orientation::Vertical}else{photocraft_doc::text::Orientation::Horizontal};}
  validate_bounds(&candidate,&ids,id)?;
 }
 let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=s.prefs().clone());scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 let result=scratch.execute(id,json!({"layers":&ids})).map_err(|error|fail(id,error))?;
 validate_bounds(&scratch.active().unwrap().doc,&ids,id)?;
 if scratch.active().unwrap().doc!=base.doc{*s.active_mut().unwrap()=scratch.active().unwrap().clone();}Ok(result)
}
/// Validate the candidate as well as the source: changing orientation can change wrapping.
pub(crate) fn validate_bounds(doc:&photocraft_doc::Document,ids:&[u64],id:&str)->Result<()>{
 let mut budget=0u64;
 for target in ids{
  let LayerContent::Text(text)=&doc.layer(photocraft_doc::LayerId(*target)).unwrap().content else{unreachable!()};
  if let Some([x0,y0,x1,y1])=photocraft_text::shared().lock().unwrap_or_else(|e|e.into_inner()).layout(text,doc.resolution_dpi).bounds(){
   let width=f64::from(x1-x0).abs()+4.;let height=f64::from(y1-y0).abs()+4.;
   if !width.is_finite() || !height.is_finite() || width>8192. || height>8192.{return Err(fail(id,"文字格式边界超过8192像素上限"));}
   budget=budget.saturating_add((width.ceil()*height.ceil()) as u64*16);
   if budget>256*1024*1024{return Err(fail(id,"文字格式候选超过256 MiB预算"));}
  }
 }
 Ok(())
}
#[cfg(test)] mod tests{
 use super::*;
 fn session()->Session{let mut s=Session::new();s.execute("file.new",json!({"width":64,"height":32,"background":"transparent"})).unwrap();let mut ids=Vec::new();for text in ["Aa","Bb"]{ids.push(s.execute("type.create",json!({"text":text,"x":1,"y":12,"size":10,"font":"Inter"})).unwrap()["layer"].as_u64().unwrap());}s.active_mut().unwrap().selected_layers=ids.into_iter().map(photocraft_doc::LayerId).collect();s}
 #[test] fn all_seven_modes_change_selected_layers_atomically_and_undo(){
  for id in IDS{let mut s=session();let before=s.active().unwrap().clone();execute(&mut s,id,Value::Null).unwrap();let after=s.active().unwrap();for target in after.selected_layers(){let LayerContent::Text(text)=&after.doc.layer(target).unwrap().content else{panic!()};assert_eq!(photocraft_engine::type_extra_cmds::aa_name(text.antialias),id.strip_prefix("type.antiAlias.").unwrap());}
   if after.doc!=before.doc{assert_eq!(after.history.past_len(),before.history.past_len()+1);s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);}
  }
 }
 #[test] fn locked_targets_and_external_parameters_do_not_publish_any_prefix(){
  let mut s=session();s.execute("layer.lockLayers",json!({"pixels":true})).unwrap();let before=s.active().unwrap().clone();assert!(disabled_reason(&s,IDS[0]).is_some());assert!(execute(&mut s,IDS[0],Value::Null).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
  let mut s=session();let before=s.active().unwrap().clone();for p in [json!({"layer":1}),json!({"range":[0,1]}),json!({"antialias":"any"}),json!(false)]{assert!(execute(&mut s,IDS[0],p).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));}
 }
}
