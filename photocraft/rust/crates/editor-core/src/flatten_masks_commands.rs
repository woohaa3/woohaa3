//! 全局蒙版烘焙：预检整个目标集合，再在独立会话发布一步历史。
use crate::error::{EditorError,Result};
use photocraft_doc::LayerContent;
use photocraft_engine::Session;
use serde_json::{json,Value};
pub(crate) const ID:&str="file.scripts.flattenAllMasks";
fn fail(message:impl std::fmt::Display)->EditorError {EditorError::CommandFailed{id:ID.into(),message:message.to_string()}}
fn preflight(session:&Session)->Result<usize> {
    if session.active_job().is_some(){return Err(fail("文档后台任务尚未结束"));}
    let state=session.active().ok_or(EditorError::NoDocument)?;
    let mut targets=0;let mut bytes=0u64;
    for (_,_,layer) in state.doc.walk() {
        if !(layer.mask.as_ref().is_some_and(|mask|mask.enabled) || layer.vector_mask.is_some()) || !matches!(layer.content,LayerContent::Raster(_)){continue;}
        let locks=state.doc.effective_locks(layer.id);
        if locks.all || locks.pixels {return Err(fail("包含像素锁定图层，请先解锁再扁平化蒙版"));}
        let area=layer.surface().unwrap().content_bounds().union(&state.doc.bounds());
        let w=area.width() as u64;let h=area.height() as u64;
        if w>8192 || h>8192 {return Err(fail("蒙版烘焙范围超过8192像素上限"));}
        // 包含f32合成、矢量遮罩/密度羽化与完整256px稀疏tile的候选上限。
        bytes=bytes.saturating_add(w.div_ceil(256).saturating_mul(h.div_ceil(256)).saturating_mul(256*256*64));
        if bytes>256*1024*1024{return Err(fail("蒙版烘焙候选超过256MiB预算，请分批应用蒙版"));}
        targets+=1;
    }
    Ok(targets)
}
pub(crate) fn disabled_reason(session:&Session,id:&str)->Option<String> {
    if id!=ID{return None;}
    preflight(session).err().map(|error|error.to_string())
}
pub(crate) fn execute(session:&mut Session,params:Value)->Result<Value> {
    if !params.is_null() && !params.as_object().is_some_and(|fields|fields.is_empty()){return Err(fail("扁平化全部蒙版不接受参数"));}
    preflight(session)?;
    let base=session.active().ok_or(EditorError::NoDocument)?.clone();
    let mut scratch=Session::new();scratch.edit_prefs(|prefs|*prefs=session.prefs().clone());
    scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
    let result=scratch.execute(ID,json!({})).map_err(fail)?;
    let candidate=scratch.active().unwrap();
    if candidate.doc!=base.doc {
        crate::preview_history::commit_selected(session,candidate.doc.clone(),base.active_layer,base.selected_layers(),"扁平化全部蒙版").map_err(fail)?;
        session.active_mut().unwrap().layer_anchor=base.layer_anchor;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::*;
    use std::sync::Arc;
    fn fixture()->Session {
        let mut s=Session::new();s.execute("file.new",json!({"width":12,"height":8,"background":"transparent"})).unwrap();
        s.execute("edit.fill",json!({"color":"#ff0000"})).unwrap();
        s.execute("select.rect",json!({"x":0,"y":0,"width":6,"height":8})).unwrap();
        s.execute("layer.layerMask.revealSelection",json!({})).unwrap();
        s
    }
    #[test]
    fn masks_bake_pixels_skip_groups_and_disabled_and_preserve_one_history() {
        let mut s=fixture();let id=s.active().unwrap().active_layer.unwrap();
        let doc=Arc::make_mut(&mut s.active_mut().unwrap().doc);let mut disabled=doc.layer(id).unwrap().clone();disabled.id=LayerId::fresh();disabled.mask.as_mut().unwrap().enabled=false;let disabled_id=disabled.id;
        let mut group=Layer::group("组",vec![doc.layers.remove(0),disabled]);group.mask=group.children().unwrap()[0].mask.clone();doc.layers.push(group);
        let base=s.active().unwrap().clone();let result=execute(&mut s,json!({})).unwrap();assert_eq!(result,json!({"flattened":1,"skipped":1}));
        let after=s.active().unwrap().clone();let raster=after.doc.layer(id).unwrap();assert!(raster.mask.is_none());assert_eq!(raster.surface().unwrap().rgba(2,2),[1.,0.,0.,1.]);assert_eq!(raster.surface().unwrap().rgba(8,2)[3],0.);
        assert_eq!(after.doc.layer(disabled_id),base.doc.layer(disabled_id));assert_eq!(after.doc.layers[0].mask,base.doc.layers[0].mask);
        assert_eq!(after.active_layer,base.active_layer);assert_eq!(after.selected_layers(),base.selected_layers());assert_eq!(after.doc.selection,base.doc.selection);assert_eq!(after.history.past_len(),base.history.past_len()+1);
        s.execute("edit.undo",json!({})).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);s.execute("edit.redo",json!({})).unwrap();assert_eq!(s.active().unwrap().doc,after.doc);
        execute(&mut s,Value::Null).unwrap();assert_eq!(s.active().unwrap().history.past_len(),after.history.past_len());
        let bytes=photocraft_format::save_to_bytes(&after.doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
    }
    #[test]
    fn entire_set_rejects_locked_invalid_or_over_budget_before_writes() {
        let mut s=fixture();let base=s.active().unwrap().clone();
        assert!(execute(&mut s,json!({"layer":1})).is_err());assert_eq!(s.active().unwrap().doc,base.doc);
        Arc::make_mut(&mut s.active_mut().unwrap().doc).layers[0].locks.pixels=true;let locked=s.active().unwrap().clone();
        assert!(disabled_reason(&s,ID).is_some());assert!(execute(&mut s,Value::Null).is_err());assert_eq!(s.active().unwrap().doc,locked.doc);assert_eq!(s.active().unwrap().history.past_len(),locked.history.past_len());
        *s.active_mut().unwrap()=base;Arc::make_mut(&mut s.active_mut().unwrap().doc).size=Size::new(8192,8192);let large=s.active().unwrap().clone();
        assert!(execute(&mut s,json!({})).is_err());assert_eq!(s.active().unwrap().doc,large.doc);assert_eq!(s.active().unwrap().revision,large.revision);
    }
}
