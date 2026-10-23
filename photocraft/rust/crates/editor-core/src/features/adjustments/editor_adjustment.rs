use super::*;

impl Editor {
    /// 调整预览独立于正式状态；所有写入口和导出均受同一草稿门禁保护。
    ///
    /// 同一草稿槽同时承载「调整图层参数」与「直接像素调整」两种目标（U40）：两者都遵守
    /// begin → preview → commit/cancel 与「无变化不增历史」，所以保存/切文档/关闭门禁只有一份。
    pub fn begin_adjustment(&mut self, layer: u64) -> Result<Value> {
        self.require_no_stroke()?;
        let draft=crate::adjustment_preview::AdjustmentPreview::new(self.active_doc()?,layer)?;
        let info=draft.info();self.adjustment_preview=Some(draft);Ok(info)
    }

    /// 图像 ▸ 调整（直接作用于像素的调整）：目标可写像素层 + 已开放命令 + 合法参数。
    ///
    /// 跨文档匹配颜色按会话文档索引取来源统计，所以这里把**其它**文档的冻结快照一起交给草稿；
    /// 快照只在本域内使用，预览/确认都只发布本文档。
    pub fn begin_direct_adjustment(&mut self, target: &str, params: Value, layer: Option<u64>) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let active=self.session.active_index().unwrap_or(0);
        let sources:Vec<(usize,std::sync::Arc<photocraft_doc::Document>)>=self.session.documents().iter().enumerate()
            .filter(|(index,_)|*index!=active)
            .map(|(index,state)|(index,state.doc.clone()))
            .collect();
        let base=self.active_doc()?;
        let draft=crate::adjustment_preview::AdjustmentPreview::new_pixels_in_session(base,active,&sources,target,&params,layer)?;
        let info=draft.info();self.adjustment_preview=Some(draft);Ok(info)
    }

    /// 直接调整可用的目标（逐类调整的类型与自动/匹配命令），只列出已开放命令。
    ///
    /// `documents` 是会话里可作为匹配来源的文档（索引 + 名称 + 是否当前），界面据此让用户选
    /// 跨文档来源；它来自内核自己的会话，不依赖共享视图模型。
    pub fn direct_adjustment_targets(&self) -> Value {
        use crate::features::adjustments::direct_adjustment as domain;
        let active=self.session.active_index();
        json!({
            "kinds": domain::open_kinds(),
            "commands": domain::open_commands(),
            "allKinds": domain::ADJUSTMENT_KINDS,
            "allCommands": domain::ADJUSTMENT_COMMANDS,
            "documents": self.session.documents().iter().enumerate().map(|(index,state)|json!({
                "index": index,
                "name": state.doc.name,
                "width": state.doc.size.width,
                "height": state.doc.size.height,
                "active": Some(index)==active,
            })).collect::<Vec<_>>(),
        })
    }

    pub fn preview_adjustment(&mut self, params: Value) -> Result<Value> {
        let draft=self.adjustment_preview.as_mut().ok_or_else(||crate::adjustment_preview::error("没有活动调整参数编辑"))?;
        draft.update(params)?;Ok(draft.info())
    }

    pub fn commit_adjustment(&mut self) -> Result<Value> {
        let draft=self.adjustment_preview.as_ref().ok_or_else(||crate::adjustment_preview::error("没有活动调整参数编辑"))?;
        draft.require_valid()?;
        // 判据是草稿文档本身，不是内容指纹：指纹投影在共享 `identity.rs` 里，还没有覆盖本
        // change 新增的持久参数（输出端点/色域/Tint/铅笔映射），按指纹判断会静默丢改动。
        if draft.changed() {draft.commit(&mut self.session)?;}
        self.adjustment_preview=None;
        self.active_json()
    }

    pub fn cancel_adjustment(&mut self) {self.adjustment_preview=None;}

}
