//! 图层选择和隔离只更新会话状态，不进入工程内容或编辑历史。
use photocraft_doc::LayerId;
use photocraft_engine::Session;
use serde_json::{json,Value};
use crate::error::{EditorError,Result};
pub(crate) const IDS:&[&str]=&["select.allLayers","select.findLayers","select.isolateLayers"];
fn error(id:&str,message:&str)->EditorError {EditorError::CommandFailed{id:id.into(),message:message.into()}}
pub(crate) fn disabled_reason(session:&Session,id:&str)->Option<String> {
    let state=session.active()?;
    (id=="select.isolateLayers" && state.isolated_layers.is_empty() && state.selected_layers().is_empty()).then(||"请先选择要隔离的图层".into())
}
pub(crate) fn execute(session:&mut Session,id:&str,params:&Value)->Result<Value> {
    if !params.is_null() {
        let fields=params.as_object().ok_or_else(||error(id,"图层选择参数必须为对象"))?;
        let allowed=match id {"select.findLayers"=>Some("name"),"select.isolateLayers"=>Some("on"),_=>None};
        if fields.keys().any(|key|Some(key.as_str())!=allowed) {return Err(error(id,"图层选择包含未知参数"));}
    }
    let state=session.active().ok_or(EditorError::NoDocument)?;
    if id=="select.isolateLayers" {
        if params.get("on").is_some_and(|value|!value.is_boolean()) {return Err(error(id,"隔离开关必须为布尔值"));}
        let on=params["on"].as_bool().unwrap_or(state.isolated_layers.is_empty());
        let selected=state.selected_layers();if on && selected.is_empty() {return Err(error(id,"请先选择要隔离的图层"));}
        let state=session.active_mut().unwrap();let clean=state.saved_revision==state.revision;
        state.isolated_layers=if on {selected} else {vec![]};state.revision+=1;if clean {state.saved_revision=state.revision;}
        state.last_damage=Some(photocraft_geom::Rect::EMPTY);
        return Ok(json!({"isolated":on,"layers":state.isolated_layers.iter().map(|id|id.0).collect::<Vec<_>>()}));
    }
    let needle=if id=="select.findLayers" {Some(params["name"].as_str().filter(|name|!name.is_empty() && name.encode_utf16().count()<=200).ok_or_else(||error(id,"请输入 1–200 字的图层名称"))?.to_lowercase())} else {None};
    let ids:Vec<LayerId>=state.doc.walk().into_iter().filter(|(_,_,layer)|match &needle {Some(needle)=>layer.name.to_lowercase().contains(needle),None=>!state.doc.is_background(layer.id)}).map(|(_,_,layer)|layer.id).collect();
    if ids.is_empty() {return Err(error(id,if needle.is_some() {"未找到匹配的图层"} else {"没有可选择的非背景图层"}));}
    let active=state.active_layer.filter(|id|ids.contains(id)).or(ids.last().copied());let count=ids.len();
    photocraft_engine::layer_multi_cmds::set_selection(session,ids,active,None).map_err(|err|error(id,&err.to_string()))?;
    Ok(json!({"selected":count}))
}
