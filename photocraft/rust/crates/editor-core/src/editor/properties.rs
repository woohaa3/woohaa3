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
