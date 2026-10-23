//! 剪贴关系由上游文档持有；宿主只校验参数、基底和锁定。
use photocraft_doc::{Document, LayerId};
use photocraft_engine::Session;
use serde_json::Value;
use crate::error::{EditorError,Result};

fn dedicated(id:&str)->bool { matches!(id,"layer.createClippingMask"|"layer.releaseClippingMask") }

/// 最近的未剪贴下方同级层；只读树结构，不进行像素命中或合成。
fn base(doc:&Document,id:LayerId)->Option<LayerId> {
    let path=doc.path_of(id)?;
    let (&index,parent)=path.split_last()?;
    let siblings=if parent.is_empty() {&doc.layers[..]} else {doc.layer_at(parent)?.children()?};
    siblings[..index].iter().rev().find(|layer|!layer.clipped).map(|layer|layer.id)
}

pub(crate) fn check(session:&Session,id:&str,params:&Value)->Result<()> {
    let clip=match id {
        "layer.createClippingMask"=>true,
        "layer.releaseClippingMask"=>false,
        "layer.setProps"=>match params.get("clipped") {
            None=>return Ok(()),
            Some(value)=>value.as_bool().ok_or_else(||error(id,"剪贴状态必须为布尔值"))?,
        },
        _=>return Ok(()),
    };
    if dedicated(id) && !params.is_null() {
        let fields=params.as_object().ok_or_else(||error(id,"剪贴参数必须为对象"))?;
        if fields.keys().any(|key|key!="layer") {return Err(error(id,"剪贴命令只接受可选 layer 参数，未指定时使用所选集合"));}
    }
    let state=session.active().ok_or(EditorError::NoDocument)?;
    let targets=if let Some(value)=params.get("layer") {
        vec![LayerId(value.as_u64().ok_or_else(||error(id,"图层 id 必须为非负整数"))?)]
    } else if id=="layer.setProps" {
        state.active_layer.into_iter().collect()
    } else {
        let mut selected=state.selected_layers();
        // 上游批量创建仅修改最低层以上的所选层，最低层保留为基底。
        if clip && selected.len()>1 {selected.remove(0);}
        selected
    };
    if targets.is_empty() {return Err(error(id,"请先选择图层"));}
    let mut changed=false;
    for target in targets {
        let layer=state.doc.layer(target).ok_or_else(||error(id,"图层不存在"))?;
        if state.doc.effective_locks(target).all {return Err(error(id,"目标图层已全部锁定，请先解锁再修改剪贴关系"));}
        if clip && base(&state.doc,target).is_none() {return Err(error(id,"下方没有可用基底，无法创建剪贴蒙版"));}
        changed |= layer.clipped != clip;
    }
    if dedicated(id) && !changed {return Err(error(id,if clip {"所选目标已经创建剪贴蒙版"} else {"所选图层没有可释放的剪贴蒙版"}));}
    Ok(())
}

pub(crate) fn disabled_reason(session:&Session,id:&str)->Option<String> {
    if !dedicated(id) {return None;}
    check(session,id,&Value::Null).err().map(|err|match err {
        EditorError::CommandFailed{message,..}=>message,
        _=>err.to_string(),
    })
}
fn error(id:&str,message:&str)->EditorError {EditorError::CommandFailed{id:id.into(),message:message.into()}}
