//! Strict, atomic history navigation and session-only snapshot commands.
use photocraft_engine::Session;
use serde_json::{Value,json};
use crate::{EditorError,Result};
pub const IDS:&[&str]=&["history.selectState","history.newSnapshot","history.selectSnapshot","history.renameSnapshot","history.deleteSnapshot","history.deleteState"];
pub fn execute(session:&mut Session,id:&str,params:Value)->Result<Value> {
 let fail=|message:&str|EditorError::CommandFailed{id:id.into(),message:message.into()};
 let empty=serde_json::Map::new();
 let fields=if params.is_null() && matches!(id,"history.newSnapshot"|"history.deleteState") {&empty}else{params.as_object().ok_or_else(||fail("历史参数必须为对象"))?};
 let keys:&[&str]=match id {"history.selectState"|"history.deleteState"=>&["state"],"history.newSnapshot"=>&["name","from"],"history.renameSnapshot"=>&["snapshot","name"],_=>&["snapshot"]};
 if fields.keys().any(|key|!keys.contains(&key.as_str())){return Err(fail("历史参数包含未知字段"));}
 if session.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}
 let base=session.active().ok_or(EditorError::NoDocument)?;
 if id=="history.selectState" {
  let last=base.history.past_len()+base.history.redo_labels().count();
  if !fields.get("state").and_then(Value::as_u64).is_some_and(|value|value<=last as u64){return Err(fail("历史状态编号无效"));}
 }else if id=="history.deleteState" {
  let current=base.history.past_len();
  let target=if let Some(value)=fields.get("state"){value.as_u64().filter(|value|*value<=current as u64).ok_or_else(||fail("只能删除当前或之前的历史状态"))? as usize}else{current};
  if target==0{return Err(fail("不能删除最早的历史状态"));}
 }else if id!="history.newSnapshot" {
  if !fields.get("snapshot").and_then(Value::as_u64).is_some_and(|id|base.snapshots.iter().any(|snap|snap.id==id)){return Err(fail("历史快照不存在"));}
 }
 if let Some(name)=fields.get("name") {if name.as_str().is_none_or(|name|name.trim().is_empty()||name.len()>1024||name.chars().any(char::is_control)){return Err(fail("快照名称须为非空且不含控制字符的短文本"));}}
 if id=="history.renameSnapshot"&&!fields.contains_key("name"){return Err(fail("缺少快照名称"));}
 if let Some(from)=fields.get("from"){if !matches!(from.as_str(),Some("fullDocument"|"mergedLayers"|"currentLayer")){return Err(fail("快照来源无效"));}}
 let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=session.prefs().clone());
 scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
 let result=scratch.execute(id,if params.is_null(){json!({})}else{params}).map_err(|error|EditorError::CommandFailed{id:id.into(),message:error.to_string()})?;
 *session.active_mut().unwrap()=scratch.active().unwrap().clone();Ok(result)
}
