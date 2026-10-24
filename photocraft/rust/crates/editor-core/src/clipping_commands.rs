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

/// 分隔线命令以两个相邻同级层作为显式目标，不受当前选择集合的菜单门禁影响。
pub(crate) const LINE_ID:&str="layer.toggleClippingAt";
pub(crate) fn line_entry(session:&Session)->Value {
    serde_json::json!({"id":LINE_ID,"label":"切换分隔线剪贴关系","menu":[],"params":"{upper:id,lower:id}","allowed":true,"enabled":session.active().is_some_and(|state|crate::layer_preview::layer_count(&state.doc.layers)>1)})
}
pub(crate) fn toggle_line(session:&mut Session,params:&Value)->Result<Value> {
    let fail=|message:&str|error(LINE_ID,message);
    let fields=params.as_object().ok_or_else(||fail("分隔线参数必须为对象"))?;
    if fields.len()!=2 || fields.keys().any(|key|key!="upper" && key!="lower") {return Err(fail("分隔线只接受 upper 和 lower 图层 id"));}
    let upper=LayerId(params["upper"].as_u64().ok_or_else(||fail("上方图层 id 无效"))?);
    let lower=LayerId(params["lower"].as_u64().ok_or_else(||fail("下方图层 id 无效"))?);
    let state=session.active().ok_or(EditorError::NoDocument)?;
    let up=state.doc.path_of(upper).ok_or_else(||fail("上方图层不存在"))?;
    let low=state.doc.path_of(lower).ok_or_else(||fail("下方图层不存在"))?;
    let (&ui,parents)=up.split_last().ok_or_else(||fail("图层路径无效"))?;
    let (&li,lower_parents)=low.split_last().ok_or_else(||fail("图层路径无效"))?;
    if parents!=lower_parents || li.checked_add(1)!=Some(ui) {return Err(fail("分隔线必须位于相邻同级图层之间"));}
    let source=state.doc.layer(upper).unwrap();
    if matches!(&source.content,photocraft_doc::LayerContent::Group(group) if group.expanded && !group.children.is_empty()) {return Err(fail("展开组的子层隔开了这条分隔线"));}
    let release=source.clipped;
    let siblings=if parents.is_empty() {&state.doc.layers[..]} else {state.doc.layer_at(parents).and_then(|layer|layer.children()).ok_or_else(||fail("父组无效"))?};
    let mut targets=vec![upper];
    if release {targets.extend(siblings[ui+1..].iter().take_while(|layer|layer.clipped).map(|layer|layer.id));}
    else if base(&state.doc,upper).is_none() {return Err(fail("下方没有可用剪贴基底"));}
    if targets.iter().any(|target|state.doc.effective_locks(*target).all) {return Err(fail("剪贴链包含锁定图层，请先解锁"));}
    let mut doc=(*state.doc).clone();for target in &targets {doc.layer_mut(*target).unwrap().clipped=!release;}
    let active=if release {Some(upper)} else {state.active_layer};
    let selected=if release {vec![upper]} else {state.selected_layers()};
    crate::preview_history::commit_selected(session,std::sync::Arc::new(doc),active,selected,if release {"释放剪贴链"} else {"创建剪贴蒙版"}).map_err(|err|error(LINE_ID,&err.to_string()))?;
    Ok(serde_json::json!({"layer":upper.0,"clipped":!release}))
}
