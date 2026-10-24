use super::*;

impl Editor {
    /// Native Auto-Select candidate and bounds; never changes selection or history.
    pub fn move_hover_at(&self,params:Value)->Result<Value>{
        self.require_no_stroke()?;
        let fail=|message:&str|EditorError::CommandFailed{id:"layer.hoverAt".into(),message:message.into()};
        let fields=params.as_object().ok_or_else(||fail("悬停参数必须为对象"))?;
        if fields.keys().any(|key|!matches!(key.as_str(),"x"|"y"|"target")){return Err(fail("悬停包含未知参数"));}
        let coordinate=|key:&str|params[key].as_f64().filter(|n|n.is_finite()&&*n>=i32::MIN as f64&&*n<i32::MAX as f64).ok_or_else(||fail("悬停坐标无效"));
        let x=coordinate("x")?.floor() as i32;let y=coordinate("y")?.floor() as i32;
        if params.get("target").is_some_and(|value|!matches!(value.as_str(),Some("layer"|"group"))){return Err(fail("悬停目标无效"));}
        let base=self.active_doc()?;
        let Some(id)=photocraft_engine::pick_cmds::auto_select_target(&base.doc,x,y,params["target"]=="group")else{return Ok(Value::Null)};
        let layer=base.doc.layer(id).ok_or_else(||fail("候选图层已不存在"))?;
        let frame=photocraft_engine::transform_cmds::transform_frame(&base.doc,layer);
        if frame.is_empty(){return Ok(Value::Null);}
        Ok(json!({"layer":id.0,"frame":[frame.x0,frame.y0,frame.x1,frame.y1]}))
    }

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
        for key in ["autoSelect","duplicate","add","wholeLayer","selectedPixels"] {if params.get(key).is_some_and(|value|!value.is_boolean()) {return Err(crate::transform_preview::error("移动修饰键必须为布尔值"));}}
        let group=match params.get("target").and_then(Value::as_str) {None|Some("layer")=>false,Some("group")=>true,_=>return Err(crate::transform_preview::error("自动选择目标必须为图层或组"))};
        let auto = params["autoSelect"].as_bool().unwrap_or(false);
        if auto && !crate::layer_preview::mask_target(self.active_doc()?) {
            let doc = &self.active_doc()?.doc;
            if !doc.bounds().contains(x.floor() as i32, y.floor() as i32) { return Ok(false); }
            let Some(id) = photocraft_engine::pick_cmds::auto_select_target(doc, x.floor() as i32, y.floor() as i32, group) else { return Ok(false); };
            if !self.active_doc()?.is_layer_selected(id) {
                self.execute("layer.select", json!({"layer":id.0,"mode":if params["add"].as_bool()==Some(true) {"add"} else {"replace"}}))?;
            }
        }
        if params["wholeLayer"].as_bool()==Some(true) && params["selectedPixels"].as_bool()==Some(true) {return Err(crate::transform_preview::error("移动范围冲突"));}
        let state = self.active_doc()?;
        let Some(id) = state.active_layer else { return Ok(false); };
        let visible_targets=if params["selectedPixels"].as_bool()==Some(true) {vec![id]} else {crate::layer_preview::transform_targets(state)};
        crate::layer_preview::require_visible(state,&visible_targets,"edit.move")?;
        if params["selectedPixels"].as_bool()==Some(true) {
            let layer=state.doc.layer(id).ok_or(EditorError::NoDocument)?;
            let locks=state.doc.effective_locks(id);
            if photocraft_engine::float_cmds::locked_for_float(&state.doc,layer) || locks.pixels {
                return Err(crate::transform_preview::error("当前图层已锁定，无法移动所选像素"));
            }
            if state.doc.selection.as_ref().is_none_or(|s|s.content_bounds().is_empty()) {return Err(crate::transform_preview::error("没有可移动的选区"));}
            let parts=photocraft_engine::float_cmds::CutParts::new(&state.doc,id,params["duplicate"].as_bool()==Some(true),self.session.tools.background,crate::layer_preview::mask_target(state)).map_err(crate::transform_preview::error)?;
            let mut draft=crate::transform_preview::TransformPreview::new(state);
            draft.selected_pixels=Some(parts);
            draft.duplicate=params["duplicate"].as_bool().unwrap_or(false);
            self.transform_preview=Some(draft);
            return Ok(true);
        }
        if crate::layer_preview::transform_targets(state).iter().any(|id|photocraft_engine::transform_cmds::locked_for_transform(&state.doc,*id)) {
            return Err(crate::transform_preview::error("当前图层已锁定位置，无法移动"));
        }
        if state.doc.layer(id).is_none() { return Ok(false); }
        let mut frame_state=state.clone();
        if params["wholeLayer"].as_bool()==Some(true) {std::sync::Arc::make_mut(&mut frame_state.doc).selection=None;}
        if crate::layer_preview::transform_frame(&frame_state).is_empty() { return Ok(false); }
        let duplicate = params["duplicate"].as_bool().unwrap_or(false);
        if duplicate { self.check_layer_capacity_for(crate::layer_preview::target_layer_count(&state.doc, &crate::layer_preview::transform_targets(state)))?; }
        self.begin_transform()?;
        self.transform_preview.as_mut().unwrap().duplicate = duplicate;
        self.transform_preview.as_mut().unwrap().whole_layer = params["wholeLayer"].as_bool().unwrap_or(false);
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

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->Editor {
        use photocraft_doc::*;
        let mut doc=Document::new("移动",Size::new(12,12),ColorMode::Rgb,SampleType::U8);
        let mut l=Layer::raster("像素",doc.pixel_format());l.surface_mut().unwrap().write_pixel(2,2,&[1.,0.,0.,1.]);
        let mut sel=LayerMask::hide_all().surface;sel.write_pixel(2,2,&[1.]);doc.selection=Some(sel);doc.layers=vec![l];
        let mut editor=Editor::new();let bytes=photocraft_format::save_to_bytes(&doc,&Default::default()).unwrap();editor.open_project(&bytes,None).unwrap();editor
    }
    #[test]
    fn selected_move_checks_locks_visibility_and_flags_before_draft_without_rendering() {
        for props in [json!({"visible":false}),json!({"locks":{"pixels":true}}),json!({"locks":{"position":true}})] {
            let mut e=fixture();e.execute("layer.setProps",props).unwrap();let hash=e.content_hash().unwrap();
            assert!(e.begin_move(json!({"x":0,"y":0,"selectedPixels":true})).is_err());assert!(e.transform_preview.is_none());assert_eq!(e.content_hash().unwrap(),hash);
        }
        let mut e=fixture();
        for p in [json!({"x":0,"y":0,"wholeLayer":true,"selectedPixels":true}),json!({"x":0,"y":0,"selectedPixels":"yes"})] {assert!(e.begin_move(p).is_err());assert!(e.transform_preview.is_none());}
        let before=e.active_doc().unwrap().clone();
        assert!(e.begin_move(json!({"x":0,"y":0,"selectedPixels":true,"duplicate":true})).unwrap());
        e.preview_transform(json!([1,0,0,1,3,0])).unwrap();assert_eq!(e.content_hash().unwrap(),crate::document_content::document_content_hash(&before.doc,&e.registry).unwrap());
        e.cancel_transform();assert_eq!(e.active_doc().unwrap().doc,before.doc);
        assert!(e.begin_move(json!({"x":0,"y":0,"selectedPixels":true,"duplicate":true})).unwrap());e.preview_transform(json!([1,0,0,1,3,0])).unwrap();e.commit_transform().unwrap();
        assert_eq!(e.active_doc().unwrap().doc.layers.len(),1);assert_eq!(e.active_doc().unwrap().history.past_len(),before.history.past_len()+1);
        e.undo().unwrap();assert_eq!(e.active_doc().unwrap().doc,before.doc);
    }
}
