//! 锁定参数在写入前严格检查，避免上游忽略非法值后执行默认切换。
use photocraft_doc::LayerId;
use photocraft_engine::Session;
use serde_json::Value;
use crate::error::{EditorError,Result};
const KEYS:[&str;5]=["transparency","pixels","position","artboard","all"];
fn error(id:&str,message:&str)->EditorError {EditorError::CommandFailed{id:id.into(),message:message.into()}}
fn validate(id:&str,value:&Value)->Result<()> {
    let fields=value.as_object().ok_or_else(||error(id,"锁定参数必须为布尔字段对象"))?;
    if fields.iter().any(|(key,value)| !KEYS.contains(&key.as_str()) || !value.is_boolean()) {
        return Err(error(id,"锁定参数只接受透明像素、像素、位置、画板和全部的布尔值"));
    }
    Ok(())
}
pub(crate) fn check(session:&Session,id:&str,params:&Value)->Result<()> {
    if id=="layer.lockLayers" {validate(id,params)?;}
    if id=="layer.setProps" {
        if let Some(locks)=params.get("locks") {validate(id,locks)?;}
        if params.get("locked").is_some_and(|value| !value.is_boolean()) {return Err(error(id,"全部锁定必须为布尔值"));}
        if ["opacity","fill","blend","clipped","channels"].iter().any(|key|params.get(*key).is_some()) {
            if let Some(state)=session.active() {
                let target=params["layer"].as_u64().map(LayerId).or(state.active_layer);
                if target.is_some_and(|target|state.doc.effective_locks(target).all) {return Err(error(id,"图层已全部锁定，请先解锁再修改属性"));}
            }
        }
    }
    if id=="layer.moveTo" || id.starts_with("layer.arrange.") {
        if let Some(state)=session.active() {
            let ids=if let Some(ids)=params["layers"].as_array() {ids.iter().filter_map(Value::as_u64).map(LayerId).collect::<Vec<_>>()}
                else {params["layer"].as_u64().map(LayerId).or(state.active_layer).into_iter().collect()};
            if ids.iter().any(|id|state.doc.effective_locks(*id).all) {return Err(error(id,"所选图层包含全部锁定的图层，请先解锁再调整顺序"));}
            if id=="layer.moveTo" {
                if let Some(target)=params["target"].as_u64().map(LayerId) {
                    let parent=if params["position"].as_str()==Some("into") {Some(target)} else {
                        state.doc.path_of(target).filter(|path|path.len()>1).and_then(|path|state.doc.layer_at(&path[..path.len()-1]).map(|layer|layer.id))
                    };
                    if parent.is_some_and(|parent|state.doc.effective_locks(parent).all) {return Err(error(id,"目标父组已全部锁定，请先解锁再移入"));}
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn disabled_reason(session:&Session,id:&str)->Option<String> {
    if id.starts_with("layer.arrange.") {
        return check(session,id,&Value::Null).err().map(|error| match error {EditorError::CommandFailed{message,..}=>message,_=>unreachable!()});
    }
    if id=="edit.transform" && session.active().is_some_and(|state|crate::layer_preview::transform_targets(state).iter().any(|id|photocraft_engine::transform_cmds::locked_for_transform(&state.doc,*id))) {
        return Some("所选图层包含锁定位置的图层，请先解锁".into());
    }
    None
}
