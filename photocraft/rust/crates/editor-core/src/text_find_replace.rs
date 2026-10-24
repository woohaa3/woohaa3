//! Document-scoped text search/replace; native byte ranges never become JS string offsets.
use photocraft_doc::LayerContent;
use photocraft_engine::Session;
use serde_json::Value;
use crate::error::{EditorError,Result};
pub const ID:&str="edit.findAndReplaceText";
fn fail(message:impl ToString)->EditorError {EditorError::CommandFailed{id:ID.into(),message:message.to_string()}}
pub fn execute(session:&mut Session,params:Value)->Result<Value> {
    let fields=params.as_object().filter(|p|p.keys().all(|k|matches!(k.as_str(),"find"|"replace"|"caseSensitive"|"wholeWord"|"forward"|"allLayers"|"action"))).ok_or_else(||fail("查找替换参数包含未知字段"))?;
    let find=fields.get("find").and_then(Value::as_str).filter(|s|!s.is_empty() && s.encode_utf16().count()<=10_000).ok_or_else(||fail("查找文字须为1–10000字符"))?;
    let replace=match fields.get("replace") {None=>"",Some(v)=>v.as_str().filter(|s|s.encode_utf16().count()<=10_000).ok_or_else(||fail("替换文字不能超过10000字符"))?};
    for key in ["caseSensitive","wholeWord","forward","allLayers"] {if fields.get(key).is_some_and(|v|!v.is_boolean()){return Err(fail("查找选项必须为布尔值"));}}
    let action=fields.get("action").map_or(Some("changeAll"),Value::as_str).filter(|s|matches!(*s,"find"|"change"|"changeFind"|"changeAll")).ok_or_else(||fail("无效的查找替换动作"))?;
    if session.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}
    let base=session.active().ok_or(EditorError::NoDocument)?;
    let case=params["caseSensitive"].as_bool().unwrap_or(false);let whole=params["wholeWord"].as_bool().unwrap_or(false);let all=params["allLayers"].as_bool().unwrap_or(true);
    // Preflight every affected target, including inherited locks. The engine's Replace All does
    // not do this itself, so none of its successful prefix may reach the live document.
    if action!="find" {
        for (_,_,layer) in base.doc.walk() {
            if !all && Some(layer.id)!=base.active_layer {continue;}
            let LayerContent::Text(text)=&layer.content else {continue};
            let matches=photocraft_engine::edit_menu_cmds::find_matches(&text.text,find,case,whole);
            let affected=if action=="changeAll" {matches.clone()} else {matches.into_iter().filter(|(a,b)|session.edit_state.find_cursor==Some((layer.id,*a,*b))).collect()};
            if affected.is_empty(){continue;}
            let locks=base.doc.effective_locks(layer.id);if locks.all || locks.pixels{return Err(fail("匹配的文字图层已锁定，请解锁后重试"));}
            let old=text.text.encode_utf16().count();let removed:usize=affected.iter().map(|(a,b)|text.text[*a..*b].encode_utf16().count()).sum();
            let inserted=replace.encode_utf16().count().checked_mul(affected.len()).ok_or_else(||fail("替换结果过大"))?;
            if old.saturating_sub(removed).saturating_add(inserted)>100_000{return Err(fail("替换后单层文字超过100000字符"));}
        }
    }
    let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=session.prefs().clone());scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();scratch.edit_state=session.edit_state.clone();
    if !all && scratch.edit_state.find_cursor.is_some_and(|(id,_,_)|Some(id)!=base.active_layer){scratch.edit_state.find_cursor=None;}
    let result=scratch.execute(ID,params).map_err(fail)?;
    *session.active_mut().unwrap()=scratch.active().unwrap().clone();session.edit_state.find_cursor=scratch.edit_state.find_cursor;
    Ok(result)
}
#[cfg(test)] mod tests {
 use super::*;use serde_json::json;
 fn session()->Session {let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":16,"background":"transparent"})).unwrap();for text in ["猫 world WORLD worldly 😀","world 猫"] {s.execute("type.create",json!({"text":text,"x":1,"y":1})).unwrap();}s}
 #[test] fn search_and_replace_is_atomic_unicode_scoped_and_undoable() {
  let mut s=session();let before=s.active().unwrap().clone();let found=execute(&mut s,json!({"find":"world","wholeWord":true,"action":"find"})).unwrap();assert!(found["found"]["layer"].is_u64());assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len());
  let result=execute(&mut s,json!({"find":"world","replace":"你好😀","wholeWord":true,"action":"changeAll"})).unwrap();assert_eq!(result["count"],3);assert_eq!(result["layers"],2);assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);
  let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);s.execute("edit.redo",Value::Null).unwrap();
  let before=s.active().unwrap().clone();assert_eq!(execute(&mut s,json!({"find":"not present","replace":"x"})).unwrap()["count"],0);assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
 }
 #[test] fn single_steps_and_all_target_preflight_preserve_cursor_and_redo_on_failure() {
  let mut s=session();let found=execute(&mut s,json!({"find":"world","action":"find","allLayers":false})).unwrap();let id=found["found"]["layer"].as_u64().unwrap();
  execute(&mut s,json!({"find":"world","replace":"x","action":"change","allLayers":false})).unwrap();assert!(s.active().unwrap().doc.layer(photocraft_doc::LayerId(id)).is_some());s.execute("edit.undo",Value::Null).unwrap();
  s.execute("layer.lockLayers",json!({"all":true})).unwrap();let before=s.active().unwrap().clone();let cursor=s.edit_state.find_cursor;
  for params in [json!({"find":"world","replace":"x"}),json!({"find":""}),json!({"find":"world","layer":id}),json!({"find":"world","wholeWord":"true"}),json!({"find":"world","action":"other"}),json!({"find":"world","replace":"x".repeat(10001)})] {assert!(execute(&mut s,params).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));assert_eq!(s.edit_state.find_cursor,cursor);assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len());}
 }
 #[test] fn oversized_results_and_cursor_outside_current_layer_are_refused_without_writes() {
  let mut s=session();let active=s.active().unwrap().active_layer.unwrap();
  let other=s.active().unwrap().doc.walk().into_iter().find_map(|(_,_,l)|(l.id!=active && matches!(l.content,LayerContent::Text(_))).then_some(l.id)).unwrap();
  s.edit_state.find_cursor=Some((other,4,9));let before=s.active().unwrap().clone();
  let result=execute(&mut s,json!({"find":"world","replace":"x","allLayers":false,"action":"change"})).unwrap();assert!(result["changed"].is_null());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
  if let LayerContent::Text(text)=&mut std::sync::Arc::make_mut(&mut s.active_mut().unwrap().doc).layer_mut(active).unwrap().content {text.text="x".repeat(100_000);}
  let before=s.active().unwrap().clone();let cursor=s.edit_state.find_cursor;
  assert!(execute(&mut s,json!({"find":"x","replace":"xx","allLayers":false})).unwrap_err().to_string().contains("100000"));assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));assert_eq!(s.edit_state.find_cursor,cursor);
 }

}
