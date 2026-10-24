//! 批量清理在完整候选树上预检锁定、最后一层和剪贴基底，再发布一步历史。
use photocraft_doc::{Document,Layer,LayerContent,LayerId};
use photocraft_engine::Session;
use serde_json::{json,Value};
use crate::error::{EditorError,Result};
pub(crate) const IDS:&[&str]=&["layer.delete.hiddenLayers","file.scripts.deleteAllEmptyLayers"];
fn error(id:&str,message:&str)->EditorError {EditorError::CommandFailed{id:id.into(),message:message.into()}}
fn empty(layer:&Layer)->bool {
    match &layer.content {
        LayerContent::Raster(surface)=>surface.content_bounds().is_empty() && layer.mask.is_none() && layer.effects.items.is_empty(),
        LayerContent::Group(group)=>group.children.iter().all(empty),
        _=>false,
    }
}
fn candidate(session:&Session,id:&str)->Result<(Document,usize)> {
    let state=session.active().ok_or(EditorError::NoDocument)?;
    fn prune(layers:&[Layer],hidden:bool)->Vec<Layer> {
        let mut base_survives=false;
        let mut output=Vec::new();
        for source in layers {
            let remove=if hidden {!source.visible} else {empty(source)};
            if !source.clipped {base_survives=!remove;}
            if remove {continue;}
            let mut layer=source.clone();layer.clipped &= base_survives;
            if let Some(children)=layer.children_mut() {*children=prune(children,hidden);}
            output.push(layer);
        }
        output
    }
    let mut next=(*state.doc).clone();next.layers=prune(&next.layers,id=="layer.delete.hiddenLayers");
    let removed=state.doc.walk().into_iter().filter(|(_,_,layer)|next.layer(layer.id).is_none()).map(|(_,_,layer)|layer.id).collect::<Vec<_>>();
    if removed.is_empty() {return Err(error(id,if id=="layer.delete.hiddenLayers" {"没有隐藏图层"} else {"没有可删除的空图层"}));}
    if next.layers.is_empty() {return Err(error(id,"文档至少需要保留一个图层"));}
    // 基底被删除后幸存剪贴层也会改变关系，因此它们同样纳入锁定预检。
    if removed.iter().any(|id|state.doc.effective_locks(*id).all) || state.doc.walk().iter().any(|(_,_,layer)|next.layer(layer.id).is_some_and(|next|layer.clipped!=next.clipped) && state.doc.effective_locks(layer.id).all) {return Err(error(id,"清理范围包含全部锁定的图层或剪贴关系，请先解锁"));}
    Ok((next,removed.len()))
}
pub(crate) fn disabled_reason(session:&Session,id:&str)->Option<String> {
    if !IDS.contains(&id) {return None;}candidate(session,id).err().map(|err|err.to_string())
}
pub(crate) fn execute(session:&mut Session,id:&str,params:&Value)->Result<Value> {
    if !params.is_null() && !params.as_object().is_some_and(|fields|fields.is_empty()) {return Err(error(id,"批量清理不接受参数"));}
    let (next,count)=candidate(session,id)?;let state=session.active().unwrap();
    let active=state.active_layer.filter(|id|next.layer(*id).is_some()).or_else(||next.top_layer());
    let mut selected:Vec<LayerId>=state.selected_layers().into_iter().filter(|id|next.layer(*id).is_some()).collect();if selected.is_empty() {selected.extend(active);}
    crate::preview_history::commit_selected(session,std::sync::Arc::new(next),active,selected,if id=="layer.delete.hiddenLayers" {"删除隐藏图层"} else {"删除全部空图层"}).map_err(|err|error(id,&err.to_string()))?;
    Ok(json!({"deleted":count}))
}
