//! 画布几何命令：先校验目标尺寸，再在独立会话执行，失败不污染正式文档。
use photocraft_doc::Size;
use photocraft_engine::Session;
use serde_json::Value;
use crate::error::{EditorError,Result};
pub(crate) const IDS:&[&str]=&["image.canvasSize","image.rotation.arbitrary","image.imageSize","file.automate.fitImage"];
const ANCHORS:&[&str]=&["topLeft","top","topRight","left","center","right","bottomLeft","bottom","bottomRight"];
fn fail(id:&str,message:impl std::fmt::Display)->EditorError {EditorError::CommandFailed{id:id.into(),message:message.to_string()}}
fn number(p:&Value,key:&str,default:f64,id:&str)->Result<f64> {match p.get(key) {None=>Ok(default),Some(v)=>v.as_f64().filter(|n|n.is_finite()).ok_or_else(||fail(id,format!("{key} 必须为有限数值")))}}
fn dimensions(id:&str,w:f64,h:f64)->Result<Size> {
    if w.fract()!=0.0 || h.fract()!=0.0 || !(1.0..=8192.0).contains(&w) || !(1.0..=8192.0).contains(&h) || w*h>67_108_864.0 {return Err(fail(id,"结果画布须为 1–8192 整数像素，且不超过 67108864 像素"));}
    Ok(Size::new(w as u32,h as u32))
}
pub(crate) fn check(s:&Session,id:&str,p:&Value)->Result<Size> {
    let fields=p.as_object().ok_or_else(||fail(id,"参数必须为对象"))?;
    let old=s.active().ok_or(EditorError::NoDocument)?.doc.size;
    if id=="file.automate.fitImage" {
        if fields.keys().any(|k|!["width","height","dontEnlarge","resample"].contains(&k.as_str())) {return Err(fail(id,"适合图像包含未开放的参数"));}
        let w=number(p,"width",old.width as f64,id)?;
        let h=number(p,"height",old.height as f64,id)?;
        dimensions(id,w,h)?;
        if p.get("dontEnlarge").is_some_and(|v|!v.is_boolean()) {return Err(fail(id,"dontEnlarge 必须为布尔值"));}
        if p.get("resample").is_some_and(|v|!matches!(v.as_str(),Some("bicubic"|"nearest"|"bilinear"|"bicubicSmoother"|"bicubicSharper"|"lanczos"|"automatic"|"preserveDetails"))) {return Err(fail(id,"重采样方法无效"));}
        let k=(w/old.width as f64).min(h/old.height as f64);
        if k>1.0 && p["dontEnlarge"]==true {return Ok(old);}
        return dimensions(id,(old.width as f64*k).round().max(1.0),(old.height as f64*k).round().max(1.0));
    }
    if id=="image.canvasSize" {
        if fields.keys().any(|k|!["width","height","relative","anchor","extensionColor"].contains(&k.as_str())) {return Err(fail(id,"画布尺寸包含未开放的参数"));}
        let relative=match p.get("relative") {None=>false,Some(Value::Bool(b))=>*b,_=>return Err(fail(id,"relative 必须为布尔值"))};
        let w=number(p,"width",if relative {0.0}else{old.width as f64},id)?;
        let h=number(p,"height",if relative {0.0}else{old.height as f64},id)?;
        if w.fract()!=0.0 || h.fract()!=0.0 {return Err(fail(id,"宽高须为整数像素"));}
        if p.get("anchor").is_some_and(|v|v.as_str().is_none_or(|s|!ANCHORS.contains(&s))) {return Err(fail(id,"请选择九宫格中的锚点"));}
        if p.get("extensionColor").is_some_and(|v|v.as_str().is_none_or(|s|!["foreground","background","white","black","transparent"].contains(&s) && !(s.len()==7 && s.starts_with('#') && s[1..].bytes().all(|b|b.is_ascii_hexdigit())))) {return Err(fail(id,"扩展颜色须为预设或 #RRGGBB"));}
        dimensions(id,w+if relative {old.width as f64}else{0.0},h+if relative {old.height as f64}else{0.0})
    } else if id=="image.imageSize" {
        if fields.keys().any(|k|!["width","height","percent","resolution","keepPrintSize","resample"].contains(&k.as_str())) {return Err(fail(id,"图像大小包含未开放的参数"));}
        for key in ["width","height","percent"] {if p.get(key).is_some() && number(p,key,1.0,id)?<=0.0 {return Err(fail(id,format!("{key} 必须大于零")));}}
        let dpi=number(p,"resolution",s.active().unwrap().doc.resolution_dpi as f64,id)?;
        if !(1.0..=10000.0).contains(&dpi) {return Err(fail(id,"分辨率须为 1–10000 DPI"));}
        if p.get("keepPrintSize").is_some_and(|v|!v.is_boolean()) {return Err(fail(id,"keepPrintSize 必须为布尔值"));}
        let method=p.get("resample").map(|v|v.as_str().ok_or_else(||fail(id,"重采样方法无效"))).transpose()?.unwrap_or("bicubic");
        if !["none","automatic","nearest","bilinear","bicubic","bicubicSmoother","bicubicSharper","lanczos","preserveDetails"].contains(&method) {return Err(fail(id,"重采样方法无效"));}
        if method=="none" {return Ok(old);}
        let percent=number(p,"percent",100.0,id)?;
        let mut w=p.get("width").map(|_|number(p,"width",0.0,id)).transpose()?;
        let mut h=p.get("height").map(|_|number(p,"height",0.0,id)).transpose()?;
        if p.get("percent").is_some() {w=w.or(Some(old.width as f64*percent/100.0));h=h.or(Some(old.height as f64*percent/100.0));}
        if p["keepPrintSize"]==true && w.is_none() && h.is_none() && p.get("resolution").is_some() {
            let ratio=dpi/(s.active().unwrap().doc.resolution_dpi as f64).max(1.0);w=Some(old.width as f64*ratio);h=Some(old.height as f64*ratio);
        }
        let (w,h)=match (w,h) {(Some(w),Some(h))=>(w,h),(Some(w),None)=>(w,w*old.height as f64/old.width as f64),(None,Some(h))=>(h*old.width as f64/old.height as f64,h),(None,None)=>(old.width as f64,old.height as f64)};
        // 不允许上游的clamp把无效尺寸静默改成1px或300000px。
        dimensions(id,w.round(),h.round())
    } else {
        if fields.keys().any(|k|!["angle","direction","interpolation","backgroundColor"].contains(&k.as_str())) {return Err(fail(id,"旋转包含未开放的参数"));}
        if p.get("backgroundColor").is_some_and(|v|v.as_str().is_none_or(|s|s.len()!=7 || !s.starts_with('#') || !s[1..].bytes().all(|b|b.is_ascii_hexdigit()))) {return Err(fail(id,"背景色须为 #RRGGBB"));}
        let angle=number(p,"angle",0.0,id)?;
        if angle.abs()>3600.0 {return Err(fail(id,"角度须为 -3600–3600°"));}
        if p.get("direction").is_some_and(|v|!matches!(v.as_str(),Some("cw"|"ccw"))) {return Err(fail(id,"旋转方向须为 cw 或 ccw"));}
        if p.get("interpolation").is_some_and(|v|!matches!(v.as_str(),Some("nearest"|"bilinear"|"bicubic"))) {return Err(fail(id,"插值须为 nearest、bilinear 或 bicubic"));}
        // 上游使用f32角度；预算必须与实际执行完全一致。
        let (sn,cs)=((angle as f32 as f64).to_radians()).sin_cos();
        dimensions(id,((old.width as f64*cs.abs()+old.height as f64*sn.abs()-1e-6).ceil()).max(1.0),((old.width as f64*sn.abs()+old.height as f64*cs.abs()-1e-6).ceil()).max(1.0))
    }
}
pub(crate) fn execute(s:&mut Session,id:&str,p:Value)->Result<Value> {
    let expected=check(s,id,&p)?;
    let base=s.active().ok_or(EditorError::NoDocument)?.clone();
    // 候选分配前估算全部内容/蒙版/缓存，避免多层文档逐层膨胀后才发现超限。
    let mut bytes=0_u64;
    let mut account=|surface:&photocraft_raster::Surface,background:bool| {
        let bounds=surface.content_bounds();
        let (w,h)=if id=="image.canvasSize" {if background {(expected.width as f64,expected.height as f64)}else{(bounds.width() as f64,bounds.height() as f64)}}
        else if id=="image.imageSize" || id=="file.automate.fitImage" {
            if p["resample"]=="none" {(bounds.width() as f64,bounds.height() as f64)}else{(bounds.width() as f64*expected.width as f64/base.doc.size.width as f64,bounds.height() as f64*expected.height as f64/base.doc.size.height as f64)}
        } else {let (sn,cs)=((p["angle"].as_f64().unwrap_or(0.) as f32 as f64).to_radians()).sin_cos();(bounds.width() as f64*cs.abs()+bounds.height() as f64*sn.abs(),bounds.width() as f64*sn.abs()+bounds.height() as f64*cs.abs())};
        let (w,h)=if background {(w.max(expected.width as f64),h.max(expected.height as f64))}else{(w,h)};
        // 稀疏表面以256px tile存储，按完整tile及边界插值余量计预算。
        let tiles=if w>0. && h>0. {((w+4.)/256.).ceil()*((h+4.)/256.).ceil()}else{0.};
        bytes=bytes.saturating_add((tiles as u64).saturating_mul(256*256).saturating_mul(surface.format().bytes_per_pixel() as u64));
    };
    for (_,_,layer) in base.doc.walk() {
        if let Some(surface)=layer.surface() {account(surface,base.doc.is_background(layer.id));}
        if let Some(mask)=&layer.mask {account(&mask.surface,false);}
        if let Some(cache)=&layer.fill_cache {account(&cache.surface,false);}
    }
    if let Some(selection)=&base.doc.selection {account(selection,false);}
    for channel in base.doc.channels.iter().chain(base.doc.quick_mask.as_ref()) {account(&channel.surface,false);}
    if bytes>268_435_456 {return Err(fail(id,"结果像素资源超过 256 MiB 预算，请减小尺寸或图层数量"));}
    let mut scratch=Session::new();scratch.tools=s.tools.clone();scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
    let mut upstream=p;
    if let Some(color)=upstream.get("backgroundColor").and_then(Value::as_str) {
        scratch.tools.background=[u8::from_str_radix(&color[1..3],16).unwrap() as f32/255.,u8::from_str_radix(&color[3..5],16).unwrap() as f32/255.,u8::from_str_radix(&color[5..7],16).unwrap() as f32/255.,1.];
        upstream.as_object_mut().unwrap().remove("backgroundColor");
    }
    let result=scratch.execute(id,upstream).map_err(|e|fail(id,e))?;
    let after=scratch.active().ok_or(EditorError::NoDocument)?;
    if after.doc.size!=expected {return Err(fail(id,"结果尺寸与预算不一致，未应用更改"));}
    if after.doc!=base.doc {crate::preview_history::commit_selected(s,after.doc.clone(),after.active_layer,after.selected_layers(),id).map_err(|e|fail(id,e))?;}
    Ok(result)
}
/// 可取消整画布旋转候选；每次更新都从原始文档重算，避免累计插值损失。
pub(crate) struct RotationPreview {
    base:photocraft_engine::DocState,
    pub doc:std::sync::Arc<photocraft_doc::Document>,
    valid:bool,
}
impl RotationPreview {
    pub fn new(base:&photocraft_engine::DocState)->Self {Self{base:base.clone(),doc:base.doc.clone(),valid:true}}
    pub fn update(&mut self,params:Value)->Result<Value> {
        self.valid=false;
        let mut scratch=Session::new();scratch.add_document((*self.base.doc).clone(),None);*scratch.active_mut().unwrap()=self.base.clone();
        execute(&mut scratch,"image.rotation.arbitrary",params)?;
        self.doc=scratch.active().unwrap().doc.clone();self.valid=true;Ok(self.info())
    }
    pub fn info(&self)->Value {serde_json::json!({"width":self.doc.size.width,"height":self.doc.size.height})}
    pub fn commit(&self,session:&mut Session)->Result<()> {
        if !self.valid {return Err(fail("image.rotation.arbitrary","请修正旋转参数或取消编辑"));}
        if !std::sync::Arc::ptr_eq(&session.active().ok_or(EditorError::NoDocument)?.doc,&self.base.doc) {return Err(fail("image.rotation.arbitrary","文档已变化，请重新开始旋转"));}
        if self.doc!=self.base.doc {crate::preview_history::commit_selected(session,self.doc.clone(),self.base.active_layer,self.base.selected_layers(),"Rotate Canvas").map_err(|e|fail("image.rotation.arbitrary",e))?;}
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::*;
    use serde_json::json;
    fn fixture()->Session {let mut doc=Document::new("几何",Size::new(12,8),ColorMode::Rgb,SampleType::U8);let mut layer=Layer::raster("像素",doc.pixel_format());layer.surface_mut().unwrap().write_pixel(2,3,&[1.,0.,0.,1.]);doc.layers.push(layer);let mut s=Session::new();s.add_document(doc,None);s}
    #[test]
    fn canvas_anchor_relative_and_atomic_history_without_compositing() {
        let mut s=fixture();let before=s.active().unwrap().clone();
        execute(&mut s,IDS[0],json!({"width":8,"height":4,"relative":true,"anchor":"center","extensionColor":"transparent"})).unwrap();
        let after=s.active().unwrap().clone();assert_eq!(after.doc.size,Size::new(20,12));assert_eq!(after.doc.layers[0].surface().unwrap().sample_channel(6,5,3),1.);assert_eq!(after.history.past_len(),before.history.past_len()+1);
        s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);s.execute("edit.redo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,after.doc);
        let count=s.active().unwrap().history.past_len();execute(&mut s,IDS[0],json!({"width":20,"height":12})).unwrap();assert_eq!(s.active().unwrap().history.past_len(),count);
    }
    #[test]
    fn rotation_budget_strictness_and_rejections_leave_source_intact() {
        let mut s=fixture();let before=s.active().unwrap().clone();
        for p in [json!({"angle":"45"}),json!({"angle":null}),json!({"angle":3601}),json!({"direction":"bad"}),json!({"interpolation":"bad"}),json!({"extra":true}),json!({"backgroundColor":"#界界"}),json!({"backgroundColor":"#12345g"}),json!({"backgroundColor":null})] {assert!(execute(&mut s,IDS[1],p).is_err());}
        for p in [json!({"width":0}),json!({"width":8193}),json!({"width":1.5}),json!({"width":-12,"relative":true}),json!({"relative":1}),json!({"anchor":"topleft"}),json!({"extensionColor":"#界界"}),json!({"extensionColor":"#xxxxxx"}),json!({"height":"3"}),json!({"extra":0})] {assert!(execute(&mut s,IDS[0],p).is_err());}
        assert_eq!(s.active().unwrap().doc,before.doc);assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len());
        std::sync::Arc::make_mut(&mut s.active_mut().unwrap().doc).size=Size::new(8192,8192);assert!(execute(&mut s,IDS[1],json!({"angle":45})).is_err());
        assert_eq!(s.active().unwrap().doc.size,Size::new(8192,8192));
    }
    #[test]
    fn rotation_candidate_uses_explicit_background_without_mutating_tool_colors() {
        let mut s=Session::new();s.execute("file.new",json!({"width":12,"height":8,"background":"white"})).unwrap();
        let before=s.active().unwrap().clone();let colors=s.tools.background;
        let mut draft=RotationPreview::new(&before);
        draft.update(json!({"angle":45,"interpolation":"nearest","backgroundColor":"#336699"})).unwrap();
        let corner=draft.doc.background().unwrap().surface().unwrap().rgba(0,0);
        for (actual,expected) in corner.into_iter().zip([0.2,0.4,0.6,1.]) {assert!((actual-expected).abs()<0.005);}
        assert_eq!(s.active().unwrap().doc,before.doc);assert_eq!(s.tools.background,colors);
        draft.commit(&mut s).unwrap();assert_eq!(s.active().unwrap().doc,draft.doc);assert_eq!(s.tools.background,colors);
    }
    #[test]
    fn empty_raster_rotation_is_one_step_and_full_turn_is_noop() {
        let mut s=fixture();s.active_mut().unwrap().doc=std::sync::Arc::new(Document::new("空",Size::new(12,8),ColorMode::Rgb,SampleType::U8));
        let before=s.active().unwrap().clone();execute(&mut s,IDS[1],json!({"angle":90,"direction":"ccw","interpolation":"nearest"})).unwrap();
        assert_eq!(s.active().unwrap().doc.size,Size::new(8,12));assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);
        let after=s.active().unwrap().clone();execute(&mut s,IDS[1],json!({"angle":360})).unwrap();assert_eq!(s.active().unwrap().doc,after.doc);assert_eq!(s.active().unwrap().history.past_len(),after.history.past_len());
        s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);
    }
    #[test]
    fn image_size_resolution_identity_roundtrip_and_parameter_budget() {
        let mut s=fixture();let base=s.active().unwrap().clone();
        let registry=crate::document_content::AssetRegistry::default();
        let original_hash=crate::document_content::document_content_hash(&base.doc,&registry).unwrap();
        execute(&mut s,IDS[2],json!({"resolution":300.1,"resample":"none"})).unwrap();
        let after=s.active().unwrap().clone();assert_eq!(after.doc.size,base.doc.size);assert_ne!(crate::document_content::document_content_hash(&after.doc,&registry).unwrap(),original_hash);
        assert_eq!(after.history.past_len(),base.history.past_len()+1);
        let bytes=photocraft_format::save_to_bytes(&after.doc,&Default::default()).unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();
        let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(crate::document_content::document_content_hash(&loaded,&registry),crate::document_content::document_content_hash(&after.doc,&registry));
        execute(&mut s,IDS[2],json!({"resolution":300.1,"resample":"none"})).unwrap();assert_eq!(s.active().unwrap().history.past_len(),after.history.past_len());
        s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
        for params in [json!({"resolution":0}),json!({"resolution":10001}),json!({"resolution":null}),json!({"width":0}),json!({"width":8193}),json!({"percent":0}),json!({"percent":100000}),json!({"keepPrintSize":"yes"}),json!({"resample":"bad"}),json!({"foo":1})] {assert!(execute(&mut s,IDS[2],params).is_err());}
        assert_eq!(s.active().unwrap().doc,base.doc);
        assert_eq!(check(&s,IDS[2],&json!({"width":24})).unwrap(),Size::new(24,16));
        assert_eq!(check(&s,IDS[2],&json!({"percent":50})).unwrap(),Size::new(6,4));
        assert_eq!(check(&s,IDS[2],&json!({"resolution":144,"keepPrintSize":true})).unwrap(),Size::new(24,16));
    }

    #[test]
    fn fit_image_aspect_no_enlarge_noop_budget_and_atomic_history() {
        let mut s=fixture();let base=s.active().unwrap().clone();
        let id="file.automate.fitImage";
        for params in [json!({"width":0}),json!({"height":8193}),json!({"width":1.5}),json!({"width":null}),json!({"dontEnlarge":1}),json!({"resample":"none"}),json!({"unknown":true})] {assert!(execute(&mut s,id,params).is_err());}
        assert_eq!(s.active().unwrap().doc,base.doc);
        let result=execute(&mut s,id,json!({"width":24,"height":24,"dontEnlarge":true})).unwrap();assert_eq!(result["changed"],false);assert_eq!(s.active().unwrap().history.past_len(),base.history.past_len());
        execute(&mut s,id,json!({"width":6,"height":6})).unwrap();let after=s.active().unwrap().clone();assert_eq!(after.doc.size,Size::new(6,4));assert_eq!(after.history.past_len(),base.history.past_len()+1);
        s.execute("edit.undo",json!({})).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);s.execute("edit.redo",json!({})).unwrap();assert_eq!(s.active().unwrap().doc,after.doc);
        execute(&mut s,id,json!({"width":6,"height":4})).unwrap();assert_eq!(s.active().unwrap().history.past_len(),after.history.past_len());
        execute(&mut s,id,json!({"width":18,"height":8})).unwrap();assert_eq!(s.active().unwrap().doc.size,Size::new(12,8));
    }

}
