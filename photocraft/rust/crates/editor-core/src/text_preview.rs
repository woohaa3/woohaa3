//! 文字内容和样式共用一个草稿；预览复用上游文字命令，确认只写一步历史。
use std::sync::Arc;
use photocraft_doc::{Document, LayerContent, LayerId};
use photocraft_engine::{DocState, Session};
use serde_json::{Value, json};
use crate::error::{EditorError, Result};

pub(crate) struct TextPreview {
    pub defaults:Option<(photocraft_doc::text::CharStyle,photocraft_doc::text::ParagraphStyle)>,
    base: DocState,
    initial: Value,
    pub doc: Arc<Document>,
    pub layer: Option<LayerId>,
    original: Option<LayerId>,
    layout: Option<photocraft_text::TextLayout>,
    valid: bool,
    pub checkpointed:bool,
}

pub(crate) fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "type.edit".into(), message: message.to_string() }
}

/// 文字草稿允许的字符/段落字段（I114/I127）。
///
/// 这些字段都已由固定引擎的 `type.setStyle` 拥有；编辑器只做范围复核，不复制排版算法。
/// `tracking` 以 1/1000 em 计，`leading`/`baselineShift` 以 pt 计，缩以百分比计。
const STYLE_FIELDS: &[&str] = &[
    "tracking", "leading", "baselineShift", "horizontalScale", "verticalScale",
    "weight", "italic", "underline", "strikethrough", "fauxItalic", "caps",
    "ligatures", "discretionaryLigatures", "kerning",
    "firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter", "hyphenate",
];

fn check_style(params: &Value) -> Result<()> {
    // 未知字段一律拒绝：半截参数不能落到正式文档。
    if let Some(fields) = params.as_object() {
        for key in fields.keys() {
            if !matches!(key.as_str(), "text" | "font" | "size" | "color" | "fauxBold" | "align"
                | "antialias" | "orientation" | "box" | "layer" | "x" | "y" | "forceNew" | "style")
                && !STYLE_FIELDS.contains(&key.as_str()) {
                return Err(error(format!("文字会话包含未开放的参数：{key}")));
            }
        }
    }
    let Some(style) = params.get("style") else { return Ok(()) };
    let fields = style.as_object().ok_or_else(|| error("文字样式必须是对象"))?;
    for key in fields.keys() {
        if !STYLE_FIELDS.contains(&key.as_str()) { return Err(error(format!("文字样式包含未开放的字段：{key}"))); }
    }
    let number = |key: &str, min: f64, max: f64| -> Result<()> {
        match fields.get(key) {
            None => Ok(()),
            Some(value) => match value.as_f64() {
                Some(number) if number.is_finite() && number >= min && number <= max => Ok(()),
                _ => Err(error(format!("{key} 必须在 {min}–{max} 之间"))),
            },
        }
    };
    number("tracking", -1000.0, 10000.0)?;
    number("leading", 0.01, 5000.0)?;
    number("baselineShift", -5000.0, 5000.0)?;
    number("horizontalScale", 1.0, 1000.0)?;
    number("verticalScale", 1.0, 1000.0)?;
    number("weight", 100.0, 900.0)?;
    number("firstLineIndent", -5000.0, 5000.0)?;
    number("startIndent", -5000.0, 5000.0)?;
    number("endIndent", -5000.0, 5000.0)?;
    number("spaceBefore", 0.0, 5000.0)?;
    number("spaceAfter", 0.0, 5000.0)?;
    for key in ["italic", "underline", "strikethrough", "fauxItalic", "ligatures", "discretionaryLigatures", "hyphenate"] {
        if fields.get(key).is_some_and(|value| !value.is_boolean()) { return Err(error(format!("{key} 必须是布尔值"))); }
    }
    if fields.get("kerning").is_some_and(|value| !matches!(value.as_str(), Some("metrics" | "optical" | "off"))) {
        return Err(error("字偶距模式无效"));
    }
    if fields.get("caps").is_some_and(|value| !matches!(value.as_str(), Some("normal" | "small" | "all"))) {
        return Err(error("大写模式无效"));
    }
    Ok(())
}

/// 把 `style` 子对象铺平到顶层，供 `apply_char_props`/`apply_para_props` 使用。
fn merge_style(params: &Value) -> Value {
    let Some(extra) = params.get("style").and_then(Value::as_object) else { return params.clone() };
    let mut merged = params.clone();
    if let Some(fields) = merged.as_object_mut() {
        fields.remove("style");
        for (key, value) in extra { fields.insert(key.clone(), value.clone()); }
    }
    merged
}

fn finite(params: &Value, key: &str) -> Result<f64> {
    params.get(key).and_then(Value::as_f64).filter(|v|v.is_finite() && v.abs()<=8192.0)
        .ok_or_else(||error(format!("{key} 必须是文档范围内的有限坐标")))
}

fn check_box(value:&Value)->Result<[f64;4]> {
    let values=value.as_array().filter(|values|values.len()==4)
        .ok_or_else(||error("段落框需要四个数值"))?;
    let mut out=[0.0;4];
    for (index,entry) in values.iter().enumerate() {
        out[index]=entry.as_f64().filter(|v|v.is_finite() && v.abs()<=8192.0)
            .ok_or_else(||error("段落框坐标必须是文档范围内的有限值"))?;
    }
    if out[2]<=0.0 || out[3]<=0.0 {return Err(error("段落框尺寸必须大于零"));}
    Ok(out)
}

impl TextPreview {
    pub fn new(base: &DocState, params: Value) -> Result<Self> {
        if !params.is_object() { return Err(error("文字会话参数必须是对象")); }
        if params.as_object().unwrap().keys().any(|key|!matches!(key.as_str(),"layer"|"x"|"y"|"box"|"forceNew")) {
            return Err(error("文字定位包含未开放的参数"));
        }
        if params.get("forceNew").is_some_and(|v|!v.is_boolean()) {return Err(error("新文字标志必须为布尔值"));}
        if params.get("layer").is_some() && params["forceNew"]==true {return Err(error("不能同时指定已有图层和新建文字"));}
        if params.get("layer").is_some() && (params.get("x").is_some() || params.get("y").is_some()) {finite(&params,"x")?;finite(&params,"y")?;}
        let original = if let Some(layer) = params.get("layer") {
            Some(LayerId(layer.as_u64().ok_or_else(||error("文字图层 id 无效"))?))
        } else {
            let (x,y)=(finite(&params,"x")?,finite(&params,"y")?);
            if x<0.0 || y<0.0 || x>=f64::from(base.doc.size.width) || y>=f64::from(base.doc.size.height) {
                return Err(error("请在图片内定位文字"));
            }
            // 拖出段落框时明确创建新文字；单击复用上游受控命中，不复制其命中算法。
            if params.get("box").is_some() || params["forceNew"]==true { None } else {
                photocraft_engine::pick_cmds::auto_select_target(&base.doc,x.floor() as i32,y.floor() as i32,false)
                    .filter(|id|base.doc.layer(*id).is_some_and(|layer|matches!(layer.content,LayerContent::Text(_))))
            }
        };
        if let Some(id)=original {
            let layer=base.doc.layer(id).ok_or_else(||error("文字图层不存在"))?;
            if !matches!(layer.content,LayerContent::Text(_)) { return Err(error("目标不是文字图层")); }
            let locks=base.doc.effective_locks(id);
            if locks.all || locks.pixels { return Err(error("文字图层已锁定，无法编辑")); }
        }
        if let Some(b)=params.get("box") {
            let b=b.as_array().filter(|b|b.len()==4).ok_or_else(||error("段落框需要四个数值"))?;
            if !b.iter().all(|v|v.as_f64().is_some_and(|v|v.is_finite() && v.abs()<=8192.0))
                || b[2].as_f64().unwrap()<=0.0 || b[3].as_f64().unwrap()<=0.0 {
                return Err(error("段落框尺寸必须大于零且不超过文档上限"));
            }
        }
        Ok(Self {defaults:None,base:base.clone(),initial:params,doc:base.doc.clone(),layer:original,original,layout:None,valid:true,checkpointed:false})
    }

    pub fn is_new(&self) -> bool { self.original.is_none() }

    pub fn geometry(&mut self, params: Value) -> Result<Value> {
        let text=self.layer.and_then(|id|self.doc.layer(id)).and_then(|layer| {
            if let LayerContent::Text(text)=&layer.content {Some(text)} else {None}
        }).ok_or_else(||error("请先预览文字内容，再定位输入"))?;
        let request=crate::text_geometry::request(&params,&text.text)?;
        if self.layout.is_none() {
            self.layout=Some(photocraft_text::shared().lock().unwrap_or_else(|e|e.into_inner()).layout(text,self.doc.resolution_dpi));
        }
        let mut out=crate::text_geometry::project(self.layout.as_ref().unwrap(),&text.text,text.transform,request)?;
        if let photocraft_doc::text::TextShape::Box{x,y,width,height}=text.shape {
            let corners=[(x,y),(x+width,y),(x+width,y+height),(x,y+height)].map(|(x,y)| {
                let p=text.transform.apply(photocraft_geom::Point::new(f64::from(x),f64::from(y)));
                [p.x,p.y]
            });
            out["frame"]=json!(corners);
        }
        Ok(out)
    }

    /// 只读投影，不调用 type.info 的布局或字形栅格化。
    pub fn info(&self) -> Value {
        if let Some((id,text))=self.layer.and_then(|id|self.doc.layer(id).map(|l|(id,&l.content)))
            .and_then(|(id,content)|if let LayerContent::Text(t)=content {Some((id,t))} else {None}) {
            return json!({"layer":id.0,"new":self.is_new(),"text":text.text,"shape":text.shape,"transform":text.transform.m,
                "orientation":if text.orientation==photocraft_doc::text::Orientation::Vertical{"vertical"}else{"horizontal"},"antialias":photocraft_engine::type_extra_cmds::aa_name(text.antialias),"character":text.char_runs().first().map(|r|&r.style),"paragraph":text.paragraph_runs().first().map(|r|&r.style),
                "pxPerPt":self.doc.resolution_dpi/72.0});
        }
        json!({"layer":null,"new":true,"text":"","placement":self.initial,"character":self.defaults.as_ref().map(|(character,_)|character),"paragraph":self.defaults.as_ref().map(|(_,paragraph)|paragraph),"pxPerPt":self.doc.resolution_dpi/72.0})
    }

    pub fn update(&mut self, params: Value) -> Result<()> {
        self.valid=false;self.checkpointed=false;
        let values=params.as_object().ok_or_else(||error("文字参数必须是对象"))?;
        // 此入口只合并首期文字内容与整层样式，不借会话开放路径文字或高级排版。
        if values.keys().any(|key|!matches!(key.as_str(),"text"|"font"|"size"|"color"|"fauxBold"|"align"|"antialias"|"orientation"|"box"|"style")) {
            return Err(error("文字会话包含未开放的参数"));
        }
        check_style(&params)?;
        if let Some(box_)=values.get("box") {check_box(box_)?;}
        if !params.get("text").is_some_and(Value::is_string) { return Err(error("文字内容必须是字符串")); }
        if params["text"].as_str().unwrap().len()>65_536 { return Err(error("文字超过本次编辑的长度上限")); }
        if params.get("font").is_some_and(|v|!matches!(v.as_str(),Some("Inter"|"Noto Sans SC"))) {
            return Err(error("字体尚未开放"));
        }
        if params.get("align").is_some_and(|v|!matches!(v.as_str(),Some("left"|"center"|"right"))) {
            return Err(error("文字对齐参数无效"));
        }
        if params.get("orientation").is_some_and(|v|!v.as_str().is_some_and(|s|matches!(s,"horizontal"|"vertical"))){return Err(error("文字方向无效"));}
        if params.get("antialias").is_some_and(|v|!v.as_str().is_some_and(|s|matches!(s,"none"|"sharp"|"crisp"|"strong"|"smooth"|"windowsLcd"|"windows"))){return Err(error("文字抗锯齿模式无效"));}
        if params.get("fauxBold").is_some_and(|v|!v.is_boolean()) { return Err(error("粗体参数必须是布尔值")); }
        if let Some(color)=params.get("color") {
            let valid=color.as_str().is_some_and(|s|s.len()==7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit));
            if !valid { return Err(error("文字颜色必须是 #rrggbb")); }
        }
        photocraft_engine::type_cmds::check_size_tracking(&params).map_err(error)?;
        self.preflight(&params)?;
        let mut scratch=Session::new();scratch.type_defaults=self.defaults.clone();
        scratch.add_document((*self.base.doc).clone(),None);
        *scratch.active_mut().unwrap()=self.base.clone();
        let layer=if let Some(id)=self.original {
            let mut edit=json!({"layer":id.0,"text":params["text"]});
            if let Some(box_)=params.get("box") {edit["box"]=box_.clone();}
            scratch.execute("type.edit",edit).map_err(error)?;
            let mut style=params.clone();style.as_object_mut().unwrap().remove("text");style.as_object_mut().unwrap().remove("antialias");style.as_object_mut().unwrap().remove("orientation");style.as_object_mut().unwrap().remove("box");
            // `style` 里的字段与顶层字段同形，展开进同一次 type.setStyle（引擎按字段应用）。
            if let Some(extra)=style.as_object_mut().unwrap().remove("style").and_then(|value|value.as_object().cloned()) {
                for (key,value) in extra {style[key]=value;}
            }
            style["layer"]=json!(id.0);
            if style.as_object().unwrap().len()>1 { scratch.execute("type.setStyle",style).map_err(error)?; }
            id
        } else {
            let mut create=self.initial.clone();
            create.as_object_mut().unwrap().remove("forceNew");
            for (key,value) in values {
                if key=="style" {if let Some(extra)=value.as_object(){for (inner,val) in extra {create[inner]=val.clone();}}}
                else {create[key]=value.clone();}
            }
            let result=scratch.execute("type.create",create).map_err(error)?;
            LayerId(result["layer"].as_u64().ok_or_else(||error("文字创建未返回图层"))?)
        };
        if let Some(mode)=params.get("orientation").and_then(Value::as_str){scratch.execute(&format!("type.orientation.{mode}"),json!({"layer":layer.0})).map_err(error)?;}
        if let Some(mode)=params.get("antialias").and_then(Value::as_str){scratch.execute(&format!("type.antiAlias.{mode}"),json!({"layer":layer.0})).map_err(error)?;}
        crate::text_antialias::validate_bounds(&scratch.active().unwrap().doc,&[layer.0],"type.edit")?;
        self.doc=scratch.active().unwrap().doc.clone();self.layer=Some(layer);self.layout=None;self.valid=true;
        Ok(())
    }

    /// Project just the allowed text/style fields and lay them out before native raster allocation.
    fn preflight(&self,params:&Value)->Result<()> {
        use photocraft_doc::text::{CharStyle,ParagraphStyle,TextRun,ParagraphRun,TextShape,Orientation};
        use photocraft_engine::type_cmds::{replace_text,style_range,style_paragraphs,apply_char_props,apply_para_props};
        let mut text=if let Some(id)=self.original {
            let LayerContent::Text(text)=&self.base.doc.layer(id).unwrap().content else{unreachable!()};
            let mut text=text.clone();let n=text.text.len();replace_text(&mut text,0,n,params["text"].as_str().unwrap());
            // 段落框缩放沿用上游 type.edit：保留线性部分，只改框尺寸与原点平移。
            if let Some([x,y,width,height])=params.get("box").map(check_box).transpose()? {
                let linear=text.transform.m;
                text.shape=TextShape::Box{x:0.,y:0.,width:width as f32,height:height as f32};
                text.transform=photocraft_geom::Affine{m:[linear[0],linear[1],linear[2],linear[3],x,y]};
            }
            text
        }else{
            let content=params["text"].as_str().unwrap().replace("\r\n","\n").replace('\r',"\n");
            let (character,paragraph)=self.defaults.clone().unwrap_or_else(||(CharStyle::default(),ParagraphStyle::default()));
            let candidate=params.get("box").or_else(||self.initial.get("box"));
            let shape=if let Some(b)=candidate.and_then(Value::as_array){TextShape::Box{x:0.,y:0.,width:b[2].as_f64().unwrap() as f32,height:b[3].as_f64().unwrap() as f32}}else{TextShape::Point};
            photocraft_doc::TextLayer{runs:vec![TextRun{len:content.len(),style:character}],paragraphs:vec![ParagraphRun{len:content.len(),style:paragraph}],text:content,shape,..Default::default()}
        };
        let n=text.text.len();
        // 候选样式同样投影 `style` 子对象，保证预检与提交看到同一组字段。
        let merged=merge_style(params);
        style_range(&mut text,0,n,&|style|{apply_char_props(style,&merged);});
        style_paragraphs(&mut text,0,n,&|style|{apply_para_props(style,&merged);});
        if let Some(mode)=params["orientation"].as_str(){text.orientation=if mode=="vertical"{Orientation::Vertical}else{Orientation::Horizontal};}
        text.sync_summary();
        let mut doc=(*self.base.doc).clone();let layer=photocraft_doc::Layer::new("Candidate",LayerContent::Text(text));let id=layer.id;doc.layers.push(layer);
        crate::text_antialias::validate_bounds(&doc,&[id.0],"type.edit")
    }

    /// 保存检查点后在正式文档上重新建立候选；不重新排版或栅格化。
    pub fn rebased(&self, base:&DocState) -> Result<Self> {
        let params=if let Some(id)=self.layer.filter(|id|base.doc.layer(*id).is_some()) {json!({"layer":id.0})} else {self.initial.clone()};
        let mut next=Self::new(base,params)?;next.defaults=self.defaults.clone();next.checkpointed=true;Ok(next)
    }

    pub fn require_valid(&self) -> Result<()> {
        if self.valid {Ok(())} else {Err(error("请修正文字参数或取消编辑"))}
    }

    pub fn commit(&self, session: &mut Session) -> Result<()> {
        self.require_valid()?;
        let doc=self.doc.clone();
        let Some(layer)=self.layer else {return Ok(())};
        // 新建后清空再确认不遗留空图层。
        if self.is_new() && doc.layer(layer).is_some_and(|l|matches!(&l.content,LayerContent::Text(t) if t.text.is_empty())) {return Ok(())}
        crate::preview_history::commit(session,doc,Some(Some(layer)),"编辑文字").map_err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Layer,TextLayer};
    fn session() -> (Session,LayerId) {
        let mut session=Session::new();
        session.execute("file.new",json!({"width":200,"height":100})).unwrap();
        let layer=Layer::new("标题",LayerContent::Text(TextLayer{text:"原文".into(),font_family:"Inter".into(),..Default::default()}));
        let id=layer.id;
        Arc::make_mut(&mut session.active_mut().unwrap().doc).layers.push(layer);
        (session,id)
    }
    #[test]
    fn snapshot_commit_has_one_step_and_preserves_the_undo_target() {
        let (mut session,id)=session();
        let before=session.active().unwrap().clone();
        let mut draft=TextPreview::new(&before,json!({"layer":id.0})).unwrap();
        assert_eq!(draft.info()["text"],"原文");
        // 直接构造文字领域草稿，不调用字形栅格化或合成。
        for content in ["中文草稿","确认内容"] {
            let layer=Arc::make_mut(&mut draft.doc).layer_mut(id).unwrap();
            let LayerContent::Text(text)=&mut layer.content else {panic!()};
            text.text=content.into();text.size_pt=36.0;
            text.shape=photocraft_doc::text::TextShape::Box{x:0.0,y:0.0,width:120.0,height:70.0};
        }
        assert_eq!(session.active().unwrap().revision,before.revision);
        assert_eq!(session.active().unwrap().history.past_len(),before.history.past_len());
        draft.commit(&mut session).unwrap();
        assert_eq!(session.active().unwrap().history.past_len(),before.history.past_len()+1);
        assert_eq!(session.active().unwrap().active_layer,Some(id));
        session.execute("edit.undo",Value::Null).unwrap();
        assert_eq!(session.active().unwrap().active_layer,before.active_layer);
        let LayerContent::Text(text)=&session.active().unwrap().doc.layer(id).unwrap().content else {panic!()};
        assert_eq!(text.text,"原文");
        session.execute("edit.redo",Value::Null).unwrap();
        let state=session.active().unwrap();
        let LayerContent::Text(text)=&state.doc.layer(id).unwrap().content else {panic!()};
        assert_eq!(text.text,"确认内容");assert_eq!(text.size_pt,36.0);
        let bytes=photocraft_format::save_to_bytes(&state.doc,&Default::default()).unwrap();
        let reopened=photocraft_format::load_from_bytes(&bytes).unwrap();
        let text=reopened.layers.iter().find_map(|layer|if let LayerContent::Text(t)=&layer.content {Some(t)} else {None}).unwrap();
        assert_eq!(text.text,"确认内容");
        assert!(matches!(text.shape,photocraft_doc::text::TextShape::Box{width:120.0,height:70.0,..}));
    }
    #[test]
    fn invalid_updates_keep_the_previous_draft_and_cannot_open_extra_capabilities() {
        let (mut session,id)=session();
        let before=session.active().unwrap().clone();
        let mut draft=TextPreview::new(&before,json!({"layer":id.0})).unwrap();
        let info=draft.info();
        // 非法查询须在调用文字排版前拒绝。
        assert!(draft.geometry(json!({"start":0,"end":0,"layer":id.0})).is_err());
        assert!(draft.layout.is_none());
        assert_eq!(draft.info(),info);
        for params in [json!({"text":4}),json!({"text":"x","orientation":"diagonal"}),json!({"text":"x","size":0}),
            json!({"text":"x","font":"unknown"}),json!({"text":"x","color":"red"}),json!({"text":"x","align":"justify"}),json!({"text":"x","fauxBold":1})] {
            assert!(draft.update(params).is_err());assert_eq!(draft.info(),info);
            assert!(draft.commit(&mut session).is_err());
        }
        assert!(TextPreview::new(&before,json!({"layer":id.0,"orientation":"vertical"})).is_err());
        assert!(TextPreview::new(&before,json!({"x":3,"y":4,"box":[3,4,-10,20]})).is_err());
        Arc::make_mut(&mut session.active_mut().unwrap().doc).layer_mut(id).unwrap().locks.all=true;
        assert!(TextPreview::new(session.active().unwrap(),json!({"layer":id.0})).is_err());
    }

    #[test]
    fn paragraph_input_frame_uses_native_text_transform_without_rendering() {
        let (session,id)=session();
        let before=session.active().unwrap().clone();
        let mut draft=TextPreview::new(&before,json!({"layer":id.0})).unwrap();
        let LayerContent::Text(text)=&mut Arc::make_mut(&mut draft.doc).layer_mut(id).unwrap().content else {panic!()};
        text.shape=photocraft_doc::text::TextShape::Box{x:2.0,y:3.0,width:20.0,height:10.0};
        text.transform=photocraft_geom::Affine{m:[0.0,2.0,-3.0,0.0,100.0,50.0]};
        // 注入纯布局数据，不调用文字引擎；仅核对段落框的仿射投影。
        draft.layout=Some(Default::default());
        let info=draft.info();
        let value=draft.geometry(json!({"start":0,"end":0})).unwrap();
        assert_eq!(value["frame"],json!([[91.0,54.0],[91.0,94.0],[61.0,94.0],[61.0,54.0]]));
        assert_eq!(draft.info(),info);
        assert!(Arc::ptr_eq(&session.active().unwrap().doc,&before.doc));
        assert_eq!(session.active().unwrap().revision,before.revision);
    }
}
#[cfg(test)] mod box_resize_tests{
 use super::*;
 fn paragraph()->(Session,LayerId){
  let mut s=Session::new();s.execute("file.new",json!({"width":200,"height":160})).unwrap();
  let id=s.execute("type.create",json!({"box":[20,20,80,40],"text":"one two three four five","size":10,"font":"Inter"})).unwrap()["layer"].as_u64().unwrap();
  (s,LayerId(id))
 }
 #[test] fn box_draft_shrinks_and_mirrors_about_the_original_centre_with_one_history_step(){
  let (mut s,id)=paragraph();let before=s.active().unwrap().clone();
  let mut draft=TextPreview::new(&before,json!({"layer":id.0})).unwrap();
  assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc),"打开草稿不写正式文档");
  // 拖右边中手柄：只改宽。
  draft.update(json!({"text":"one two three four five","box":[20,20,40,40]})).unwrap();
  let LayerContent::Text(text)=&draft.doc.layer(id).unwrap().content else{panic!()};
  assert!(matches!(text.shape,photocraft_doc::text::TextShape::Box{width,height,..} if (width-40.).abs()<1e-3 && (height-40.).abs()<1e-3));
  // Alt 以按下时中心对称缩放：中心 (60,40) 保持，左右各 30。
  draft.update(json!({"text":"one two three four five","box":[30,20,60,40]})).unwrap();
  let LayerContent::Text(text)=&draft.doc.layer(id).unwrap().content else{panic!()};
  assert!(matches!(text.shape,photocraft_doc::text::TextShape::Box{width,height,..} if (width-60.).abs()<1e-3 && (height-40.).abs()<1e-3));
  assert!(Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
  assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len());
  draft.commit(&mut s).unwrap();
  assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);
  s.execute("edit.undo",Value::Null).unwrap();
  assert_eq!(s.active().unwrap().doc,before.doc);
 }
 #[test] fn invalid_box_candidates_keep_the_previous_draft_and_cancel_commit(){
  let (mut s,id)=paragraph();let before=s.active().unwrap().clone();
  let mut draft=TextPreview::new(&before,json!({"layer":id.0})).unwrap();
  draft.update(json!({"text":"one two","box":[20,20,10,40]})).unwrap();
  let good=draft.doc.clone();
  for bad in [json!({"text":"one two","box":[20,20,0,40]}),json!({"text":"one two","box":[20,20,-5,40]}),
   json!({"text":"one two","box":[20,20,10]}),json!({"text":"one two","box":[20,20,10,40,50]}),
   json!({"text":"one two","box":[20,20,f64::INFINITY,40]}),json!({"text":"one two","box":[20,20,1e9,40]}),
   json!({"text":"one two","box":"10,10"})] {
   assert!(draft.update(bad.clone()).is_err(),"非法段落框必须拒绝：{bad}");
   assert!(draft.commit(&mut s).is_err());
   assert!(Arc::ptr_eq(&good,&draft.doc));
  }
  assert!(Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
 }
 #[test] fn point_text_stays_point_and_new_paragraph_drafts_take_the_candidate_box(){
  let mut s=Session::new();s.execute("file.new",json!({"width":200,"height":160})).unwrap();
  let before=s.active().unwrap().clone();
  let mut draft=TextPreview::new(&before,json!({"x":24,"y":40,"forceNew":true})).unwrap();
  draft.update(json!({"text":"Hi","font":"Inter","size":10})).unwrap();
  let LayerContent::Text(text)=&draft.doc.layer(draft.layer.unwrap()).unwrap().content else{panic!()};
  assert!(matches!(text.shape,photocraft_doc::text::TextShape::Point));
  // 新建段落草稿：候选 box 覆盖定位参数里的框。
  let mut draft=TextPreview::new(&before,json!({"x":10,"y":10,"box":[10,10,50,50],"forceNew":true})).unwrap();
  draft.update(json!({"text":"Hi","font":"Inter","size":10,"box":[12,14,70,30]})).unwrap();
  let LayerContent::Text(text)=&draft.doc.layer(draft.layer.unwrap()).unwrap().content else{panic!()};
  assert!(matches!(text.shape,photocraft_doc::text::TextShape::Box{width,height,..} if (width-70.).abs()<1e-3 && (height-30.).abs()<1e-3));
  assert!((text.transform.m[4]-12.).abs()<1e-3 && (text.transform.m[5]-14.).abs()<1e-3);
 }
}
#[cfg(test)] mod style_field_tests{
 use super::*;
 use photocraft_doc::{Layer,TextLayer};
 fn session()->(Session,LayerId){
  let mut s=Session::new();s.execute("file.new",json!({"width":240,"height":120})).unwrap();
  let layer=Layer::new("样式",LayerContent::Text(TextLayer{text:"样式文字".into(),font_family:"Inter".into(),size_pt:24.0,..Default::default()}));
  let id=layer.id;Arc::make_mut(&mut s.active_mut().unwrap().doc).layers.push(layer);(s,id)
 }
 #[test] fn character_and_paragraph_fields_reach_the_native_draft_without_writing(){
  let (mut s,id)=session();let before=s.active().unwrap().clone();
  let mut draft=TextPreview::new(&before,json!({"layer":id.0})).unwrap();
  draft.update(json!({"text":"样式文字","style":{
   "tracking":120.0,"leading":30.0,"baselineShift":2.0,"horizontalScale":90.0,"verticalScale":110.0,
   "weight":700,"italic":true,"underline":true,"strikethrough":false,"fauxItalic":true,
   "ligatures":false,"discretionaryLigatures":true,"kerning":"optical",
   "firstLineIndent":12.0,"startIndent":6.0,"endIndent":4.0,"spaceBefore":3.0,"spaceAfter":5.0,"hyphenate":true
  }})).unwrap();
  let LayerContent::Text(text)=&draft.doc.layer(id).unwrap().content else{panic!()};
  let character=&text.char_runs()[0].style;let paragraph=&text.paragraph_runs()[0].style;
  assert_eq!(character.tracking,120.0);assert_eq!(character.leading_pt,Some(30.0));
  assert_eq!(character.baseline_shift_pt,2.0);assert_eq!(character.horizontal_scale,0.9);
  assert_eq!(character.vertical_scale,1.1);assert_eq!(character.weight,700);
  assert!(character.italic && character.underline && character.faux_italic);
  assert!(!character.ligatures && character.discretionary_ligatures);
  assert_eq!(paragraph.first_line_indent_pt,12.0);assert_eq!(paragraph.start_indent_pt,6.0);
  assert_eq!(paragraph.end_indent_pt,4.0);assert_eq!(paragraph.space_before_pt,3.0);
  assert_eq!(paragraph.space_after_pt,5.0);assert!(paragraph.hyphenate);
  // 草稿未写正式文档；提交后只记一步并可撤销。
  assert!(Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
  draft.commit(&mut s).unwrap();
  assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);
  s.execute("edit.undo",Value::Null).unwrap();
  assert_eq!(s.active().unwrap().doc,before.doc);
 }
 #[test] fn out_of_range_and_unknown_style_fields_are_refused_before_writing(){
  let (mut s,id)=session();let before=s.active().unwrap().clone();
  let mut draft=TextPreview::new(&before,json!({"layer":id.0})).unwrap();
  draft.update(json!({"text":"x","style":{"tracking":40.0}})).unwrap();
  let good=draft.doc.clone();
  for bad in [
   json!({"text":"x","style":{"tracking":-1001.0}}),json!({"text":"x","style":{"tracking":10001.0}}),
   json!({"text":"x","style":{"leading":0.0}}),json!({"text":"x","style":{"baselineShift":6000.0}}),
   json!({"text":"x","style":{"horizontalScale":0.5}}),json!({"text":"x","style":{"weight":50}}),
   json!({"text":"x","style":{"italic":"yes"}}),json!({"text":"x","style":{"kerning":"auto"}}),
   json!({"text":"x","style":{"warp":true}}),json!({"text":"x","style":"bold"}),
   json!({"text":"x","style":{"spaceBefore":-1.0}}),json!({"text":"x","warp":{}})
  ] {
   assert!(draft.update(bad.clone()).is_err(),"必须拒绝：{bad}");
   assert!(draft.commit(&mut s).is_err());
   assert!(Arc::ptr_eq(&good,&draft.doc),"非法样式不得替换上一候选");
  }
  assert!(Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
 }
 #[test] fn new_text_drafts_apply_style_fields_on_create(){
  let mut s=Session::new();s.execute("file.new",json!({"width":200,"height":120})).unwrap();
  let before=s.active().unwrap().clone();
  let mut draft=TextPreview::new(&before,json!({"x":10,"y":30,"forceNew":true})).unwrap();
  draft.update(json!({"text":"新文字","font":"Inter","size":18,"style":{"tracking":80.0,"leading":24.0}})).unwrap();
  let LayerContent::Text(text)=&draft.doc.layer(draft.layer.unwrap()).unwrap().content else{panic!()};
  assert_eq!(text.char_runs()[0].style.tracking,80.0);
  assert_eq!(text.char_runs()[0].style.leading_pt,Some(24.0));
  assert!(Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
 }
}
#[cfg(test)] mod antialias_tests{
 use super::*;
 #[test] fn aa_drafts_cancel_invalid_candidates_and_publish_only_one_history_step(){
  let mut s=Session::new();s.execute("file.new",json!({"width":64,"height":32})).unwrap();let result=s.execute("type.create",json!({"text":"Aa","x":1,"y":12,"size":10,"font":"Inter"})).unwrap();let id=result["layer"].as_u64().unwrap();let before=s.active().unwrap().clone();
  let mut draft=TextPreview::new(&before,json!({"layer":id})).unwrap();draft.update(json!({"text":"Aa","antialias":"none"})).unwrap();assert_eq!(draft.info()["antialias"],"none");assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));assert!(draft.update(json!({"text":"Aa","antialias":"invalid"})).is_err());assert!(draft.commit(&mut s).is_err());assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));
  draft.update(json!({"text":"Aa","antialias":"windowsLcd"})).unwrap();draft.commit(&mut s).unwrap();assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);let bytes=photocraft_format::save_to_bytes(&s.active().unwrap().doc,&Default::default()).unwrap();photocraft_project_verify::verify(&bytes).unwrap();s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);
 }
}
#[cfg(test)] mod orientation_tests{
 use super::*;
 #[test] fn new_point_and_paragraph_vertical_drafts_create_one_formal_step_only(){
  for box_ in [false,true]{let mut s=Session::new();s.execute("file.new",json!({"width":64,"height":64})).unwrap();let before=s.active().unwrap().clone();let mut placement=json!({"x":16,"y":4,"forceNew":true});if box_{placement["box"]=json!([16,4,24,32]);}let mut draft=TextPreview::new(&before,placement).unwrap();draft.update(json!({"text":"Ab中","font":"Inter","size":10,"orientation":"vertical"})).unwrap();assert_eq!(draft.info()["orientation"],"vertical");assert!(std::sync::Arc::ptr_eq(&before.doc,&s.active().unwrap().doc));assert!(draft.update(json!({"text":"Ab","orientation":"diagonal"})).is_err());assert!(draft.commit(&mut s).is_err());draft.update(json!({"text":"Ab中","font":"Inter","size":10,"orientation":"vertical"})).unwrap();draft.commit(&mut s).unwrap();assert_eq!(s.active().unwrap().history.past_len(),before.history.past_len()+1);s.execute("edit.undo",Value::Null).unwrap();assert_eq!(s.active().unwrap().doc,before.doc);}
 }
}
