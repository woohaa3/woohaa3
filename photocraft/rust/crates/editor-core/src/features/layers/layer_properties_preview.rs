//! 连续图层属性编辑只预览草稿，支持不透明度、填充不透明度和受控图案资源样式。
use std::sync::Arc;
use photocraft_doc::{Document, LayerId};
use photocraft_engine::{DocState, Session};
use serde_json::{Value,json};
use crate::error::{EditorError,Result};

pub(crate) fn error(message:impl std::fmt::Display)->EditorError {
    EditorError::CommandFailed{id:"layer.setProps".into(),message:message.to_string()}
}
pub(crate) struct LayerPropertiesPreview {
    base:DocState,
    layer:LayerId,
    valid:bool,
    patterns:Vec<photocraft_doc::Pattern>,
    pub doc:Arc<Document>,
}
impl LayerPropertiesPreview {
    pub fn new(base:&DocState,layer:u64)->Result<Self> {
        let layer=LayerId(layer);
        if base.doc.layer(layer).is_none() {return Err(error("图层不存在"));}
        if base.doc.effective_locks(layer).all {return Err(error("图层已锁定，无法修改属性"));}
        Ok(Self{base:base.clone(),layer,valid:true,patterns:base.doc.patterns.clone(),doc:base.doc.clone()})
    }
    pub fn with_patterns(mut self,patterns:&[photocraft_doc::Pattern])->Self {
        self.add_patterns(patterns);
        self
    }
    fn add_patterns(&mut self,patterns:&[photocraft_doc::Pattern]) {
        for pattern in patterns {
            if !self.patterns.iter().any(|p|p.id==pattern.id) && photocraft_project_verify::pattern_support::supported(std::slice::from_ref(pattern)) {
                self.patterns.push(pattern.clone());
            }
        }
    }
    /// 刷新库目录时保留正式文档和当前草稿引用的独立资源，丢弃未使用的旧目录项。
    pub fn replace_library_patterns(&mut self,patterns:&[photocraft_doc::Pattern]) {
        self.patterns=self.base.doc.patterns.clone();
        let active=self.doc.patterns.clone();
        self.add_patterns(&active);
        self.add_patterns(patterns);
    }
    pub fn info(&self)->Value {
        let layer=self.doc.layer(self.layer).unwrap();
        // 与 composite_layer_effects/composite_atop_any 的 paint_fx 帧一致。
        // 使用原生边界缓存；启停效果也可能切换 shapeless 的整画布语义。
        let frame=photocraft_compose::paint_bounds(layer)
            .unwrap_or_else(||photocraft_compose::layer_bounds(layer,self.doc.bounds()));
        let gradient_frame=[i64::from(frame.x0),i64::from(frame.y0),i64::from(frame.width().max(1)),i64::from(frame.height().max(1))];
        json!({"layer":self.layer.0,"opacity":layer.opacity,"fill":layer.fill_opacity,
            "style":{"enabled":layer.effects.enabled,"items":layer.effects.items},"globalLight":self.doc.global_light,"styleContourSamples":contour_samples(&layer.effects),"styleGradientFrame":gradient_frame})
    }
    /// 描边帧会读取实际效果映射，仅在开始定位时请求，不加入每帧属性响应。
    pub fn position_frame(&self,index:usize)->Result<Value> {
        self.require_valid()?;
        let layer=self.doc.layer(self.layer).unwrap();
        if !layer.effects.enabled {return Err(error("样式已禁用，无法定位渐变"));}
        let effect=layer.effects.items.get(index).filter(|effect|effect.enabled())
            .ok_or_else(||error("定位效果不存在或已禁用"))?;
        let frame=match effect {
            photocraft_doc::Effect::Stroke(stroke) if matches!(stroke.paint,photocraft_doc::FxPaint::Gradient(_))=>
                photocraft_compose::stroke_frame(&self.doc,layer,stroke).ok_or_else(||error("无法取得原生描边渐变帧"))?,
            photocraft_doc::Effect::GradientOverlay{..}=>photocraft_compose::paint_bounds(layer)
                .unwrap_or_else(||photocraft_compose::layer_bounds(layer,self.doc.bounds())),
            _=>return Err(error("当前效果不使用空间渐变定位")),
        };
        Ok(json!([i64::from(frame.x0),i64::from(frame.y0),i64::from(frame.width().max(1)),i64::from(frame.height().max(1))]))
    }
    pub fn start_info(&self)->Value {
        let mut info=self.info();
        info["contourPresets"]=crate::contour_presets::builtins();
        info["styleDefaults"]=Value::Array(["dropShadow","innerShadow","outerGlow","innerGlow","stroke","colorOverlay","gradientOverlay","satin","bevelEmboss"]
            .iter().filter_map(|kind|photocraft_engine::layer_style::effect_from_params(kind,&Value::Null)).map(|fx|json!(fx)).collect());
        info["patternPresets"]=json!(self.patterns.iter().map(|p|json!({"id":p.id,"name":p.name,"width":p.width,"height":p.height})).collect::<Vec<_>>());
        if let Some(pattern)=self.patterns.first() {
            if let Some(mut fx)=photocraft_engine::layer_style::effect_from_params("patternOverlay",&Value::Null) {
                if let photocraft_doc::Effect::PatternOverlay{id,name,..}=&mut fx {*id=pattern.id.clone();*name=pattern.name.clone();}
                info["styleDefaults"].as_array_mut().unwrap().push(json!(fx));
            }
        }
        info
    }
    pub fn update(&mut self,params:Value)->Result<()> {
        self.valid=false;
        let fields=params.as_object().filter(|p| !p.is_empty() && p.keys().all(|key| matches!(key.as_str(),"opacity" | "fill" | "style" | "globalLight")))
            .ok_or_else(||error("属性草稿包含不支持的字段"))?;
        for value in [fields.get("opacity"),fields.get("fill")].into_iter().flatten() {
            if !value.as_f64().is_some_and(|v|v.is_finite() && (0.0..=1.0).contains(&v)) {
                return Err(error("不透明度和填充必须是 0–1 之间的数值"));
            }
        }
        let mut scratch=Session::new();scratch.add_document((*self.base.doc).clone(),None);
        *scratch.active_mut().unwrap()=self.base.clone();
        let props=fields.iter().filter(|(key,_)| matches!(key.as_str(),"opacity"|"fill"))
            .map(|(key,value)|(key.clone(),value.clone())).collect::<serde_json::Map<_,_>>();
        if !props.is_empty() {
            let mut props=Value::Object(props);props["layer"]=json!(self.layer.0);
            scratch.execute("layer.setProps",props).map_err(error)?;
        }
        if let Some(style)=fields.get("style") {
            let object=style.as_object().filter(|object|object.len()==2 && object.contains_key("enabled") && object.contains_key("items"))
                .ok_or_else(||error("样式仅接受 enabled 和 items"))?;
            let enabled=object["enabled"].as_bool().ok_or_else(||error("样式启停必须是布尔值"))?;
            let raw=&object["items"];
            if !photocraft_project_verify::style_support::supported_items(raw) {return Err(error("样式包含未开放内容或参数超限"));}
            let items:Vec<photocraft_doc::Effect>=serde_json::from_value(raw.clone()).map_err(|_|error("样式快照格式无效"))?;
            let normalized=json!(items);
            if !known_keys(raw,&normalized) {return Err(error("样式快照包含未知参数"));}
            let doc=Arc::make_mut(&mut scratch.active_mut().unwrap().doc);
            let layer=doc.layer_mut(self.layer).unwrap();
            layer.effects.items=items;layer.effects.enabled=enabled;layer.effects.psd_raw=None;
            let refs:Vec<_>=photocraft_project_verify::style_support::pattern_references(&layer.effects).iter().map(|(id,name)|(id.to_string(),name.to_string())).collect();
            for (id,name) in refs {
                let pattern=self.patterns.iter().find(|p|p.id==id && p.name==name).ok_or_else(||error("图案资源不存在或身份不匹配"))?;
                if !doc.patterns.iter().any(|p|p.id==id) {doc.patterns.push(pattern.clone());}
            }
        }
        if let Some(light)=fields.get("globalLight") {
            let light=light.as_object().filter(|object|object.len()==2 && object.contains_key("angle") && object.contains_key("altitude"))
                .ok_or_else(||error("全局光源参数无效"))?;
            let angle=light["angle"].as_f64().filter(|value|value.is_finite() && (-360.0..=360.0).contains(value)).ok_or_else(||error("光源角度须为 -360–360"))?;
            let altitude=light["altitude"].as_f64().filter(|value|value.is_finite() && (0.0..=90.0).contains(value)).ok_or_else(||error("光源高度须为 0–90"))?;
            Arc::make_mut(&mut scratch.active_mut().unwrap().doc).global_light=photocraft_doc::GlobalLight{angle:angle as f32,altitude:altitude as f32};
        }
        let doc=&scratch.active().unwrap().doc;
        if !photocraft_project_verify::style_support::supported_document(doc) {
            return Err(error("样式结果无法通过工程核验"));
        }
        self.doc=scratch.active().unwrap().doc.clone();self.valid=true;Ok(())
    }
    pub fn require_valid(&self)->Result<()> {
        if self.valid {Ok(())} else {Err(error("请修正图层属性或取消编辑"))}
    }
    pub fn commit(&self,session:&mut Session)->Result<()> {
        self.require_valid()?;
        crate::preview_history::commit(session,self.doc.clone(),None,"修改图层属性").map_err(error)
    }
}

/// 仅采样一维传递曲线，不读取像素或执行图像合成。
fn contour_samples(effects:&photocraft_doc::Effects)->Value {
    use photocraft_doc::{Contour,Effect};
    fn samples(contour:&Contour)->Value {
        match contour {
            Contour::Linear=>json!((0..256).map(|i|i as f32/255.0).collect::<Vec<_>>()),
            Contour::Custom{points,corners,..}=>{
                let lut=photocraft_compose::adjust::contour_curve_lut(points,corners);
                json!((0..256).map(|i|lut[i*(lut.len()-1)/255]).collect::<Vec<_>>())
            }
        }
    }
    Value::Array(effects.items.iter().map(|effect|match effect {
        Effect::DropShadow(s)|Effect::InnerShadow(s)=>json!({"contour":samples(&s.contour)}),
        Effect::OuterGlow(g)|Effect::InnerGlow(g)=>json!({"contour":samples(&g.contour)}),
        Effect::Satin(s)=>json!({"contour":samples(&s.contour)}),
        Effect::BevelEmboss(b)=>{
            let mut value=json!({"gloss_contour":samples(&b.gloss_contour)});
            if let Some(contour)=&b.contour {value["bevelContour"]=samples(&contour.contour);}
            value
        },
        _=>json!({}),
    }).collect())
}

pub(crate) fn known_keys(raw:&Value,normalized:&Value)->bool {
    match raw {
        Value::Object(object)=>normalized.as_object().is_some_and(|next|object.iter().all(|(key,value)|
            next.get(key).is_some_and(|v|known_keys(value,v))
                // 上游序列化省略空 corners；它仍是合法的已知字段。
                || (key=="corners" && next.contains_key("points") && next.contains_key("name") && value.as_array().is_some_and(Vec::is_empty)))) ,
        Value::Array(array)=>normalized.as_array().is_some_and(|next|array.len()==next.len() && array.iter().zip(next).all(|(a,b)|known_keys(a,b))),
        _=>true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn position_frame_rejects_inactive_non_gradient_and_invalid_drafts_before_maps() {
        let mut session=Session::new();session.execute("file.new",json!({"width":320,"height":180,"background":"transparent"})).unwrap();
        let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
        let mut draft=LayerPropertiesPreview::new(&base,id.0).unwrap();
        assert!(draft.position_frame(0).is_err());assert!(draft.position_frame(usize::MAX).is_err());
        let mut stroke=json!(photocraft_engine::layer_style::effect_from_params("stroke",&Value::Null).unwrap());
        draft.update(json!({"style":{"enabled":true,"items":[stroke.clone()]}})).unwrap();
        assert!(draft.position_frame(0).is_err()); // Color，不构建效果映射。
        let overlay=json!(photocraft_engine::layer_style::effect_from_params("gradientOverlay",&Value::Null).unwrap());
        stroke["Stroke"]["paint"]=json!({"Gradient":overlay["GradientOverlay"]["gradient"]});
        stroke["Stroke"]["common"]["enabled"]=json!(false);
        draft.update(json!({"style":{"enabled":true,"items":[stroke]}})).unwrap();assert!(draft.position_frame(0).is_err());
        draft.update(json!({"style":{"enabled":false,"items":[overlay.clone()]}})).unwrap();assert!(draft.position_frame(0).is_err());
        draft.update(json!({"style":{"enabled":true,"items":[overlay]}})).unwrap();
        assert_eq!(draft.position_frame(0).unwrap(),json!([0,0,1,1]));
        assert!(draft.update(json!({"opacity":2})).is_err());assert!(draft.position_frame(0).is_err());
        assert_eq!(session.active().unwrap().doc,base.doc);assert_eq!(session.active().unwrap().history.past_len(),base.history.past_len());
    }

    #[test]
    fn gradient_frame_uses_native_paint_bounds_without_rasterization() {
        use photocraft_doc::{LayerContent,Fill,Color};
        use photocraft_doc::vector::{Path,Subpath,ShapeLayer};
        let mut session=Session::new();session.execute("file.new",json!({"width":320,"height":180,"background":"transparent"})).unwrap();
        let mut base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
        let read=|state:&DocState|LayerPropertiesPreview::new(state,id.0).unwrap().info()["styleGradientFrame"].clone();
        // 空 surface 不扫描有效像素，使用与 gradient_t 相同的 max(1) 退化尺寸。
        assert_eq!(read(&base),json!([0,0,1,1]));
        let layer=Arc::make_mut(&mut base.doc).layer_mut(id).unwrap();
        layer.advanced.transparency_shapes=false;
        layer.effects.items.push(photocraft_engine::layer_style::effect_from_params("gradientOverlay",&Value::Null).unwrap());
        assert_eq!(read(&base),json!([0,0,320,180]));
        Arc::make_mut(&mut base.doc).layer_mut(id).unwrap().content=LayerContent::Fill(Fill::Solid(Color::WHITE));
        assert_eq!(read(&base),json!([0,0,320,180]));
        Arc::make_mut(&mut base.doc).layer_mut(id).unwrap().content=LayerContent::Shape(ShapeLayer {
            path:Path::new(vec![Subpath::polygon(&[(-12.8,7.9),(187.7,7.9),(187.7,87.1),(-12.8,87.1)])]),
            fill:Some(Fill::Solid(Color::WHITE)),..Default::default()
        });
        // 使用 paint_bounds 的整像素路径帧；不替换为文档或栅格外框。
        let before=base.doc.clone();assert_eq!(read(&base),json!([-13,7,200,80]));assert_eq!(base.doc,before);
    }

    #[test]
    fn gradient_frame_is_readonly_metadata_and_survives_preview_roundtrip() {
        let mut session=Session::new();session.execute("file.new",json!({"width":320,"height":180,"background":"transparent"})).unwrap();
        let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
        let mut draft=LayerPropertiesPreview::new(&base,id.0).unwrap();
        let mut fx=json!(photocraft_engine::layer_style::effect_from_params("gradientOverlay",&Value::Null).unwrap());
        fx["GradientOverlay"]["gradient"]["offset"]=json!([0.25,-0.5]);
        assert!(draft.update(json!({"styleGradientFrame":[0,0,320,180]})).is_err());
        draft.update(json!({"style":{"enabled":true,"items":[fx]}})).unwrap();
        assert_eq!(draft.info()["styleGradientFrame"],json!([0,0,1,1]));assert_eq!(session.active().unwrap().doc,base.doc);
        draft.commit(&mut session).unwrap();assert_eq!(session.active().unwrap().history.past_len(),base.history.past_len()+1);
        let bytes=photocraft_format::save_to_bytes(&session.active().unwrap().doc,&Default::default()).unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(loaded.layers[0].effects.items,session.active().unwrap().doc.layers[0].effects.items);
        session.execute("edit.undo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc,base.doc);
    }

    #[test]
    fn pattern_styles_copy_only_active_resources_and_commit_one_history_without_rendering() {
        use photocraft_doc::{Pattern,Surface};
        let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":16})).unwrap();
        let base=s.active().unwrap().clone();let id=base.active_layer.unwrap();
        let patterns:Vec<_>=["a","b"].iter().map(|id|Pattern{id:id.to_string(),name:format!("图案{id}"),width:16,height:16,surface:Surface::new(base.doc.pixel_format())}).collect();
        let mut draft=LayerPropertiesPreview::new(&base,id.0).unwrap().with_patterns(&patterns);
        assert_eq!(draft.start_info()["patternPresets"].as_array().unwrap().len(),2);
        assert_eq!(draft.start_info()["styleDefaults"].as_array().unwrap().len(),10);
        let baseline=crate::document_content::document_content_hash(&base.doc,&Default::default()).unwrap();
        let mut final_items=Vec::new();
        for kind in ["patternOverlay","stroke","outerGlow","innerGlow","bevelEmboss"] {
            let mut fx=json!(photocraft_engine::layer_style::effect_from_params(kind,&Value::Null).unwrap());
            let reference=json!({"id":"a","name":"图案a","scale":0.5});
            match kind {
                "patternOverlay"=>{fx["PatternOverlay"]["id"]=json!("a");fx["PatternOverlay"]["name"]=json!("图案a");},
                "stroke"=>fx["Stroke"]["paint"]=json!({"Pattern":reference}),
                "outerGlow"=>fx["OuterGlow"]["paint"]=json!({"Pattern":reference}),
                "innerGlow"=>fx["InnerGlow"]["paint"]=json!({"Pattern":reference}),
                _=>fx["BevelEmboss"]["texture"]=json!({"id":"a","name":"图案a","scale":1,"depth":-2.5,"invert":true,"link":false,"phase":[3,-5]}),
            }
            draft.update(json!({"style":{"enabled":true,"items":[fx.clone()]}})).unwrap();
            assert_eq!(draft.doc.patterns.len(),1);assert_eq!(s.active().unwrap().doc.patterns.len(),0);
            assert_eq!(crate::document_content::document_content_hash(&s.active().unwrap().doc,&Default::default()).unwrap(),baseline);
            let bytes=photocraft_format::save_to_bytes(&draft.doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
            let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
            assert_eq!(crate::document_content::document_content_hash(&loaded,&Default::default()),crate::document_content::document_content_hash(&draft.doc,&Default::default()));
            final_items.push(fx);
        }
        let mut overlay=final_items[0].clone();overlay["PatternOverlay"]["id"]=json!("b");overlay["PatternOverlay"]["name"]=json!("图案b");
        draft.update(json!({"style":{"enabled":true,"items":[overlay.clone()]}})).unwrap();
        assert_eq!(draft.doc.patterns.len(),1);assert_eq!(draft.doc.patterns[0].id,"b");
        overlay["PatternOverlay"]["name"]=json!("不匹配");
        assert!(draft.update(json!({"style":{"enabled":false,"items":[overlay]}})).is_err());assert!(draft.commit(&mut s).is_err());
        for depth in [-10.1,10.1] {let mut fx=final_items[4].clone();fx["BevelEmboss"]["texture"]["depth"]=json!(depth);assert!(draft.update(json!({"style":{"enabled":true,"items":[fx]}})).is_err());}
        draft.update(json!({"style":{"enabled":true,"items":final_items}})).unwrap();draft.commit(&mut s).unwrap();
        assert_eq!(s.active().unwrap().history.past_len(),base.history.past_len()+1);assert_eq!(s.active().unwrap().doc.patterns.len(),1);
        s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
        s.execute("edit.redo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc.patterns.len(),1);
    }

    #[test]
    fn custom_contours_and_bevel_contour_sample_and_roundtrip_without_rendering() {
        for kind in ["DropShadow","InnerShadow","OuterGlow","InnerGlow","Satin","BevelEmboss"] {
            let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":16})).unwrap();
            let base=s.active().unwrap().clone();let id=base.active_layer.unwrap();
            let mut draft=LayerPropertiesPreview::new(&base,id.0).unwrap();
            let mut fx=draft.start_info()["styleDefaults"].as_array().unwrap().iter().find(|fx|fx.get(kind).is_some()).unwrap().clone();
            let contour=json!({"Custom":{"name":"锥形","points":[{"input":0,"output":0},{"input":0.5,"output":1},{"input":1,"output":0}],"corners":[false,true,false]}});
            let key=if kind=="BevelEmboss" {"gloss_contour"} else {"contour"};
            fx[kind][key]=contour.clone();
            if kind=="BevelEmboss" {fx[kind]["contour"]=json!({"contour":contour,"range":0.5,"anti_alias":true});}
            let mut smooth=fx.clone();smooth[kind][key]["Custom"]["corners"]=json!([]);
            draft.update(json!({"style":{"enabled":true,"items":[smooth]}})).unwrap();
            let mut invalid=fx.clone();invalid[kind][key]["Custom"]["points"][1]["input"]=json!(0);
            assert!(draft.update(json!({"style":{"enabled":true,"items":[invalid]}})).is_err());assert!(draft.commit(&mut s).is_err());
            draft.update(json!({"style":{"enabled":true,"items":[fx]}})).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
            let info=draft.info();let samples=info["styleContourSamples"][0][key].as_array().unwrap();assert_eq!(samples.len(),256);
            assert_eq!(samples[0].as_f64(),Some(0.0));assert!(samples[128].as_f64().unwrap()>0.99);assert_eq!(samples[255].as_f64(),Some(0.0));
            if kind=="BevelEmboss" {assert_eq!(info["styleContourSamples"][0]["bevelContour"],info["styleContourSamples"][0][key]);}
            draft.commit(&mut s).unwrap();assert_eq!(s.active().unwrap().history.past_len(),base.history.past_len()+1);
            let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
            let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();assert_eq!(loaded.layers[0].effects.items,s.active().unwrap().doc.layers[0].effects.items);
            s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
            s.execute("edit.redo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].effects.items,loaded.layers[0].effects.items);
        }
    }

    #[test]
    fn stroke_and_glow_gradient_paints_roundtrip_without_rendering() {
        for kind in ["Stroke","InnerGlow","OuterGlow"] {
            let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":16})).unwrap();
            let base=s.active().unwrap().clone();let id=base.active_layer.unwrap();
            let mut draft=LayerPropertiesPreview::new(&base,id.0).unwrap();
            let defaults=draft.start_info()["styleDefaults"].as_array().unwrap().clone();
            let mut fx=defaults.iter().find(|fx|fx.get(kind).is_some()).unwrap().clone();
            let mut gradient=defaults.iter().find_map(|fx|fx.get("GradientOverlay")).unwrap()["gradient"].clone();
            gradient["offset"]=json!([0.25,-0.3]);gradient["opacity_stops"]=json!([[0,1],[1,0.4]]);
            fx[kind]["paint"]=json!({"Gradient":gradient});
            for offset in [json!([null,0]),json!([0,1_000_001])] {
                let mut invalid=fx.clone();invalid[kind]["paint"]["Gradient"]["offset"]=offset;
                assert!(draft.update(json!({"style":{"enabled":true,"items":[invalid]}})).is_err());
                assert!(draft.commit(&mut s).is_err());
            }
            draft.update(json!({"style":{"enabled":true,"items":[fx]}})).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
            draft.commit(&mut s).unwrap();assert_eq!(s.active().unwrap().history.past_len(),base.history.past_len()+1);
            let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();
            photocraft_project_verify::verify(&bytes).unwrap();let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
            assert_eq!(loaded.layers[0].effects.items[0],serde_json::from_value::<photocraft_doc::Effect>(fx).unwrap());
            s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
            s.execute("edit.redo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].effects.items,loaded.layers[0].effects.items);
        }
    }

    #[test]
    fn gradient_stops_preview_reject_invalid_values_and_roundtrip_without_rendering() {
        let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":16})).unwrap();
        let base=s.active().unwrap().clone();let id=base.active_layer.unwrap();
        let mut draft=LayerPropertiesPreview::new(&base,id.0).unwrap();
        let mut fx=draft.start_info()["styleDefaults"].as_array().unwrap().iter().find(|fx|fx.get("GradientOverlay").is_some()).unwrap().clone();
        let gradient=&mut fx["GradientOverlay"]["gradient"];
        let color=gradient["stops"][0][1].clone();
        gradient["stops"]=json!([[0,color],[0.5,color],[1,color]]);
        gradient["opacity_stops"]=json!([[0,1],[0.5,0.3],[1,0]]);
        for invalid in [json!([[0,-0.1]]),json!([[1.1,1]]),json!([[0,null]])] {
            let mut bad=fx.clone();bad["GradientOverlay"]["gradient"]["opacity_stops"]=invalid;
            assert!(draft.update(json!({"style":{"enabled":true,"items":[bad]}})).is_err());
            assert!(draft.commit(&mut s).is_err());assert_eq!(s.active().unwrap().doc,base.doc);
        }
        draft.update(json!({"style":{"enabled":true,"items":[fx]}})).unwrap();
        assert_eq!(s.active().unwrap().doc,base.doc);draft.commit(&mut s).unwrap();
        assert_eq!(s.active().unwrap().history.past_len(),base.history.past_len()+1);
        let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(loaded.layers[0].effects.items[0],serde_json::from_value::<photocraft_doc::Effect>(fx.clone()).unwrap());
        s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
        s.execute("edit.redo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].effects.items,loaded.layers[0].effects.items);
    }

    #[test]
    fn style_session_uses_full_snapshots_and_one_history_without_rendering() {
        let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":16})).unwrap();
        let base=s.active().unwrap().clone();let id=base.active_layer.unwrap();
        let mut draft=LayerPropertiesPreview::new(&base,id.0).unwrap();
        let defaults=draft.start_info()["styleDefaults"].as_array().unwrap().clone();assert_eq!(defaults.len(),9);
        let hash=crate::document_content::document_content_hash(&base.doc,&Default::default()).unwrap();
        for fx in &defaults {
            draft.update(json!({"style":{"enabled":true,"items":[fx]}})).unwrap();
            assert_eq!(s.active().unwrap().doc.layers[0].effects.items.len(),0);
            assert_eq!(draft.info()["style"]["items"].as_array().unwrap().len(),1);
            assert_ne!(crate::document_content::document_content_hash(&draft.doc,&Default::default()).unwrap(),hash);
        }
        for params in [json!({"style":{"enabled":true,"items":[{"PatternOverlay":{}}]}}),json!({"style":{"enabled":true,"items":vec![defaults[0].clone();65]}}),json!({"style":{"enabled":true,"items":[] ,"extra":1}}),json!({"globalLight":{"angle":0,"altitude":91}})] {
            assert!(draft.update(params).is_err());assert!(draft.commit(&mut s).is_err());
            assert_eq!(s.active().unwrap().doc,base.doc);
        }
        let mut unknown=defaults[0].clone();unknown["DropShadow"]["unknown"]=json!(true);
        assert!(draft.update(json!({"style":{"enabled":true,"items":[unknown]}})).is_err());
        draft.update(json!({"style":{"enabled":false,"items":[defaults[0],defaults[4],defaults[0]]},"globalLight":{"angle":50,"altitude":40}})).unwrap();
        draft.commit(&mut s).unwrap();
        assert_eq!(s.active().unwrap().history.past_len(),base.history.past_len()+1);
        let doc=&s.active().unwrap().doc;
        assert_eq!(doc.layers[0].effects.items.len(),3);assert!(!doc.layers[0].effects.enabled);assert_eq!(doc.global_light.angle,50.0);
        let bytes=photocraft_format::save_to_bytes(doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();
        let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(crate::document_content::document_content_hash(&loaded,&Default::default()),crate::document_content::document_content_hash(doc,&Default::default()));
        s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,base.doc);
        s.execute("edit.redo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc.layers[0].effects.items.len(),3);
    }

    #[test]
    fn fill_draft_is_cancelable_strict_and_persists_independently_without_rendering() {
        let mut s=Session::new();s.execute("file.new",json!({"width":16,"height":16})).unwrap();
        let id=s.active().unwrap().active_layer.unwrap();
        let base=s.active().unwrap().clone();
        let hash=crate::document_content::document_content_hash(&base.doc,&Default::default()).unwrap();
        let mut draft=LayerPropertiesPreview::new(&base,id.0).unwrap();
        draft.update(json!({"fill":0.3})).unwrap();
        assert_eq!(draft.doc.layer(id).unwrap().opacity,1.0);
        assert_eq!(draft.doc.layer(id).unwrap().fill_opacity,0.3);
        assert_eq!(s.active().unwrap().doc.layer(id).unwrap().fill_opacity,1.0);
        assert_ne!(crate::document_content::document_content_hash(&draft.doc,&Default::default()).unwrap(),hash);
        for params in [json!({"fill":-0.1}),json!({"fill":null}),json!({"fill":2}),json!({"name":"x"})] {
            assert!(draft.update(params).is_err());assert!(draft.commit(&mut s).is_err());
        }
        draft.update(json!({"fill":0.4,"opacity":0.8})).unwrap();draft.commit(&mut s).unwrap();
        assert_eq!(s.active().unwrap().history.past_len(),base.history.past_len()+1);
        let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();
        photocraft_project_verify::verify(&bytes).unwrap();
        let loaded=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(loaded.layer(id).unwrap().fill_opacity,0.4);
        assert_eq!(loaded.layer(id).unwrap().opacity,0.8);
        s.execute("edit.undo",Value::Null).unwrap();
        assert_eq!(crate::document_content::document_content_hash(&s.active().unwrap().doc,&Default::default()).unwrap(),hash);
        s.execute("edit.redo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc.layer(id).unwrap().fill_opacity,0.4);
    }

    #[test]
    fn explicit_property_confirmation_separates_commands_and_roundtrips_without_compositing() {
        let mut session=Session::new();session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        session.execute("layer.new.layer",json!({"name":"原始"})).unwrap();
        let id=session.active().unwrap().active_layer.unwrap();let count=session.active().unwrap().history.past_len();
        session.execute("layer.setProps",json!({"name":"前命令","coalesce":"properties"})).unwrap();
        let mut draft=LayerPropertiesPreview::new(session.active().unwrap(),id.0).unwrap();
        draft.update(json!({"opacity":0.8})).unwrap();draft.update(json!({"opacity":0.3})).unwrap();draft.commit(&mut session).unwrap();
        session.execute("layer.setProps",json!({"visible":false,"coalesce":"properties"})).unwrap();
        assert_eq!(session.active().unwrap().history.past_len(),count+3);
        let bytes=photocraft_format::save_to_bytes(&session.active().unwrap().doc,&Default::default()).unwrap();
        let reopened=photocraft_format::load_from_bytes(&bytes).unwrap();
        assert_eq!(reopened.layer(id).unwrap().opacity,0.3);
        session.execute("edit.undo",Value::Null).unwrap();assert!(session.active().unwrap().doc.layer(id).unwrap().visible);
        session.execute("edit.undo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc.layer(id).unwrap().opacity,1.0);
        session.execute("edit.undo",Value::Null).unwrap();assert_eq!(session.active().unwrap().doc.layer(id).unwrap().name,"原始");
        for _ in 0..3 {session.execute("edit.redo",Value::Null).unwrap();}
        assert_eq!(session.active().unwrap().doc.layer(id).unwrap().opacity,0.3);
        Arc::make_mut(&mut session.active_mut().unwrap().doc).layer_mut(id).unwrap().locks.all=true;
        assert!(LayerPropertiesPreview::new(session.active().unwrap(),id.0).is_err());
    }
}
