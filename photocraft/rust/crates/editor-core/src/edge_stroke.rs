//! Edit Stroke writes raster edges; distinct from non-destructive layer effects.
use photocraft_doc::LayerContent;
use photocraft_engine::Session;
use serde_json::Value;
use crate::error::{EditorError,Result};
pub const ID:&str="edit.stroke";
fn fail(message:impl ToString)->EditorError {EditorError::CommandFailed{id:ID.into(),message:message.to_string()}}
fn target(s:&Session)->Result<()> {
 let st=s.active().ok_or(EditorError::NoDocument)?;let id=st.active_layer.ok_or_else(||fail("请先选择像素图层"))?;
 if crate::layer_preview::mask_target(st){return Err(fail("描边需要像素目标，请切换到图层内容"));}
 let layer=st.doc.layer(id).ok_or_else(||fail("目标图层不存在"))?;
 if !matches!(layer.content,LayerContent::Raster(_)){return Err(fail("请先选择像素图层"));}
 let locks=st.doc.effective_locks(id);if locks.all || locks.pixels{return Err(fail("描边目标已锁定"));}
 crate::layer_preview::require_visible(st,&[id],ID)?;Ok(())
}
pub fn disabled_reason(s:&Session,id:&str)->Option<String>{(id==ID).then(||target(s).err().map(|e|e.to_string())).flatten()}
pub fn execute(s:&mut Session,p:Value)->Result<Value> {
 let fields=p.as_object().filter(|p|p.keys().all(|k|matches!(k.as_str(),"width"|"color"|"location"|"mode"|"opacity"|"preserveTransparency"))).ok_or_else(||fail("描边包含未知参数或指定目标"))?;
 let width=fields.get("width").map_or(Some(1.),Value::as_f64).filter(|n|n.is_finite() && (1.0..=250.0).contains(n)).ok_or_else(||fail("描边宽度须为1–250像素"))?;
 if fields.get("location").is_some_and(|v|!v.as_str().is_some_and(|s|matches!(s,"inside"|"center"|"outside"))){return Err(fail("请选择内部、居中或外部描边"));}
 if fields.get("opacity").is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite() || !(0.0..=100.0).contains(&n))){return Err(fail("不透明度须为0–100%"));}
 if fields.get("mode").is_some_and(|v|v.as_str().and_then(photocraft_engine::commands::blend_from_str).is_none_or(|m|m==photocraft_doc::BlendMode::PassThrough)){return Err(fail("请选择有效描边混合模式"));}
 if fields.get("preserveTransparency").is_some_and(|v|!v.is_boolean()){return Err(fail("保留透明度须为布尔值"));}
 let _color=fields.get("color").and_then(Value::as_str).filter(|c|c.len()==7 && c.starts_with('#') && c[1..].bytes().all(|b|b.is_ascii_hexdigit())).ok_or_else(||fail("请提供当前描边颜色#rrggbb"))?;
 target(s)?;if s.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}let base=s.active().unwrap();
 // The native algorithm pads by width+1, expands/contracts two masks, then blends full-depth
 // pixels. Bound padded working area, not just the visible canvas (especially small documents).
 let pad=2*(width.ceil() as u64+1);let pixels=(u64::from(base.doc.size.width)+pad)*(u64::from(base.doc.size.height)+pad);
 if pixels*128>256*1024*1024{return Err(fail("描边工作像素超过256 MiB预算，请减小文档或描边宽度"));}
 let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=s.prefs().clone());scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 // Supplying an explicit RGB colour avoids hidden Session palette state.
 let result=scratch.execute(ID,p).map_err(fail)?;
 if scratch.active().unwrap().doc!=base.doc{*s.active_mut().unwrap()=scratch.active().unwrap().clone();}Ok(result)
}
#[cfg(test)] mod tests {
 use super::*;use serde_json::json;
 fn session()->Session {let mut s=Session::new();s.execute("file.new",json!({"width":12,"height":12,"background":"transparent"})).unwrap();s}
 #[test] fn selection_edges_have_real_pixels_and_one_undo_step(){
  for (location,inner,outer) in [("inside",true,false),("center",true,true),("outside",false,true)] {
   let mut s=session();s.execute("select.rect",json!({"x":3,"y":3,"width":6,"height":6})).unwrap();let before=s.active().unwrap().clone();execute(&mut s,json!({"width":2,"color":"#ff0000","location":location,"opacity":50})).unwrap();let state=s.active().unwrap();let surf=state.doc.layers[0].surface().unwrap();
   assert_eq!(surf.rgba(5,5)[3],0.);assert_eq!(surf.rgba(3,5)[3]>0.,inner);assert_eq!(surf.rgba(2,5)[3]>0.,outer);assert_eq!(state.history.past_len(),before.history.past_len()+1);s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);
  }
 }
 #[test] fn no_selection_uses_alpha_edges_and_preserve_transparency(){
  let mut s=session();s.execute("select.rect",json!({"x":3,"y":3,"width":6,"height":6})).unwrap();crate::general_fill::execute(&mut s,json!({"contents":"white"}),&[]).unwrap();s.execute("select.deselect",Value::Null).unwrap();let before=s.active().unwrap().clone();execute(&mut s,json!({"width":2,"color":"#ff0000","location":"outside"})).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].surface().unwrap().rgba(2,5),[1.,0.,0.,1.]);s.execute("edit.undo",Value::Null).unwrap();execute(&mut s,json!({"width":2,"color":"#ff0000","location":"outside","preserveTransparency":true})).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].surface().unwrap().rgba(2,5)[3],0.);assert!(s.active().unwrap().history.past_len()<=before.history.past_len()+1);
  let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
 }
 #[test] fn rejects_targets_locks_bad_parameters_and_padded_budget_without_writes(){
  let mut s=session();let before=s.active().unwrap().clone();for p in [Value::Null,json!({}),json!({"color":"#ff0000","width":0}),json!({"color":"#ff0000","width":251}),json!({"color":"red"}),json!({"color":"#ff0000","opacity":101}),json!({"color":"#ff0000","mode":"PassThrough"}),json!({"color":"#ff0000","location":"any"}),json!({"color":"#ff0000","target":"mask"}),json!({"color":"#ff0000","preserveTransparency":"true"})]{assert!(execute(&mut s,p).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));}
  s.execute("layer.lockLayers",json!({"pixels":true})).unwrap();let before=s.active().unwrap().clone();assert!(disabled_reason(&s,ID).is_some());assert!(execute(&mut s,json!({"color":"#ff0000"})).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
  let mut s=session();s.execute("image.canvasSize",json!({"width":4096,"height":4096})).unwrap();let before=s.active().unwrap().clone();assert!(execute(&mut s,json!({"color":"#ff0000","width":250})).unwrap_err().to_string().contains("256"));assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
 }
}
