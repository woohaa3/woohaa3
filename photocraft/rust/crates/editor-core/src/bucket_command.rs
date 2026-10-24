//! Strict Paint Bucket boundary; publish a complete scratch result as one edit.
use photocraft_engine::Session;
use photocraft_doc::{LayerContent,Pattern};
use serde_json::Value;
use crate::error::{EditorError,Result};
const ID:&str="paint.bucket";
fn fail(message:impl std::fmt::Display)->EditorError {EditorError::CommandFailed{id:ID.into(),message:message.to_string()}}
fn target(s:&Session)->Result<bool> {
 let state=s.active().ok_or(EditorError::NoDocument)?;
 let id=state.active_layer.ok_or_else(||fail("请先选择图层"))?;
 let layer=state.doc.layer(id).ok_or_else(||fail("目标图层不存在"))?;
 crate::layer_preview::require_visible(state,&[id],ID)?;
 let mask=crate::layer_preview::mask_target(state);let locks=state.doc.effective_locks(id);
 if locks.all || (!mask && locks.pixels){return Err(fail("目标已锁定，请先解锁再填充"));}
 if mask {if layer.mask.is_none(){return Err(fail("目标图层没有蒙版"));}}
 else if !matches!(layer.content,LayerContent::Raster(_)){return Err(fail("油漆桶需要像素图层或像素蒙版"));}
 Ok(mask)
}
pub(crate) fn disabled_reason(s:&Session,id:&str)->Option<String>{if id==ID {target(s).err().map(|e|e.to_string())}else{None}}
pub(crate) fn execute(s:&mut Session,mut p:Value,patterns:&[Pattern])->Result<Value> {
 let fields=p.as_object().ok_or_else(||fail("参数必须为对象"))?;
 if fields.keys().any(|k|!["x","y","color","tolerance","contiguous","antiAlias","sampleAllLayers","contents","pattern","opacity","target"].contains(&k.as_str())){return Err(fail("油漆桶包含未知参数"));}
 for key in ["x","y"] {if p.get(key).and_then(Value::as_f64).is_none_or(|v|!v.is_finite()){return Err(fail("点击位置必须为有限数值"));}}
 for (key,min,max) in [("tolerance",0.,255.),("opacity",1.,100.)] {if p.get(key).is_some_and(|v|v.as_f64().is_none_or(|v|!v.is_finite() || v<min || v>max)){return Err(fail(format!("{key} 须为 {min}–{max}")));}}
 for key in ["contiguous","antiAlias","sampleAllLayers"] {if p.get(key).is_some_and(|v|!v.is_boolean()){return Err(fail(format!("{key} 必须为布尔值")));}}
 if p.get("color").is_some_and(|v|v.as_str().is_none_or(|v|v.len()!=7 || !v.starts_with('#') || !v[1..].bytes().all(|b|b.is_ascii_hexdigit()))){return Err(fail("前景色须为 #RRGGBB"));}
 if p.get("contents").is_some_and(|v|!matches!(v.as_str(),Some("foreground"|"pattern"))){return Err(fail("填充内容须为前景色或图案"));}
 if p.get("pattern").is_some_and(|v|v.as_str().is_none_or(|v|v.is_empty() || v.len()>256)){return Err(fail("图案身份无效"));}
 if p["contents"]=="pattern" && p.get("pattern").and_then(Value::as_str).is_none(){return Err(fail("请选择图案"));}
 let mask=target(s)?;
 if p.get("target").is_some_and(|v|v.as_str()!=Some(if mask {"mask"}else{"pixels"})){return Err(fail("填充目标已变化，请重新选择"));}
 p["target"]=Value::String(if mask {"mask"}else{"pixels"}.into());
 let base=s.active().unwrap().clone();let width=base.doc.size.width as f64;let height=base.doc.size.height as f64;
 let x=p["x"].as_f64().unwrap();let y=p["y"].as_f64().unwrap();
 if x<0. || y<0. || x>=width || y>=height {return Err(fail("请在画布内点击"));}
 // Region, source sampling, tile candidate and pattern buffers are bounded before allocation.
 let bytes=width*height*if p["sampleAllLayers"]==true && !mask {64.}else{32.};
 if bytes>268_435_456. {return Err(fail("填充像素资源超过 256 MiB 预算，请缩小画布"));}
 let mut scratch=Session::new();scratch.tools=s.tools.clone();scratch.patterns.items=s.patterns.items.clone();scratch.patterns.items.extend_from_slice(patterns);
 scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 let result=scratch.execute(ID,p).map_err(fail)?;
 let after=scratch.active().unwrap();
 if after.doc!=base.doc {crate::preview_history::commit_selected(s,after.doc.clone(),after.active_layer,after.selected_layers(),"Paint Bucket").map_err(fail)?;}
 Ok(result)
}
#[cfg(test)]
mod tests {
 use super::*;use serde_json::json;
 fn fixture()->Session{let mut s=Session::new();s.execute("file.new",json!({"width":8,"height":6})).unwrap();s}
 #[test]
 fn strict_rejections_are_atomic(){let mut s=fixture();let base=s.active().unwrap().clone();for p in [Value::Null,json!({}),json!({"x":null,"y":2}),json!({"x":-1,"y":2}),json!({"x":8,"y":2}),json!({"x":1,"y":1,"opacity":0}),json!({"x":1,"y":1,"tolerance":256}),json!({"x":1,"y":1,"contiguous":1}),json!({"x":1,"y":1,"antiAlias":"true"}),json!({"x":1,"y":1,"sampleAllLayers":null}),json!({"x":1,"y":1,"target":"quickMask"}),json!({"x":1,"y":1,"color":"#xxxxxx"}),json!({"x":1,"y":1,"contents":"pattern"}),json!({"x":1,"y":1,"contents":"pattern","pattern":"missing"}),json!({"x":1,"y":1,"extra":true})]{assert!(execute(&mut s,p,&[]).is_err());assert_eq!(s.active().unwrap().doc,base.doc);assert_eq!(s.active().unwrap().revision,base.revision);}}
 #[test]
 fn cpu_fill_respects_selection_and_one_step_history(){let mut s=fixture();s.execute("select.rect",json!({"x":1,"y":1,"width":2,"height":2})).unwrap();let base=s.active().unwrap().clone();execute(&mut s,json!({"x":1,"y":1,"color":"#ff0000","tolerance":0,"antiAlias":false}),&[]).unwrap();let after=s.active().unwrap();let surface=after.doc.layers[0].surface().unwrap();assert_eq!(surface.rgba(1,1),[1.,0.,0.,1.]);assert_eq!(surface.rgba(0,0),base.doc.layers[0].surface().unwrap().rgba(0,0));assert_eq!(after.history.past_len(),base.history.past_len()+1);s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);}
 #[test]
 fn mask_fill_and_pattern_source_keep_metadata_and_one_history_step(){
  let mut s=fixture();s.execute("layer.layerMask.revealAll",Value::Null).unwrap();s.execute("channel.target.layerMask",Value::Null).unwrap();
  let base=s.active().unwrap().clone();execute(&mut s,json!({"x":2,"y":2,"color":"#000000","target":"mask","antiAlias":false}),&[]).unwrap();
  assert_eq!(s.active().unwrap().doc.layers[0].mask.as_ref().unwrap().surface.sample_channel(2,2,0),0.);assert_eq!(s.active().unwrap().doc.layers[0].surface(),base.doc.layers[0].surface());
  s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
  s.execute("channel.target.composite",Value::Null).unwrap();
  let mut tile=photocraft_raster::Surface::new(s.active().unwrap().doc.pixel_format());tile.write_pixel(0,0,&[0.,1.,0.,1.]);
  let pattern=Pattern::new("测试",tile,1,1);let id=pattern.id.clone();let base=s.active().unwrap().clone();
  execute(&mut s,json!({"x":1,"y":1,"contents":"pattern","pattern":id,"target":"pixels","antiAlias":false}),&[pattern]).unwrap();
  assert_eq!(s.active().unwrap().doc.layers[0].surface().unwrap().rgba(1,1),[0.,1.,0.,1.]);
  assert_eq!(s.active().unwrap().doc.patterns,base.doc.patterns);assert_eq!(s.active().unwrap().history.past_len(),base.history.past_len()+1);
 }
 #[test]
 fn hidden_locked_and_oversized_targets_are_rejected(){let mut s=fixture();let state=s.active_mut().unwrap();std::sync::Arc::make_mut(&mut state.doc).layers[0].visible=false;assert!(execute(&mut s,json!({"x":1,"y":1}),&[]).is_err());let state=s.active_mut().unwrap();let doc=std::sync::Arc::make_mut(&mut state.doc);doc.layers[0].visible=true;doc.layers[0].locks.pixels=true;assert!(execute(&mut s,json!({"x":1,"y":1}),&[]).is_err());let state=s.active_mut().unwrap();let doc=std::sync::Arc::make_mut(&mut state.doc);doc.layers[0].locks.pixels=false;doc.size=photocraft_doc::Size::new(8192,8192);assert!(execute(&mut s,json!({"x":1,"y":1}),&[]).is_err());}
}
