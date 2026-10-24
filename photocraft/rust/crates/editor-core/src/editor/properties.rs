use super::*;

impl Editor {
    /// 调整预览独立于正式状态；所有写入口和导出均受同一草稿门禁保护。
    pub fn begin_adjustment(&mut self, layer: u64) -> Result<Value> {
        self.require_no_stroke()?;
        let draft=crate::adjustment_preview::AdjustmentPreview::new(self.active_doc()?,layer)?;
        let info=draft.info();self.adjustment_preview=Some(draft);Ok(info)
    }

    pub fn preview_adjustment(&mut self, params: Value) -> Result<Value> {
        let draft=self.adjustment_preview.as_mut().ok_or_else(||crate::adjustment_preview::error("没有活动调整参数编辑"))?;
        draft.update(params)?;Ok(draft.info())
    }

    pub fn commit_adjustment(&mut self) -> Result<Value> {
        let draft=self.adjustment_preview.as_ref().ok_or_else(||crate::adjustment_preview::error("没有活动调整参数编辑"))?;
        draft.require_valid()?;
        let hash=document_content::document_content_hash(&draft.doc,&self.registry)
            .ok_or_else(||crate::adjustment_preview::error("调整草稿无法计算内容指纹"))?;
        if hash!=self.content_hash()? {draft.commit(&mut self.session)?;}
        self.adjustment_preview=None;
        self.active_json()
    }

    pub fn cancel_adjustment(&mut self) {self.adjustment_preview=None;}

    pub fn begin_layer_properties(&mut self, layer:u64) -> Result<Value> {
        self.require_no_stroke()?;
        let draft=crate::layer_properties_preview::LayerPropertiesPreview::new(self.active_doc()?,layer)?.with_patterns(&self.session.patterns.items).with_patterns(&self.pattern_library.patterns());
        let info=draft.start_info();self.layer_properties_preview=Some(draft);Ok(info)
    }
    pub fn begin_layer_visibility(&mut self,layer:u64)->Result<Value> {
        self.require_no_stroke()?;
        if !crate::capability::command_allowed("layer.setProps") {return Err(EditorError::CapabilityDisabled("layer.setProps".into()));}
        let draft=crate::layer_properties_preview::LayerPropertiesPreview::visibility(self.active_doc()?,layer)?;
        let info=draft.info();self.layer_properties_preview=Some(draft);Ok(info)
    }
    pub fn preview_layer_properties(&mut self,params:Value) -> Result<Value> {
        let draft=self.layer_properties_preview.as_mut().ok_or_else(||crate::layer_properties_preview::error("没有活动图层属性编辑"))?;
        draft.update(params)?;Ok(draft.info())
    }
    /// 只读活动样式的原生定位帧，不发布文档或历史。
    pub fn style_position_frame(&self,index:u32)->Result<Value> {
        self.layer_properties_preview.as_ref().ok_or_else(||crate::layer_properties_preview::error("没有活动图层属性编辑"))?
            .position_frame(index as usize)
    }
    pub fn commit_layer_properties(&mut self) -> Result<Value> {
        let draft=self.layer_properties_preview.as_ref().ok_or_else(||crate::layer_properties_preview::error("没有活动图层属性编辑"))?;
        draft.require_valid()?;
        let hash=document_content::document_content_hash(&draft.doc,&self.registry)
            .ok_or_else(||crate::layer_properties_preview::error("图层属性草稿无法计算内容指纹"))?;
        if hash!=self.content_hash()? {draft.commit(&mut self.session)?;}
        self.layer_properties_preview=None;self.active_json()
    }
    pub fn cancel_layer_properties(&mut self) {self.layer_properties_preview=None;}

    pub fn pattern_library(&self)->Value {
        let mut value=json!({"presets":self.pattern_library.list()});
        if let Some(draft)=&self.layer_properties_preview {value["patternPresets"]=draft.start_info()["patternPresets"].clone();}
        else {
            let mut patterns=self.session.patterns.items.iter().collect::<Vec<_>>();
            if let Some(state)=self.session.active(){patterns.extend(state.doc.patterns.iter());}
            let mut seen=std::collections::HashSet::new();
            value["patternPresets"]=json!(patterns.into_iter().filter(|p|seen.insert(p.id.clone())).map(|p|json!({"id":p.id,"name":p.name,"width":p.width,"height":p.height})).collect::<Vec<_>>());
        }
        value
    }
    fn refresh_pattern_library(&mut self)->Value {
        if let Some(draft)=&mut self.layer_properties_preview {
            let mut patterns=self.session.patterns.items.clone();patterns.extend(self.pattern_library.patterns());
            draft.replace_library_patterns(&patterns);
        }
        self.pattern_library()
    }
    pub fn import_pattern_presets(&mut self,bytes:&[u8])->Result<Value> {
        let incoming=crate::pattern_presets::import(bytes)?;
        self.pattern_library.append(incoming,&self.session.patterns.items)?;
        Ok(self.refresh_pattern_library())
    }
    pub fn rename_pattern_preset(&mut self,key:&str,name:&str)->Result<Value> {
        self.pattern_library.rename(key,name)?;Ok(self.refresh_pattern_library())
    }
    pub fn delete_pattern_preset(&mut self,key:&str)->Result<Value> {
        self.pattern_library.remove(key)?;Ok(self.refresh_pattern_library())
    }
    pub fn export_pattern_presets(&self,key:Option<&str>)->Result<Vec<u8>> {self.pattern_library.export_pat(key)}
    pub fn pattern_library_snapshot(&self)->Result<Vec<u8>> {self.pattern_library.snapshot()}
    pub fn restore_pattern_library(&mut self,bytes:&[u8])->Result<Value> {
        self.pattern_library.restore(bytes,&self.session.patterns.items)?;Ok(self.refresh_pattern_library())
    }

    pub fn curve_geometry(&self, points: Value) -> Result<Value> {
        crate::adjustment_preview::curve_geometry(&points)
    }
}

impl super::Editor {
    /// Define from the formal document composite; library edits never enter document history.
    pub(super) fn define_pattern(&mut self,params:serde_json::Value)->crate::Result<serde_json::Value> {
        use serde_json::json;
        let fail=|message:&str|crate::EditorError::CommandFailed{id:"edit.definePattern".into(),message:message.into()};
        let fields=params.as_object().filter(|fields|fields.keys().all(|key|key=="name")).ok_or_else(||fail("定义图案只接受名称"))?;
        let name=fields.get("name").and_then(serde_json::Value::as_str).map(str::trim).filter(|name|!name.is_empty() && name.encode_utf16().count()<=200 && !name.chars().any(char::is_control)).ok_or_else(||fail("图案名称须为1–200字符，不能包含控制字符"))?;
        let base=self.active_doc()?;
        if self.session.active_job().is_some(){return Err(fail("请先结束后台任务"));}
        let bounds=base.doc.selection.as_ref().map_or(base.doc.bounds(),|selection|selection.content_bounds()).intersect(&base.doc.bounds());
        if bounds.is_empty() || bounds.width()>1024 || bounds.height()>1024 {return Err(fail("图案范围须为1–1024像素；请缩小选区"));}
        let patterns=self.pattern_library.patterns();
        let pixels=patterns.iter().fold(0u64,|total,pattern|total.saturating_add(u64::from(pattern.width)*u64::from(pattern.height)));
        if patterns.len()>=64 || pixels.saturating_add(u64::from(bounds.width())*u64::from(bounds.height()))>4_194_304 {return Err(fail("用户图案库最多64项、累计4,194,304像素"));}
        let mut scratch=photocraft_engine::Session::new();scratch.add_document((*base.doc).clone(),None);*scratch.active_mut().unwrap()=base.clone();
        let result=scratch.execute("edit.definePattern",json!({"name":name})).map_err(|error|fail(&error.to_string()))?;
        let id=result["pattern"].as_str().ok_or_else(||fail("引擎未返回图案身份"))?;
        let pattern=scratch.patterns.items.into_iter().find(|pattern|pattern.id==id).ok_or_else(||fail("引擎未返回图案资源"))?;
        self.pattern_library.append(vec![pattern],&self.session.patterns.items)?;
        Ok(self.refresh_pattern_library())
    }
}
