//! 文字内容和样式共用一个草稿；预览复用上游文字命令，确认只写一步历史。
use std::sync::Arc;
use photocraft_doc::{Document, LayerContent, LayerId};
use photocraft_engine::{DocState, Session};
use serde_json::{Value, json};
use crate::error::{EditorError, Result};

pub(crate) struct TextPreview {
    base: DocState,
    initial: Value,
    pub doc: Arc<Document>,
    pub layer: Option<LayerId>,
    original: Option<LayerId>,
    layout: Option<photocraft_text::TextLayout>,
    valid: bool,
}

pub(crate) fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "type.edit".into(), message: message.to_string() }
}

fn finite(params: &Value, key: &str) -> Result<f64> {
    params.get(key).and_then(Value::as_f64).filter(|v|v.is_finite() && v.abs()<=8192.0)
        .ok_or_else(||error(format!("{key} 必须是文档范围内的有限坐标")))
}

impl TextPreview {
    pub fn new(base: &DocState, params: Value) -> Result<Self> {
        if !params.is_object() { return Err(error("文字会话参数必须是对象")); }
        if params.as_object().unwrap().keys().any(|key|!matches!(key.as_str(),"layer"|"x"|"y"|"box")) {
            return Err(error("文字定位包含未开放的参数"));
        }
        let original = if let Some(layer) = params.get("layer") {
            Some(LayerId(layer.as_u64().ok_or_else(||error("文字图层 id 无效"))?))
        } else {
            let (x,y)=(finite(&params,"x")?,finite(&params,"y")?);
            if x<0.0 || y<0.0 || x>=f64::from(base.doc.size.width) || y>=f64::from(base.doc.size.height) {
                return Err(error("请在图片内定位文字"));
            }
            // 拖出段落框时明确创建新文字；单击复用上游受控命中，不复制其命中算法。
            if params.get("box").is_some() { None } else {
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
        Ok(Self {base:base.clone(),initial:params,doc:base.doc.clone(),layer:original,original,layout:None,valid:true})
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
                "character":text.char_runs().first().map(|r|&r.style),"paragraph":text.paragraph_runs().first().map(|r|&r.style),
                "pxPerPt":self.doc.resolution_dpi/72.0});
        }
        json!({"layer":null,"new":true,"text":"","placement":self.initial,"pxPerPt":self.doc.resolution_dpi/72.0})
    }

    pub fn update(&mut self, params: Value) -> Result<()> {
        self.valid=false;
        let values=params.as_object().ok_or_else(||error("文字参数必须是对象"))?;
        // 此入口只合并首期文字内容与整层样式，不借会话开放路径文字或高级排版。
        if values.keys().any(|key|!matches!(key.as_str(),"text"|"font"|"size"|"color"|"fauxBold"|"align")) {
            return Err(error("文字会话包含未开放的参数"));
        }
        if !params.get("text").is_some_and(Value::is_string) { return Err(error("文字内容必须是字符串")); }
        if params["text"].as_str().unwrap().len()>65_536 { return Err(error("文字超过本次编辑的长度上限")); }
        if params.get("font").is_some_and(|v|!matches!(v.as_str(),Some("Inter"|"Noto Sans SC"))) {
            return Err(error("字体尚未开放"));
        }
        if params.get("align").is_some_and(|v|!matches!(v.as_str(),Some("left"|"center"|"right"))) {
            return Err(error("文字对齐参数无效"));
        }
        if params.get("fauxBold").is_some_and(|v|!v.is_boolean()) { return Err(error("粗体参数必须是布尔值")); }
        if let Some(color)=params.get("color") {
            let valid=color.as_str().is_some_and(|s|s.len()==7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit));
            if !valid { return Err(error("文字颜色必须是 #rrggbb")); }
        }
        photocraft_engine::type_cmds::check_size_tracking(&params).map_err(error)?;
        let mut scratch=Session::new();
        scratch.add_document((*self.base.doc).clone(),None);
        *scratch.active_mut().unwrap()=self.base.clone();
        let layer=if let Some(id)=self.original {
            scratch.execute("type.edit",json!({"layer":id.0,"text":params["text"]})).map_err(error)?;
            let mut style=params.clone();style.as_object_mut().unwrap().remove("text");style["layer"]=json!(id.0);
            if values.len()>1 { scratch.execute("type.setStyle",style).map_err(error)?; }
            id
        } else {
            let mut create=self.initial.clone();
            for (key,value) in values {create[key]=value.clone();}
            let result=scratch.execute("type.create",create).map_err(error)?;
            LayerId(result["layer"].as_u64().ok_or_else(||error("文字创建未返回图层"))?)
        };
        self.doc=scratch.active().unwrap().doc.clone();self.layer=Some(layer);self.layout=None;self.valid=true;
        Ok(())
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
        for params in [json!({"text":4}),json!({"text":"x","orientation":"vertical"}),json!({"text":"x","size":0}),
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
