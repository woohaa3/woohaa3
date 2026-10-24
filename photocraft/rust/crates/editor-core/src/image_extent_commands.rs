//! Trim/Reveal All：合成/平移前检查资源，独立会话成功后原子发布。
use crate::error::{EditorError,Result};
use photocraft_engine::Session;
use serde_json::Value;
pub(crate) const IDS:&[&str]=&["image.trim","image.revealAll"];
fn fail(id:&str,message:impl std::fmt::Display)->EditorError{EditorError::CommandFailed{id:id.into(),message:message.to_string()}}
pub(crate) fn execute(session:&mut Session,id:&str,params:Value)->Result<Value>{
    let empty=serde_json::Map::new();let fields=if params.is_null(){&empty}else{params.as_object().ok_or_else(||fail(id,"参数必须为对象"))?};
    if id=="image.trim" {
        if fields.keys().any(|key|!["basedOn","top","bottom","left","right"].contains(&key.as_str())){return Err(fail(id,"修整包含未开放参数"));}
        if params.get("basedOn").is_some_and(|v|!matches!(v.as_str(),Some("transparent"|"topLeft"|"bottomRight"))){return Err(fail(id,"请选择透明像素、左上角或右下角颜色"));}
        for key in ["top","bottom","left","right"]{if params.get(key).is_some_and(|v|!v.is_boolean()){return Err(fail(id,"修整四边开关必须为布尔值"));}}
    }else if !fields.is_empty(){return Err(fail(id,"显示全部不接受参数"));}
    if session.active_job().is_some(){return Err(fail(id,"文档后台任务尚未结束"));}
    let base=session.active().ok_or(EditorError::NoDocument)?.clone();
    let expected=if id=="image.revealAll"{photocraft_engine::extra_cmds::reveal_all_bounds(&base.doc)}else{base.doc.bounds()};
    if expected.width()>8192 || expected.height()>8192 || expected.is_empty(){return Err(fail(id,"结果画布超过8192像素上限"));}
    // Trim需要完整f32合成；Reveal仅平移，仍为背景扩展/像素重铺预留完整tile预算。
    let mut bytes=if id=="image.trim"{u64::from(base.doc.size.width)*u64::from(base.doc.size.height)*64}else{0};
    let mut account=|surface:&photocraft_raster::Surface,background:bool|{
        let area=if background{surface.content_bounds().union(&expected)}else{surface.content_bounds()};
        bytes=bytes.saturating_add((area.width() as u64).div_ceil(256).saturating_mul((area.height() as u64).div_ceil(256)).saturating_mul(256*256*surface.format().bytes_per_pixel() as u64*2));
    };
    for (_,_,layer) in base.doc.walk(){
        if let Some(surface)=layer.surface(){account(surface,base.doc.is_background(layer.id));}
        if let Some(mask)=&layer.mask{account(&mask.surface,false);}
        if let Some(cache)=&layer.fill_cache{account(&cache.surface,false);}
    }
    for channel in base.doc.channels.iter().chain(base.doc.quick_mask.as_ref()){account(&channel.surface,false);}
    if let Some(selection)=&base.doc.selection{account(selection,false);}
    if bytes>256*1024*1024{return Err(fail(id,"修整/扩展候选超过256MiB预算，请减小文档或图层数量"));}
    let mut scratch=Session::new();scratch.tools=session.tools.clone();scratch.edit_prefs(|prefs|*prefs=session.prefs().clone());scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
    let result=scratch.execute(id,params).map_err(|error|fail(id,error))?;let after=scratch.active().unwrap();
    if after.doc.size.width>8192 || after.doc.size.height>8192{return Err(fail(id,"结果画布超过预算，未应用"));}
    if after.doc!=base.doc{crate::preview_history::commit_selected(session,after.doc.clone(),after.active_layer,after.selected_layers(),if id=="image.trim"{"修整"}else{"显示全部"}).map_err(|error|fail(id,error))?;session.active_mut().unwrap().layer_anchor=base.layer_anchor;}
    Ok(result)
}
#[cfg(test)]
mod tests{
    use super::*;
    use photocraft_doc::*;
    use serde_json::json;
    fn fixture()->Session{
        let mut doc=Document::new("边界",Size::new(12,8),ColorMode::Rgb,SampleType::U8);let mut layer=Layer::raster("像素",doc.pixel_format());layer.surface_mut().unwrap().fill_rect(photocraft_geom::Rect::new(2,1,8,6),&[1.,0.,0.,1.]);doc.layers.push(layer);let mut s=Session::new();s.add_document(doc,None);s
    }
    #[test]
    fn trim_sides_pixel_deletion_history_roundtrip_and_noop(){
        let mut s=fixture();let before=s.active().unwrap().clone();
        let result=execute(&mut s,IDS[0],json!({"left":false,"bottom":false})).unwrap();assert_eq!(result,json!({"x":0,"y":1,"width":8,"height":7}));let after=s.active().unwrap().clone();assert_eq!(after.doc.size,Size::new(8,7));assert_eq!(after.doc.layers[0].surface().unwrap().rgba(2,0),[1.,0.,0.,1.]);assert_eq!(after.history.past_len(),before.history.past_len()+1);
        s.execute("edit.undo",json!({})).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);s.execute("edit.redo",json!({})).unwrap();assert_eq!(s.active().unwrap().doc,after.doc);
        execute(&mut s,IDS[0],json!({"top":false,"left":false,"right":false,"bottom":false})).unwrap();assert_eq!(s.active().unwrap().history.past_len(),after.history.past_len());
        execute(&mut s,IDS[0],Value::Null).unwrap();assert_eq!(s.active().unwrap().doc.size,Size::new(6,5));
        assert_eq!(execute(&mut s,IDS[1],Value::Null).unwrap()["changed"],false);
        let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
    }
    #[test]
    fn corner_colors_and_reveal_off_canvas_pixels_are_native(){
        for based in ["topLeft","bottomRight"]{
            let mut s=fixture();let doc=std::sync::Arc::make_mut(&mut s.active_mut().unwrap().doc);let bounds=doc.bounds();let surface=doc.layers[0].surface_mut().unwrap();surface.fill_rect(bounds,&[1.,1.,1.,1.]);surface.fill_rect(photocraft_geom::Rect::new(2,1,8,6),&[1.,0.,0.,1.]);
            execute(&mut s,IDS[0],json!({"basedOn":based})).unwrap();assert_eq!(s.active().unwrap().doc.size,Size::new(6,5));
        }
        let mut s=fixture();std::sync::Arc::make_mut(&mut s.active_mut().unwrap().doc).layers[0].surface_mut().unwrap().write_pixel(-3,10,&[0.,1.,0.,1.]);let before=s.active().unwrap().clone();
        assert_eq!(execute(&mut s,IDS[1],json!({})).unwrap()["changed"],true);let after=s.active().unwrap().clone();assert_eq!(after.doc.size,Size::new(15,11));assert_eq!(after.doc.layers[0].surface().unwrap().rgba(0,10),[0.,1.,0.,1.]);assert_eq!(after.history.past_len(),before.history.past_len()+1);
        assert_eq!(execute(&mut s,IDS[1],Value::Null).unwrap()["changed"],false);assert_eq!(s.active().unwrap().history.past_len(),after.history.past_len());s.execute("edit.undo",json!({})).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);
    }
    #[test]
    fn strict_params_empty_and_budget_failures_do_not_publish(){
        let mut s=fixture();let before=s.active().unwrap().clone();
        for p in [json!([]),json!({"basedOn":"bad"}),json!({"left":1}),json!({"extra":true})]{assert!(execute(&mut s,IDS[0],p).is_err());}
        assert!(execute(&mut s,IDS[1],json!({"left":false})).is_err());assert_eq!(s.active().unwrap().doc,before.doc);
        std::sync::Arc::make_mut(&mut s.active_mut().unwrap().doc).size=Size::new(8192,8192);let large=s.active().unwrap().clone();assert!(execute(&mut s,IDS[0],Value::Null).is_err());assert_eq!(s.active().unwrap().doc,large.doc);
        *s.active_mut().unwrap()=before;std::sync::Arc::make_mut(&mut s.active_mut().unwrap().doc).layers[0].surface_mut().unwrap().write_pixel(-9000,0,&[1.,0.,0.,1.]);let wide=s.active().unwrap().clone();assert!(execute(&mut s,IDS[1],Value::Null).is_err());assert_eq!(s.active().unwrap().doc,wide.doc);
        let mut empty=Session::new();empty.execute("file.new",json!({"width":12,"height":8,"background":"transparent"})).unwrap();let source=empty.active().unwrap().clone();assert!(execute(&mut empty,IDS[0],Value::Null).is_err());assert_eq!(empty.active().unwrap().doc,source.doc);assert_eq!(empty.active().unwrap().history.past_len(),source.history.past_len());
    }
}
