//! Bounded English spelling workflow. User dictionary is supplied by the host, never serialized
//! into a project; all document replacements execute on a scratch session after full preflight.
use std::collections::HashSet;
use photocraft_doc::LayerContent;
use photocraft_engine::Session;
use serde_json::{Value,json};
use crate::error::{EditorError,Result};
pub const ID:&str="edit.checkSpelling";
fn fail(message:impl ToString)->EditorError {EditorError::CommandFailed{id:ID.into(),message:message.to_string()}}
fn words(value:Option<&Value>)->Result<Vec<String>> {
 let Some(value)=value else{return Ok(Vec::new())};
 let array=value.as_array().filter(|a|a.len()<=2000).ok_or_else(||fail("用户词典/忽略列表不能超过2000词"))?;
 array.iter().map(|v|v.as_str().filter(|w|!w.is_empty() && w.chars().count()<=128 && !w.contains(char::is_whitespace)).map(String::from).ok_or_else(||fail("词典条目须为1–128字符的单词"))).collect()
}
pub fn execute(session:&mut Session,params:Value)->Result<Value> {
 let fields=params.as_object().filter(|p|p.keys().all(|k|matches!(k.as_str(),"action"|"allLayers"|"layer"|"start"|"end"|"word"|"replace"|"dictionary"|"ignore"))).ok_or_else(||fail("拼写参数包含未知字段"))?;
 let action=fields.get("action").map_or(Some("list"),Value::as_str).filter(|a|matches!(*a,"list"|"suggest"|"change"|"changeAll"|"add")).ok_or_else(||fail("无效的拼写检查动作"))?;
 if fields.get("allLayers").is_some_and(|v|!v.is_boolean()){return Err(fail("检查范围必须为布尔值"));}
 let dictionary=words(fields.get("dictionary"))?;let ignore=words(fields.get("ignore"))?;
 let word=fields.get("word").and_then(Value::as_str);
 // Reject wrong types, oversized words/replacements and numeric ranges before any usize cast.
 if fields.contains_key("word") && word.is_none(){return Err(fail("单词须为文字"));}
 if word.is_some_and(|w|w.is_empty() || w.chars().count()>128 || w.contains(char::is_whitespace)){return Err(fail("单词须为1–128字符"));}
 let replacement=match fields.get("replace"){None=>"",Some(v)=>v.as_str().filter(|v|v.encode_utf16().count()<=10000).ok_or_else(||fail("替换文字不能超过10000字符"))?};
 for key in ["layer","start","end"] {if fields.get(key).is_some_and(|v|v.as_u64().is_none() || v.as_u64().unwrap()>if key=="layer"{9007199254740991}else{100000}){return Err(fail("图层或文字范围超出支持范围"));}}
 if session.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}
 let base=session.active().ok_or(EditorError::NoDocument)?;let all=params["allLayers"].as_bool().unwrap_or(true);
 if action=="list" {
  if fields.contains_key("layer"){return Err(fail("检查列表只接受当前或全部图层范围"));}
  let accepted:HashSet<String>=dictionary.iter().chain(ignore.iter()).map(|w|w.to_lowercase()).collect();
  let dict=photocraft_text::spell::Dictionary::english();let mut out=Vec::new();let mut total=0usize;
  for (_,_,layer) in base.doc.walk().into_iter().rev(){
   if !all && Some(layer.id)!=base.active_layer || base.doc.effective_locks(layer.id).all {continue;}
   let LayerContent::Text(text)=&layer.content else {continue};total+=text.text.encode_utf16().count();if total>100000{return Err(fail("单次检查文字不能超过100000字符"));}
   for hit in dict.misspellings(&text.text,&accepted){out.push(json!({"layer":layer.id.0,"start":text.text[..hit.start].chars().count(),"end":text.text[..hit.end].chars().count(),"word":hit.word}));}
  }
  return Ok(json!({"count":out.len(),"misspellings":out}));
 }
 if word.is_none(){return Err(fail("此操作需要单词"));}
 if action=="add" {
  let mut next=dictionary;if !next.iter().any(|w|w.to_lowercase()==word.unwrap().to_lowercase()){if next.len()>=2000{return Err(fail("用户词典已达到2000词上限"));}next.push(word.unwrap().into());next.sort_by_key(|w|w.to_lowercase());}
  return Ok(json!({"userDictionary":next}));
 }
 if action=="change" || action=="changeAll" {
  if !fields.contains_key("replace"){return Err(fail("替换操作需要替换文字"));}
  if action=="change" && ["layer","start","end"].iter().any(|k|!fields.contains_key(*k)){return Err(fail("单次替换需要完整文字范围"));}
  for (_,_,layer) in base.doc.walk(){
   if action=="change" {if Some(layer.id.0)!=params["layer"].as_u64(){continue;}}else if !all && Some(layer.id)!=base.active_layer {continue;}
   let LayerContent::Text(text)=&layer.content else {continue};
   if text.text.encode_utf16().count()>100000{return Err(fail("单层文字超过100000字符"));}
   let hits=if action=="change" {
    let start=params["start"].as_u64().unwrap() as usize;let end=params["end"].as_u64().unwrap() as usize;
    if start>=end || end>text.text.chars().count(){return Err(fail("文字范围已失效"));}
    let a=text.text.char_indices().nth(start).map_or(text.text.len(),|(i,_)|i);let b=text.text.char_indices().nth(end).map_or(text.text.len(),|(i,_)|i);
    if &text.text[a..b]!=word.unwrap(){return Err(fail("文字内容已变化，请重新检查"));}vec![(a,b)]
   }else{photocraft_text::spell::words(&text.text).into_iter().filter(|(a,b)|&text.text[*a..*b]==word.unwrap()).collect()};
   if hits.is_empty(){continue;}let locks=base.doc.effective_locks(layer.id);if locks.all || locks.pixels{return Err(fail("匹配的文字图层已锁定，请解锁后重试"));}
   let removed:usize=hits.iter().map(|(a,b)|text.text[*a..*b].encode_utf16().count()).sum();
   if text.text.encode_utf16().count().saturating_sub(removed)+replacement.encode_utf16().count()*hits.len()>100000{return Err(fail("替换后单层文字超过100000字符"));}
  }
 }
 let mut scratch=Session::new();scratch.edit_prefs(|p|{*p=session.prefs().clone();p.user_dictionary=dictionary;});scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 let mut args=params.clone();args.as_object_mut().unwrap().remove("dictionary");if action=="changeAll"{for key in ["layer","start","end"]{args.as_object_mut().unwrap().remove(key);}}args["suggestions"]=json!(5);
 let result=scratch.execute(ID,args).map_err(fail)?;
 if action=="change" || action=="changeAll"{*session.active_mut().unwrap()=scratch.active().unwrap().clone();}
 Ok(result)
}
#[cfg(test)] mod tests {
 use super::*;
 fn session()->Session {let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":16,"background":"transparent"})).unwrap();for text in ["😀 helo world helo","helo world"] {s.execute("type.create",json!({"text":text,"x":1,"y":1})).unwrap();}s}
 #[test] fn lists_without_history_and_replaces_all_in_one_atomic_undo() {
  let mut s=session();let before=s.active().unwrap().clone();let list=execute(&mut s,json!({"action":"list"})).unwrap();assert_eq!(list["count"],3);assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
  let suggestions=execute(&mut s,json!({"action":"suggest","word":"helo"})).unwrap();assert!(suggestions["suggestions"].as_array().unwrap().iter().any(|v|v=="hello"));
  assert_eq!(execute(&mut s,json!({"action":"changeAll","word":"helo","replace":"hello"})).unwrap()["changed"],3);
  assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);
 }
 #[test] fn unicode_ranges_dictionary_and_ignore_are_document_neutral() {
  let mut s=session();let before=s.active().unwrap().clone();let added=execute(&mut s,json!({"action":"add","word":"helo"})).unwrap();assert_eq!(added["userDictionary"],json!(["helo"]));assert!(s.prefs().user_dictionary.is_empty());
  for params in [json!({"dictionary":["helo"]}),json!({"ignore":["helo"]})]{assert_eq!(execute(&mut s,params).unwrap()["count"],0);assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));}
  let list=execute(&mut s,json!({})).unwrap();let hit=list["misspellings"].as_array().unwrap().iter().find(|h|h["start"]==2).unwrap();
  let mut params=hit.clone();params["action"]=json!("change");params["replace"]=json!("你好😀");execute(&mut s,params).unwrap();
  let remaining=execute(&mut s,json!({})).unwrap();assert_eq!(remaining["misspellings"].as_array().unwrap().iter().filter(|h|h["word"]=="helo").count(),2);
  let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
 }
 #[test] fn inherited_locks_and_invalid_requests_preserve_document_history_and_preferences() {
  let mut s=session();s.execute("layer.lockLayers",json!({"pixels":true})).unwrap();let before=s.active().unwrap().clone();
  for params in [json!({"action":"changeAll","word":"helo","replace":"hello"}),json!({"layer":4294967296u64,"start":0,"end":4294967296u64,"word":"helo","replace":"x","action":"change"}),json!({"action":"other"}),json!({"dictionary":["two words"]}),json!({"dictionary":[42]}),json!({"dictionary":vec!["x";2001]}),json!({"word":42}),json!({"target":"external"}),json!({"action":"change","word":"helo","replace":"hello"})] {
   assert!(execute(&mut s,params).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));assert_eq!(before.history.past_len(),s.active().unwrap().history.past_len());assert!(s.prefs().user_dictionary.is_empty());
  }
 }
}
