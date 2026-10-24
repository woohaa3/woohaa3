//! 栅格化先检查完整目标，在scratch执行后只发布一步文档历史。
use photocraft_doc::{LayerContent,LayerId};
use photocraft_engine::Session;
use serde_json::{Value,json};
use crate::{EditorError,Result};

pub const IDS:&[&str]=&["layer.rasterize.type","layer.rasterize.allLayers","type.rasterizeTypeLayer"];
fn fail(id:&str,message:impl std::fmt::Display)->EditorError{EditorError::CommandFailed{id:id.into(),message:message.to_string()}}
fn targets(session:&Session,id:&str,params:&Value)->Result<Vec<LayerId>>{
    let base=session.active().ok_or(EditorError::NoDocument)?;
    let empty=serde_json::Map::new();let fields=if params.is_null(){&empty}else{params.as_object().ok_or_else(||fail(id,"栅格化参数必须为对象"))?};
    if fields.keys().any(|key|id=="layer.rasterize.allLayers" || key!="layer"){return Err(fail(id,"栅格化只接受可选图层编号，全部图层不接受参数"));}
    let ids=if id=="layer.rasterize.allLayers" {base.doc.walk().into_iter().map(|(_,_,layer)|layer.id).collect()}
      else if let Some(layer)=fields.get("layer"){vec![LayerId(layer.as_u64().filter(|n|*n>0).ok_or_else(||fail(id,"图层编号无效"))?)]}
      else if id=="type.rasterizeTypeLayer" {vec![base.active_layer.ok_or_else(||fail(id,"请先选择文字图层"))?]}
      else {base.selected_layers()};
    let mut result=Vec::new();
    for target in ids {
        let layer=base.doc.layer(target).ok_or_else(||fail(id,"图层不存在"))?;
        let affected=if id=="layer.rasterize.allLayers"{matches!(layer.content,LayerContent::Text(_)|LayerContent::Shape(_)|LayerContent::Fill(_)|LayerContent::Smart(_)) || layer.vector_mask.is_some()}else{matches!(layer.content,LayerContent::Text(_))};
        if !affected{continue;}
        let locks=base.doc.effective_locks(target);if locks.all || locks.pixels{return Err(fail(id,"目标或父组锁定像素，请先解锁再栅格化"));}
        result.push(target);
    }
    Ok(result)
}
pub fn disabled_reason(session:&Session,id:&str)->Option<String>{
    if !IDS.contains(&id){return None;}
    if session.active_job().is_some(){return Some("文档后台任务尚未结束".into());}
    match targets(session,id,&Value::Null){Ok(ids) if ids.is_empty()=>Some("没有可栅格化的图层".into()),Err(error)=>Some(error.to_string()),_=>None}
}
pub fn execute(session:&mut Session,id:&str,params:Value)->Result<Value>{
    if session.active_job().is_some(){return Err(fail(id,"文档后台任务尚未结束"));}
    let ids=targets(session,id,&params)?;
    if ids.is_empty(){return Err(fail(id,"没有可栅格化的图层"));}
    let base=session.active().ok_or(EditorError::NoDocument)?.clone();
    // 按最保守16B/像素计算候选与矢量蒙版预算，不触发正式文档的缓存更新。
    let pixels=u64::from(base.doc.size.width)*u64::from(base.doc.size.height);
    let mut total=0u64;
    for target in &ids {
        let layer=base.doc.layer(*target).unwrap();let mut layer_pixels=pixels;
        if let LayerContent::Text(text)=&layer.content {
            if let Some([x0,y0,x1,y1])=photocraft_text::shared().lock().unwrap_or_else(|e|e.into_inner()).layout(text,base.doc.resolution_dpi).bounds(){
                let m=text.transform.m;let scale=m[0].abs().max(m[1].abs()).max(m[2].abs()).max(m[3].abs()).max(1.0);
                let w=(f64::from(x1-x0).abs()+4.0)*scale;let h=(f64::from(y1-y0).abs()+4.0)*scale;
                if !w.is_finite() || !h.is_finite() || w>8192.0 || h>8192.0{return Err(fail(id,"文字栅格化边界超过8192像素上限"));}
                layer_pixels=layer_pixels.max((w.ceil()*h.ceil()) as u64);
            }
        }
        let surfaces=if id=="layer.rasterize.allLayers" && layer.vector_mask.is_some(){2}else{1};
        total=total.saturating_add(layer_pixels.saturating_mul(16*surfaces));
        if total>256*1024*1024{return Err(fail(id,"栅格化候选超过256MiB预算，请分批处理或缩小文档"));}
    }
    let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=session.prefs().clone());scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
    if id=="layer.rasterize.allLayers"{scratch.execute(id,json!({})).map_err(|error|fail(id,error))?;}
    else {for target in &ids {scratch.execute("type.rasterize",json!({"layer":target.0})).map_err(|error|fail(id,error))?;}}
    let candidate=scratch.active().unwrap();
    crate::preview_history::commit_selected(session,candidate.doc.clone(),base.active_layer,base.selected_layers(),"栅格化图层").map_err(|error|fail(id,error))?;
    session.active_mut().unwrap().layer_anchor=base.layer_anchor;
    Ok(json!({"rasterized":ids.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Document,Layer,Size,ColorMode,SampleType};
    use std::sync::Arc;
    fn fixture()->Session {
        let mut session=Session::new();session.add_document(Document::new("栅格化",Size::new(32,24),ColorMode::Rgb,SampleType::U8),None);
        for text in ["A","B"] {session.execute("type.create",json!({"x":2,"y":12,"text":text,"font":"Inter","size":8})).unwrap();}
        session.execute("layer.newFillLayer.solidColor",json!({"color":"#336699"})).unwrap();
        let state=session.active_mut().unwrap();let document=Arc::make_mut(&mut state.doc);let children=std::mem::take(&mut document.layers);let group=Layer::group("保留结构",children);let group_id=group.id;
        let text_ids=group.children().unwrap().iter().filter(|layer|matches!(layer.content,LayerContent::Text(_))).map(|layer|layer.id).collect::<Vec<_>>();document.layers=vec![group];
        state.active_layer=text_ids.first().copied();state.selected_layers=text_ids;state.layer_anchor=Some(group_id);
        session
    }
    #[test]
    fn rasterize_all_preserves_tree_metadata_selection_and_one_history_revision() {
        let mut session=fixture();let before=session.active().unwrap().clone();let ids=before.doc.walk().iter().map(|(_,_,layer)|layer.id).collect::<Vec<_>>();
        let result=execute(&mut session,"layer.rasterize.allLayers",Value::Null).unwrap();assert_eq!(result["rasterized"],3);
        let after=session.active().unwrap().clone();assert_eq!(after.history.past_len(),before.history.past_len()+1);assert_eq!(after.revision,before.revision+1);assert_eq!(after.active_layer,before.active_layer);assert_eq!(after.selected_layers(),before.selected_layers());
        assert!(after.doc.layers[0].is_group());for id in ids {let old=before.doc.layer(id).unwrap();let new=after.doc.layer(id).unwrap();assert_eq!(old.name,new.name);assert_eq!(old.label,new.label);assert_eq!(old.effects,new.effects);if !old.is_group(){assert!(matches!(new.content,LayerContent::Raster(_)));}}
        session.execute("edit.undo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc,before.doc);session.execute("edit.redo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc,after.doc);
        let bytes=photocraft_format::save_to_bytes(&after.doc,&Default::default()).unwrap();let reopened=photocraft_format::load_from_bytes(&bytes).unwrap();assert!(reopened.layers[0].is_group());assert!(reopened.layers[0].children().unwrap().iter().all(|layer|matches!(layer.content,LayerContent::Raster(_))));
    }
    #[test]
    fn selected_type_only_is_atomic_strict_locked_and_budgeted() {
        let mut session=fixture();let original=session.active().unwrap().clone();let first=original.selected_layers()[0];
        for params in [json!([]),json!({"layers":[first.0]}),json!({"layer":0}),json!({"layer":"1"}),json!({"unknown":true})]{assert!(execute(&mut session,"layer.rasterize.type",params).is_err());assert_eq!(session.active().unwrap().doc,original.doc);assert_eq!(session.active().unwrap().revision,original.revision);}
        assert!(execute(&mut session,"layer.rasterize.allLayers",json!({"layer":first.0})).is_err());
        Arc::make_mut(&mut session.active_mut().unwrap().doc).layers[0].locks.all=true;let locked=session.active().unwrap().clone();assert!(disabled_reason(&session,"layer.rasterize.allLayers").is_some());assert!(execute(&mut session,"layer.rasterize.type",Value::Null).is_err());assert_eq!(session.active().unwrap().doc,locked.doc);assert_eq!(session.active().unwrap().revision,locked.revision);
        *session.active_mut().unwrap()=original.clone();assert_eq!(execute(&mut session,"type.rasterizeTypeLayer",Value::Null).unwrap()["rasterized"],1);assert!(matches!(session.active().unwrap().doc.layer(first).unwrap().content,LayerContent::Raster(_)));
        *session.active_mut().unwrap()=original.clone();assert_eq!(execute(&mut session,"layer.rasterize.type",Value::Null).unwrap()["rasterized"],2);assert!(session.active().unwrap().doc.walk().iter().any(|(_,_,layer)|matches!(layer.content,LayerContent::Fill(_))));
        *session.active_mut().unwrap()=original;Arc::make_mut(&mut session.active_mut().unwrap().doc).size=Size::new(8192,8192);let large=session.active().unwrap().clone();assert!(execute(&mut session,"layer.rasterize.allLayers",Value::Null).is_err());assert_eq!(session.active().unwrap().revision,large.revision);assert_eq!(session.active().unwrap().doc,large.doc);
    }
}
