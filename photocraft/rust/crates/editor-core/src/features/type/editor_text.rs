use super::*;

#[path = "domain.rs"]
mod type_domain;

impl Editor {
    /// 进入文字草稿不更改正式活动层、修订、指纹或撤销分支。
    pub fn begin_text(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        // 文字草稿走自己的 scratch 会话，不经 `execute`；模式门禁必须在这里也生效，否则
        // 索引色/位图文档能通过草稿路径写入失败颜色（change: 2026-10-22-add-photocraft-image-mode-workflows）。
        if let Some(state) = self.session.active() {
            crate::features::modes::gate::check(&state.doc, "type.create", &params)?;
        }
        let draft=crate::text_preview::TextPreview::new(self.active_doc()?,params)?;
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

    pub fn cancel_text(&mut self) {self.text_preview=None;}
}
