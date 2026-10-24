//! Atomic document-wide text refresh, without exposing unconstrained engine dispatch.
use photocraft_engine::Session;
use photocraft_doc::LayerContent;
use serde_json::{Value,json};
use crate::{EditorError,Result};
pub const REFRESH:&str="type.updateAllTextLayers";
pub fn disabled_reason(session:&Session,id:&str)->Option<String>{
 if !matches!(id,REFRESH|LOAD_DEFAULTS){return None;}
 if id==LOAD_DEFAULTS {
  let base=session.active()?;let layer=base.active_layer.and_then(|id|base.doc.layer(id));
  if !layer.is_some_and(|layer|matches!(layer.content,LayerContent::Text(_))){return Some("没有活动文字图层".into());}
  let locks=base.doc.effective_locks(layer.unwrap().id);if locks.all || locks.pixels{return Some("文字图层已锁定".into());}
  return None;
 }
 if session.active_job().is_some(){return Some("文档后台任务尚未结束".into());}
 let base=session.active()?;
 if base.doc.walk().iter().any(|(_,_,layer)|matches!(layer.content,LayerContent::Text(_)) && {let locks=base.doc.effective_locks(layer.id);locks.all || locks.pixels}){return Some("文字图层已锁定；请先解锁再刷新全部文字".into());}
 None
}
pub fn refresh(session:&mut Session,params:Value)->Result<Value>{
 let fail=|message:&str|EditorError::CommandFailed{id:REFRESH.into(),message:message.into()};
 if !params.is_null() && !params.as_object().is_some_and(|fields|fields.is_empty()){return Err(fail("刷新文字不接受额外参数"));}
 if session.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}
 let base=session.active().ok_or(EditorError::NoDocument)?;
 let text=base.doc.walk().into_iter().filter(|(_,_,layer)|matches!(layer.content,LayerContent::Text(_))).map(|(_,_,layer)|layer.id).collect::<Vec<_>>();
 if text.is_empty(){return Err(fail("文档没有文字图层"));}
 if text.iter().any(|id|{let locks=base.doc.effective_locks(*id);locks.all || locks.pixels}){return Err(fail("文字图层已锁定；请先解锁再刷新全部文字"));}
 let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=session.prefs().clone());scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 let result=scratch.execute(REFRESH,json!({})).map_err(|error|fail(&error.to_string()))?;
 *session.active_mut().unwrap()=scratch.active().unwrap().clone();Ok(result)
}

pub const SAVE_DEFAULTS:&str="type.saveDefaultTypeStyles";
pub const LOAD_DEFAULTS:&str="type.loadDefaultTypeStyles";
pub fn defaults(session:&mut Session,id:&str,params:Value)->Result<Value>{
 let fail=|message:&str|EditorError::CommandFailed{id:id.into(),message:message.into()};
 let empty=serde_json::Map::new();let fields=if params.is_null(){&empty}else{params.as_object().ok_or_else(||fail("默认文字样式参数必须为对象"))?};
 if fields.keys().any(|key|id==SAVE_DEFAULTS || key!="layer"){return Err(fail("默认文字样式包含未知参数"));}
 if session.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}
 let base=session.active().ok_or(EditorError::NoDocument)?;
 let target=match fields.get("layer"){Some(value)=>photocraft_doc::LayerId(value.as_u64().filter(|n|*n>0).ok_or_else(||fail("文字图层编号无效"))?),None=>base.active_layer.ok_or_else(||fail("没有活动文字图层"))?};
 if !base.doc.layer(target).is_some_and(|layer|matches!(layer.content,LayerContent::Text(_))){return Err(fail("目标不是文字图层"));}
 if id==SAVE_DEFAULTS{return session.execute(id,json!({})).map_err(|error|fail(&error.to_string()));}
 let locks=base.doc.effective_locks(target);if locks.all || locks.pixels{return Err(fail("文字图层已锁定"));}
 if session.type_defaults.is_none(){return Err(fail("尚未保存默认文字样式"));}
 let mut scratch=Session::new();scratch.type_defaults=session.type_defaults.clone();scratch.edit_prefs(|prefs|*prefs=session.prefs().clone());scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 let result=scratch.execute(id,json!({"layer":target.0})).map_err(|error|fail(&error.to_string()))?;
 *session.active_mut().unwrap()=scratch.active().unwrap().clone();Ok(result)
}

pub const RESOLVE_FONTS:&str="type.resolveMissingFonts";
pub const REPLACE_FONTS:&str="type.replaceAllMissingFonts";
pub fn replace_fonts(session:&mut Session,id:&str,params:Value)->Result<Value>{
 let fail=|message:&str|EditorError::CommandFailed{id:id.into(),message:message.into()};
 let empty=serde_json::Map::new();let fields=if params.is_null() && id==REPLACE_FONTS{&empty}else{params.as_object().ok_or_else(||fail("字体替换参数必须为对象"))?};
 if fields.keys().any(|key|id==REPLACE_FONTS || key!="map"){return Err(fail("字体替换包含未知参数"));}
 if session.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}
 let base=session.active().ok_or(EditorError::NoDocument)?;
 let missing=photocraft_engine::type_extra_cmds::missing_fonts(&base.doc);
 let map=if id==RESOLVE_FONTS{Some(fields.get("map").and_then(Value::as_object).ok_or_else(||fail("缺少字体映射"))?)}else{None};
 if let Some(map)=map {
  if map.keys().any(|family|!missing.contains(family)){return Err(fail("映射包含并未缺失的字体"));}
  for family in map.values(){let family=family.as_str().filter(|font|matches!(*font,"Inter"|"Noto Sans SC")).ok_or_else(||fail("替代字体尚未开放"))?;
   if !photocraft_text::shared().lock().unwrap_or_else(|e|e.into_inner()).fonts.has_family(family){return Err(fail("替代字体未加载，请重试"));}
  }
 }
 if missing.is_empty() || map.is_some_and(|map|map.is_empty()){return Ok(json!({"missing":missing,"replaced":0}));}
 for (_,_,layer) in base.doc.walk(){if let LayerContent::Text(text)=&layer.content {
  let affected=photocraft_engine::type_extra_cmds::missing_fonts_in_layer(text).iter().any(|family|map.is_none_or(|map|map.contains_key(family)));
  let locks=base.doc.effective_locks(layer.id);if affected && (locks.all || locks.pixels){return Err(fail("含缺失字体的文字层已锁定"));}
 }}
 let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=session.prefs().clone());scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 let result=scratch.execute(id,if id==RESOLVE_FONTS{params}else{json!({})}).map_err(|error|fail(&error.to_string()))?;
 *session.active_mut().unwrap()=scratch.active().unwrap().clone();Ok(result)
}
