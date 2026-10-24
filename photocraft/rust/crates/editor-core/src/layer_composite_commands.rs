//! 合成与去边命令先校验完整目标，再在候选会话执行，一次发布与撤销。
use photocraft_engine::Session;
use photocraft_doc::{LayerContent,LayerId};
use serde_json::Value;
use crate::error::{EditorError,Result};
pub(crate) const IDS:&[&str]=&["layer.stampVisible","layer.stampDown","layer.new.backgroundFromLayer","layer.matting.defringe","layer.matting.colorDecontaminate","layer.matting.removeBlackMatte","layer.matting.removeWhiteMatte"];
fn fail(id:&str,message:impl std::fmt::Display)->EditorError{EditorError::CommandFailed{id:id.into(),message:message.to_string()}}
pub(crate) fn check(session:&Session,id:&str,params:&Value)->Result<()> {
    let fields=if params.is_null(){None}else{Some(params.as_object().ok_or_else(||fail(id,"参数必须为对象"))?)};
    let background=id=="layer.new.backgroundFromLayer";
    if fields.is_some_and(|fields|fields.keys().any(|key| !(background && key=="layer" || id=="layer.matting.defringe" && key=="width" || id=="layer.matting.colorDecontaminate" && ["amount","radius"].contains(&key.as_str())))) {return Err(fail(id,"命令包含未开放的参数"));}
    if params.get("width").is_some_and(|v|v.as_u64().is_none_or(|width|!(1..=200).contains(&width))) {return Err(fail(id,"去边宽度必须为1–200整数像素"));}
    if params.get("amount").is_some_and(|v|v.as_f64().is_none_or(|v|!v.is_finite() || !(0.0..=100.0).contains(&v))) || params.get("radius").is_some_and(|v|v.as_f64().is_none_or(|v|!v.is_finite() || !(1.0..=100.0).contains(&v))) {return Err(fail(id,"颜色净化数量须为0–100%，半径须为1–100像素"));}
    if params.get("layer").is_some_and(|v|v.as_u64().is_none()) {return Err(fail(id,"图层编号无效"));}
    let state=session.active().ok_or(EditorError::NoDocument)?;
    let target=params["layer"].as_u64().map(LayerId).or(state.active_layer);
    let roots=crate::layer_preview::selected_roots(state);
    let adds_layer=id=="layer.stampVisible" || id=="layer.stampDown" && roots.len()>1;
    if adds_layer && crate::layer_preview::layer_count(&state.doc.layers)>=photocraft_project_verify::MAX_LAYERS {return Err(fail(id,"图层数量达到上限，无法新增盖印层"));}
    if id=="layer.stampVisible" {
        if !state.doc.walk().iter().any(|(path,_,layer)|!layer.is_group() && (1..=path.len()).all(|n|state.doc.layer_at(&path[..n]).is_some_and(|l|l.visible))) {return Err(fail(id,"没有可见图层可盖印"));}
        return Ok(());
    }
    let target=target.ok_or_else(||fail(id,"请先选择图层"))?;
    let layer=state.doc.layer(target).ok_or_else(||fail(id,"目标图层不存在"))?;
    if crate::layer_preview::mask_target(state) {return Err(fail(id,"请先切换到图层内容"));}
    if background {
        if state.doc.background().is_some(){return Err(fail(id,"文档已存在背景图层"));}
        let locks=state.doc.effective_locks(target);
        if locks.all || locks.pixels || locks.position {return Err(fail(id,"目标图层已锁定，无法转为背景"));}
        if matches!(layer.content,LayerContent::Group(_)|LayerContent::Adjustment(_)) {return Err(fail(id,"组和调整层不能转为背景"));}
        let path=state.doc.path_of(target).ok_or_else(||fail(id,"目标图层不存在"))?;
        let siblings=if path.len()==1 {&state.doc.layers} else {state.doc.layer_at(&path[..path.len()-1]).and_then(|l|if let LayerContent::Group(children)=&l.content {Some(&children.children)}else{None}).ok_or_else(||fail(id,"父组不存在"))?};
        let index=*path.last().unwrap();
        if layer.clipped || siblings.get(index+1).is_some_and(|layer|layer.clipped) {return Err(fail(id,"请先释放相关剪贴链，再创建背景"));}
    } else if id.starts_with("layer.matting.") {
        crate::layer_preview::require_visible(state,&[target],id)?;
        if !matches!(layer.content,LayerContent::Raster(_)){return Err(fail(id,"去边只支持像素图层"));}
        let locks=state.doc.effective_locks(target);
        if locks.all || locks.pixels {return Err(fail(id,"像素已锁定，无法去边"));}
    } else if id=="layer.stampDown" && !adds_layer {
        crate::layer_preview::require_visible(state,&[target],id)?;
        let path=state.doc.path_of(target).ok_or_else(||fail(id,"目标图层不存在"))?;
        let mut below=path.clone();let last=below.last_mut().unwrap();if *last==0{return Err(fail(id,"下方没有可接收盖印的像素图层"));}*last-=1;
        let lower=state.doc.layer_at(&below).ok_or_else(||fail(id,"下方图层不存在"))?;
        let locks=state.doc.effective_locks(lower.id);
        if locks.all || locks.pixels || !matches!(lower.content,LayerContent::Raster(_)){return Err(fail(id,"下方图层不是可编辑的像素图层"));}
    }
    Ok(())
}
pub(crate) fn disabled_reason(session:&Session,id:&str)->Option<String>{if IDS.contains(&id){check(session,id,&Value::Null).err().map(|e|e.to_string())}else{None}}
pub(crate) fn execute(session:&mut Session,id:&str,params:Value)->Result<Value>{
    check(session,id,&params)?;
    let base=session.active().ok_or(EditorError::NoDocument)?.clone();
    let mut scratch=Session::new();scratch.tools=session.tools.clone();scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
    let result=scratch.execute(id,params).map_err(|e|fail(id,e))?;
    let after=scratch.active_mut().ok_or(EditorError::NoDocument)?;
    // 烘焙像素不会丢失仍保留同一id的颜色标签与链接身份。
    let document=std::sync::Arc::make_mut(&mut after.doc);
    for (_,_,original) in base.doc.walk() {if let Some(layer)=document.layer_mut(original.id) {layer.label=original.label;layer.link_group=original.link_group;}}
    if after.doc!=base.doc {crate::preview_history::commit_selected(session,after.doc.clone(),after.active_layer,after.selected_layers(),id).map_err(|e|fail(id,e))?;}
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::*;
    use serde_json::json;
    use std::sync::Arc;
    fn fixture()->Session {
        let mut doc=Document::new("去边",Size::new(12,12),ColorMode::Rgb,SampleType::U8);
        let mut layer=Layer::raster("源",doc.pixel_format());layer.surface_mut().unwrap().write_pixel(3,3,&[0.25,0.1,0.,0.5]);doc.layers=vec![layer];
        let mut session=Session::new();session.add_document(doc,None);session
    }
    #[test]
    fn matting_is_strict_keeps_alpha_and_has_one_undo_without_rendering() {
        for id in ["layer.matting.removeBlackMatte","layer.matting.removeWhiteMatte","layer.matting.defringe","layer.matting.colorDecontaminate"] {
            let mut session=fixture();let before=session.active().unwrap().clone();
            execute(&mut session,id,Value::Null).unwrap();let after=session.active().unwrap().clone();
            let id=after.active_layer.unwrap();let alpha=|state:&photocraft_engine::DocState|state.doc.layer(id).unwrap().surface().unwrap().sample_channel(3,3,3);
            assert!((alpha(&after)-alpha(&before)).abs()<0.01);
            if after.doc!=before.doc {assert_eq!(after.history.past_len(),before.history.past_len()+1);session.execute("edit.undo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc,before.doc);session.execute("edit.redo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc,after.doc);}
        }
        let mut session=fixture();let before=session.active().unwrap().clone();
        for bad in [json!({"width":0}),json!({"width":201}),json!({"width":1.5}),json!({"width":"1"}),json!({"layer":1}),json!([])] {assert!(execute(&mut session,"layer.matting.defringe",bad).is_err());}
        assert_eq!(session.active().unwrap().doc,before.doc);assert_eq!(session.active().unwrap().history.past_len(),before.history.past_len());
        let state=session.active_mut().unwrap();Arc::make_mut(&mut state.doc).layers[0].locks.pixels=true;
        assert!(execute(&mut session,"layer.matting.removeBlackMatte",Value::Null).is_err());
    }
    #[test]
    fn composite_rejections_precede_rendering_and_preserve_source_history() {
        let mut session=fixture();let state=session.active_mut().unwrap();
        Arc::make_mut(&mut state.doc).layers[0].locks.all=true;
        let before=session.active().unwrap().clone();assert!(execute(&mut session,"layer.new.backgroundFromLayer",Value::Null).is_err());assert_eq!(session.active().unwrap().doc,before.doc);
        for id in IDS {assert!(execute(&mut session,id,json!({"unknown":true})).is_err());}
        let state=session.active_mut().unwrap();let doc=Arc::make_mut(&mut state.doc);
        while doc.layers.len()<64 {doc.layers.push(Layer::raster("空",doc.pixel_format()));}
        state.active_layer=Some(doc.layers[63].id);state.selected_layers=vec![doc.layers[62].id,doc.layers[63].id];
        let before=state.clone();
        for id in ["layer.stampVisible","layer.stampDown"] {assert!(execute(&mut session,id,Value::Null).is_err());assert_eq!(session.active().unwrap().doc,before.doc);assert_eq!(session.active().unwrap().history.past_len(),before.history.past_len());}
    }
}
