use super::*;

impl Editor {
    pub fn begin_transform(&mut self) -> Result<()> {
        self.require_no_stroke()?;
        let state = self.active_doc()?;
        if crate::layer_preview::transform_targets(state).iter().any(|id| photocraft_engine::transform_cmds::locked_for_transform(&state.doc,*id)) {
            return Err(crate::transform_preview::error("所选图层包含锁定位置的图层，无法变换"));
        }
        if let Some(reason) = self.session.disabled_reason("edit.transform") {
            return Err(crate::transform_preview::error(reason));
        }
        self.transform_preview = Some(crate::transform_preview::TransformPreview::new(self.active_doc()?));
        Ok(())
    }

    /// 选区边界草稿独立于图层内容与锁定状态。
    pub fn begin_selection_transform(&mut self) -> Result<()> {
        self.require_no_stroke()?;
        if self.active_doc()?.doc.selection.as_ref().is_none_or(|s| s.content_bounds().is_empty()) {
            return Err(crate::transform_preview::error("没有可变换的选区"));
        }
        let mut draft = crate::transform_preview::TransformPreview::new(self.active_doc()?);
        draft.selection_only = true;
        self.transform_preview = Some(draft);
        Ok(())
    }

    /// 移动工具复用内核自动选层；只在确实有可移动目标时创建草稿。
    pub fn begin_move(&mut self, params: Value) -> Result<bool> {
        self.require_no_stroke()?;
        let number = |key: &str| params[key].as_f64().filter(|v| v.is_finite())
            .ok_or_else(|| crate::transform_preview::error("移动坐标必须为有限数值"));
        let (x, y) = (number("x")?, number("y")?);
        let auto = params["autoSelect"].as_bool().unwrap_or(false);
        if auto && !crate::layer_preview::mask_target(self.active_doc()?) {
            let doc = &self.active_doc()?.doc;
            if !doc.bounds().contains(x.floor() as i32, y.floor() as i32) { return Ok(false); }
            let Some(id) = photocraft_engine::pick_cmds::auto_select_target(doc, x.floor() as i32, y.floor() as i32, false) else { return Ok(false); };
            if !self.active_doc()?.is_layer_selected(id) {
                self.execute("layer.select", json!({"layer":id.0,"mode":"replace"}))?;
            }
        }
        let state = self.active_doc()?;
        let Some(id) = state.active_layer else { return Ok(false); };
        if crate::layer_preview::transform_targets(state).iter().any(|id|photocraft_engine::transform_cmds::locked_for_transform(&state.doc,*id)) {
            return Err(crate::transform_preview::error("当前图层已锁定位置，无法移动"));
        }
        if state.doc.layer(id).is_none() { return Ok(false); }
        if crate::layer_preview::transform_frame(state).is_empty() { return Ok(false); }
        let duplicate = params["duplicate"].as_bool().unwrap_or(false);
        if duplicate { self.check_layer_capacity_for(crate::layer_preview::target_layer_count(&state.doc, &crate::layer_preview::transform_targets(state)))?; }
        self.begin_transform()?;
        self.transform_preview.as_mut().unwrap().duplicate = duplicate;
        Ok(true)
    }

    pub fn preview_transform(&mut self, matrix: Value) -> Result<()> {
        self.transform_preview.as_mut().ok_or_else(|| crate::transform_preview::error("没有正在进行的自由变换"))?.update(matrix)
    }

    pub fn commit_transform(&mut self) -> Result<Value> {
        let draft=self.transform_preview.as_ref().ok_or_else(||crate::transform_preview::error("没有正在进行的自由变换"))?;
        draft.require_valid()?;
        if draft.params.is_some() {
            let content_changed=document_content::document_content_hash(&draft.doc,&self.registry)
                .ok_or_else(||crate::transform_preview::error("变换草稿无法计算内容指纹"))? != self.content_hash()?;
            // 选区属于视图状态，不进入内容指纹，但选区变换仍可独立撤销。
            let selection_changed=self.active_doc()?.doc.selection.as_ref().map(document_content::surface_hash)
                != draft.doc.selection.as_ref().map(document_content::surface_hash);
            if content_changed || selection_changed {draft.commit(&mut self.session)?;}
        }
        self.transform_preview=None;
        Ok(Value::Null)
    }

    pub fn cancel_transform(&mut self) { self.transform_preview = None; }
}
