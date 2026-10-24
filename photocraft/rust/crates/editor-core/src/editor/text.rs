use super::*;

impl Editor {
    pub fn missing_fonts(&self)->Result<Vec<String>> {Ok(photocraft_engine::type_extra_cmds::missing_fonts(&self.active_doc()?.doc))}

    /// 进入文字草稿不更改正式活动层、修订、指纹或撤销分支。
    pub fn begin_text(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let mut draft=crate::text_preview::TextPreview::new(self.active_doc()?,params)?;draft.defaults=self.session.type_defaults.clone();
        if let Some(id)=draft.layer {crate::layer_preview::require_visible(self.active_doc()?,&[id],"type.edit")?;}
        if draft.is_new() {self.check_layer_capacity()?;}
        let info=draft.info();self.text_preview=Some(draft);Ok(info)
    }

    pub fn preview_text(&mut self, params: Value) -> Result<Value> {
        let draft=self.text_preview.as_mut().ok_or_else(||crate::text_preview::error("没有活动文字编辑"))?;
        draft.update(params)?;Ok(draft.info())
    }

    /// 只查询活动文字草稿的精确输入几何，不改变正式文档或撤销栈。
    pub fn text_geometry(&mut self, params: Value) -> Result<Value> {
        self.text_preview.as_mut().ok_or_else(||crate::text_preview::error("没有活动文字编辑"))?.geometry(params)
    }

    pub fn commit_text(&mut self) -> Result<Value> {
        let draft=self.text_preview.as_ref().ok_or_else(||crate::text_preview::error("没有活动文字编辑"))?;
        draft.require_valid()?;
        let draft_hash=document_content::document_content_hash(&draft.doc,&self.registry)
            .ok_or_else(||crate::text_preview::error("文字草稿无法计算内容指纹"))?;
        let changed=draft_hash != self.content_hash()?;
        let has_target=draft.layer.is_some();
        if changed {draft.commit(&mut self.session)?;}
        self.text_preview=None;
        if has_target {
            self.session.execute("view.layerMask",json!({"mode":"off"})).map_err(crate::text_preview::error)?;
            self.session.execute("channel.target.composite",Value::Null).map_err(crate::text_preview::error)?;
        }
        self.active_json()
    }

    /// 将当前候选发布为可保存检查点，再保留同一文字目标继续编辑。
    /// scratch 中完成历史与重新建草稿，任一失败均不发布正式状态。
    pub fn checkpoint_text(&mut self) -> Result<Value> {
        let draft=self.text_preview.as_ref().ok_or_else(||crate::text_preview::error("没有活动文字编辑"))?;
        draft.require_valid()?;
        let state=self.active_doc()?;
        let hash=document_content::document_content_hash(&draft.doc,&self.registry)
            .ok_or_else(||crate::text_preview::error("文字草稿无法计算内容指纹"))?;
        let mut scratch=photocraft_engine::Session::new();
        scratch.add_document((*state.doc).clone(),None);
        *scratch.active_mut().unwrap()=state.clone();
        if hash!=self.content_hash()? {draft.commit(&mut scratch)?;}
        let candidate=scratch.active().unwrap().clone();
        let next=draft.rebased(&candidate)?;
        let info=next.info();
        *self.session.active_mut().ok_or(EditorError::NoDocument)?=candidate;
        self.text_preview=Some(next);
        Ok(info)
    }

    pub fn cancel_text(&mut self) {self.text_preview=None;}
}
