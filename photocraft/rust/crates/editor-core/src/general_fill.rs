//! Strict document Fill, isolated from session palette and user library ownership.
use photocraft_engine::Session;
use photocraft_doc::{LayerContent,Pattern};
use serde_json::{Value,json};
use crate::error::{EditorError,Result};
pub const ID:&str="edit.fill";
pub const HISTORY_ID:&str="edit.fillHistory";
fn fail(message:impl ToString)->EditorError {EditorError::CommandFailed{id:ID.into(),message:message.to_string()}}
fn target(s:&Session)->Result<bool> {
 let state=s.active().ok_or(EditorError::NoDocument)?;let id=state.active_layer.ok_or_else(||fail("请先选择图层"))?;
 let layer=state.doc.layer(id).ok_or_else(||fail("目标图层不存在"))?;let mask=crate::layer_preview::mask_target(state);let locks=state.doc.effective_locks(id);
 if locks.all || (!mask && locks.pixels){return Err(fail("填充目标已锁定"));}
 if mask {if layer.mask.is_none(){return Err(fail("目标图层没有蒙版"));}}else if !matches!(layer.content,LayerContent::Raster(_)){return Err(fail("请先选择像素层或像素蒙版"));}
 Ok(mask)
}
pub fn disabled_reason(s:&Session,id:&str)->Option<String>{(id==ID || id==HISTORY_ID).then(||target(s).err().map(|e|e.to_string())).flatten()}
pub fn execute_history(s:&mut Session,p:Value)->Result<Value> {
 let history_fail=|message:&str|EditorError::CommandFailed{id:HISTORY_ID.into(),message:message.into()};
 let empty=serde_json::Map::new();let fields=if p.is_null(){&empty}else{p.as_object().ok_or_else(||history_fail("历史填充参数必须为对象"))?};
 if fields.keys().any(|k|k!="state"){return Err(history_fail("历史填充只接受可选历史状态索引"));}
 let mut routed=Value::Object(fields.clone());routed["contents"]=json!("history");
 execute(s,routed,&[]).map_err(|error|EditorError::CommandFailed{id:HISTORY_ID.into(),message:error.to_string()})
}
pub fn execute(s:&mut Session,mut p:Value,patterns:&[Pattern])->Result<Value> {
 let fields=p.as_object().filter(|p|p.keys().all(|k|matches!(k.as_str(),"contents"|"color"|"pattern"|"colorAdaptation"|"mode"|"opacity"|"preserveTransparency"|"state"))).ok_or_else(||fail("填充包含未知参数或指定目标"))?;
 let contents=fields.get("contents").and_then(Value::as_str).filter(|v|photocraft_engine::fill_cmds::CONTENTS.contains(v)).ok_or_else(||fail("请选择有效填充来源"))?.to_string();
 for key in ["preserveTransparency","colorAdaptation"] {if fields.get(key).is_some_and(|v|!v.is_boolean()){return Err(fail("填充选项必须为布尔值"));}}
 if fields.get("opacity").is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite() || !(0.0..=100.0).contains(&n))){return Err(fail("不透明度须为0–100%"));}
 if fields.get("mode").is_some_and(|v|v.as_str().and_then(photocraft_engine::commands::blend_from_str).is_none_or(|m|m==photocraft_doc::BlendMode::PassThrough)){return Err(fail("请选择有效填充混合模式"));}
 if fields.get("color").is_some_and(|v|v.as_str().is_none_or(|c|c.len()!=7 || !c.starts_with('#') || !c[1..].bytes().all(|b|b.is_ascii_hexdigit()))){return Err(fail("填充颜色须为#rrggbb"));}
 if matches!(contents.as_str(),"foreground"|"background"|"color") && !fields.contains_key("color"){return Err(fail("请提供当前调色盘的填充颜色"));}
 if fields.get("pattern").is_some_and(|v|v.as_str().is_none_or(|v|v.is_empty() || v.len()>256)){return Err(fail("图案身份无效"));}
 if contents=="pattern" && !fields.contains_key("pattern"){return Err(fail("请选择填充图案"));}
 if fields.get("state").is_some_and(|v|v.as_u64().is_none()){return Err(fail("历史来源必须为有效索引"));}
 if fields.contains_key("state") && contents!="history"{return Err(fail("只有历史来源可以指定历史状态"));}
 let mask=target(s)?;let base=s.active().unwrap().clone();
 if p.get("state").and_then(Value::as_u64).is_some_and(|n|n>base.history.past_len() as u64){return Err(fail("历史来源已不在保留范围内"));}
 let pixels=u64::from(base.doc.size.width)*u64::from(base.doc.size.height);
 if pixels*64>256*1024*1024{return Err(fail("填充工作像素超过256 MiB预算"));}
 if contents=="contentAware" {
  if mask || base.doc.selection.as_ref().is_none_or(|m|m.content_bounds().intersect(&base.doc.bounds()).is_empty()){return Err(fail("内容感知填充需要像素层上的非空选区"));}
  if pixels>262_144{return Err(fail("内容感知填充当前限262144画布像素，请缩小文档后重试"));}
 }
 if s.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}
 if matches!(contents.as_str(),"foreground"|"background"){p["contents"]=json!("color");}
 p["target"]=json!(if mask{"mask"}else{"pixels"});
 let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=s.prefs().clone());scratch.patterns.items=s.patterns.items.clone();scratch.patterns.items.extend_from_slice(patterns);scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 let mut result=scratch.execute(ID,p).map_err(fail)?;
 if scratch.active().unwrap().doc!=base.doc {*s.active_mut().unwrap()=scratch.active().unwrap().clone();}
 result["contents"]=json!(contents);Ok(result)
}
#[cfg(test)] mod tests {
 use super::*;
 fn session()->Session {let mut s=Session::new();s.execute("file.new",json!({"width":8,"height":8,"background":"transparent"})).unwrap();s}
 #[test] fn colors_selection_opacity_and_preserve_transparency_are_one_step_and_undoable(){
  let mut s=session();s.execute("select.rect",json!({"x":2,"y":2,"width":3,"height":3})).unwrap();let before=s.active().unwrap().clone();let palette=format!("{:?}",s.tools);
  execute(&mut s,json!({"contents":"foreground","color":"#ff0000","opacity":50,"mode":"Normal"}),&[]).unwrap();let after=s.active().unwrap();let surf=after.doc.layers[0].surface().unwrap();assert_eq!(surf.rgba(0,0)[3],0.);assert!((surf.rgba(3,3)[3]-0.5).abs()<0.01);assert_eq!(after.history.past_len(),before.history.past_len()+1);assert_eq!(format!("{:?}",s.tools),palette);s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);
  execute(&mut s,json!({"contents":"white","preserveTransparency":true}),&[]).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].surface().unwrap().rgba(3,3)[3],0.);assert!(s.active().unwrap().history.past_len()<=before.history.past_len()+1);
 }
 #[test] fn mask_pattern_and_history_sources_keep_their_owners(){
  let mut s=session();s.execute("layer.layerMask.revealAll",Value::Null).unwrap();s.execute("channel.target.layerMask",Value::Null).unwrap();let before=s.active().unwrap().clone();execute(&mut s,json!({"contents":"black"}),&[]).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].mask.as_ref().unwrap().surface.sample_channel(1,1,0),0.);assert_eq!(s.active().unwrap().doc.layers[0].content,before.doc.layers[0].content);s.execute("edit.undo",Value::Null).unwrap();
  s.execute("channel.target.composite",Value::Null).unwrap();let mut surface=photocraft_doc::Surface::new(s.active().unwrap().doc.pixel_format());surface.write_pixel(0,0,&[0.,1.,0.,1.]);let pattern=Pattern::new("Green",surface,1,1);let id=pattern.id.clone();execute(&mut s,json!({"contents":"pattern","pattern":id}),&[pattern]).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].surface().unwrap().rgba(1,1),[0.,1.,0.,1.]);assert!(s.active().unwrap().doc.patterns.is_empty());
  execute(&mut s,json!({"contents":"history","state":0}),&[]).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].surface().unwrap().rgba(1,1)[3],0.);let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
 }
 #[test] fn bad_parameters_locks_and_budgets_never_publish(){
  let mut s=session();let before=s.active().unwrap().clone();for p in [Value::Null,json!({}),json!({"contents":"color"}),json!({"contents":"black","opacity":101}),json!({"contents":"black","target":"mask"}),json!({"contents":"black","mode":"PassThrough"}),json!({"contents":"black","state":0}),json!({"contents":"history","state":4294967296_u64}),json!({"contents":"pattern","pattern":"missing"}),json!({"contents":"contentAware"}),json!({"contents":"white","preserveTransparency":"true"})] {assert!(execute(&mut s,p,&[]).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));}
  s.execute("layer.lockLayers",json!({"pixels":true})).unwrap();assert!(disabled_reason(&s,ID).is_some());let before=s.active().unwrap().clone();assert!(execute(&mut s,json!({"contents":"white"}),&[]).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
 }
 #[test] fn content_aware_reads_surroundings_and_respects_selection_in_one_step(){
  let mut s=session();execute(&mut s,json!({"contents":"color","color":"#ff0000"}),&[]).unwrap();s.execute("select.rect",json!({"x":3,"y":3,"width":2,"height":2})).unwrap();execute(&mut s,json!({"contents":"white"}),&[]).unwrap();let before=s.active().unwrap().clone();
  execute(&mut s,json!({"contents":"contentAware","colorAdaptation":false}),&[]).unwrap();let after=s.active().unwrap();assert_eq!(after.doc.layers[0].surface().unwrap().rgba(3,3),[1.,0.,0.,1.]);assert_eq!(after.doc.layers[0].surface().unwrap().rgba(0,0),[1.,0.,0.,1.]);assert_eq!(after.history.past_len(),before.history.past_len()+1);s.execute("edit.undo",Value::Null).unwrap();assert!(s.active().unwrap().doc==before.doc);
 }

 #[test] fn history_fill_alias_uses_default_or_explicit_state_without_external_targets(){
  let mut s=session();execute(&mut s,json!({"contents":"color","color":"#ff0000"}),&[]).unwrap();let red_state=s.active().unwrap().history.past_len();execute(&mut s,json!({"contents":"white"}),&[]).unwrap();let before=s.active().unwrap().clone();
  execute_history(&mut s,json!({"state":red_state})).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].surface().unwrap().rgba(1,1),[1.,0.,0.,1.]);assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);s.execute("edit.undo",Value::Null).unwrap();assert!(s.active().unwrap().doc==before.doc);
  execute_history(&mut s,Value::Null).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].surface().unwrap().rgba(1,1)[3],0.);
  let before=s.active().unwrap().clone();for p in [json!({"target":"pixels"}),json!({"layer":1}),json!({"contents":"white"}),json!({"state":4294967296_u64})]{assert!(execute_history(&mut s,p).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));}
  s.execute("layer.layerMask.revealAll",Value::Null).unwrap();let source=s.active().unwrap().history.past_len();s.execute("channel.target.layerMask",Value::Null).unwrap();execute(&mut s,json!({"contents":"black"}),&[]).unwrap();let before=s.active().unwrap().clone();execute_history(&mut s,json!({"state":source})).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].mask.as_ref().unwrap().surface.sample_channel(1,1,0),1.);assert!(s.active().unwrap().doc.layers[0].content==before.doc.layers[0].content);assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);
 }

}
