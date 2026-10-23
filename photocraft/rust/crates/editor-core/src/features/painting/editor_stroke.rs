use super::*;

impl Editor {
    /// 临时笔迹只影响预览；提交前不改变文档、修订、指纹或历史。
    pub fn begin_stroke(&mut self, params: Value) -> Result<()> {
        self.require_no_stroke()?;
        // 与 `execute` 同一道模式门禁，但更早：`commit_stroke` 也会拒绝，那时用户已经看到预览、
        // 画完一笔才发现不能提交。这里在落笔前就拒绝，预览与结果保持一致。
        // （change: 2026-10-22-add-photocraft-image-mode-workflows）
        if let Some(state) = self.session.active() {
            crate::features::modes::gate::check(&state.doc, "paint.stroke", &params)?;
        }
        let original = self.active_doc()?.doc.clone();
        // 临时限制笔刷到文档范围；原有选区（包括羽化）仍参与相交。
        // 不修改正式文档、修订与历史，抬笔复用 LiveStroke 的同一表面。
        let clipped = Self::stroke_selection(&original);
        std::sync::Arc::make_mut(&mut self.session.active_mut().unwrap().doc).selection = Some(clipped);
        let result = photocraft_engine::brush_cmds::LiveStroke::begin(&self.session, &params);
        self.session.active_mut().unwrap().doc = original.clone();
        let mut live = result.map_err(Self::stroke_error)?;
        std::sync::Arc::make_mut(&mut live.doc).selection = original.selection.clone();
        self.stroke_damage=live.bounds().intersect(&live.doc.bounds());
        self.live_stroke = Some((live, params));
        Ok(())
    }

    pub(super) fn stroke_selection(doc: &photocraft_doc::Document) -> photocraft_raster::Surface {
        let mut bounds = photocraft_doc::LayerMask::hide_all().surface;
        bounds.fill_rect(doc.bounds(), &[1.0]);
        match &doc.selection {
            Some(selection) => photocraft_algo::selection::combine_surfaces(selection, &bounds, doc.bounds(), f32::min),
            None => bounds,
        }
    }

    /// 追加本帧的新采样；不重画已处理的点。
    pub fn append_stroke(&mut self, params: Value) -> Result<()> {
        let points = photocraft_engine::brush_cmds::parse_points(&params, "paint.stroke")
            .map_err(Self::stroke_error)?;
        let (live, all) = self.live_stroke.as_mut().ok_or_else(|| Self::stroke_error("没有正在绘制的笔迹"))?;
        let damage=live.push(&points).map_err(Self::stroke_error)?.intersect(&live.doc.bounds());
        self.stroke_damage=self.stroke_damage.union(&damage);
        all["points"].as_array_mut().unwrap().extend(params["points"].as_array().unwrap().iter().cloned());
        Ok(())
    }

    /// 复用预览已经绘制的表面，整笔只经过一次正式命令提交。
    pub fn commit_stroke(&mut self) -> Result<Value> {
        self.stroke_damage=photocraft_geom::Rect::EMPTY;
        let (live, mut params) = self.live_stroke.take().ok_or_else(|| Self::stroke_error("没有正在绘制的笔迹"))?;
        params["seed"] = json!(live.seed);
        self.session.offer_live_stroke(live).map_err(Self::stroke_error)?;
        let result = self.execute("paint.stroke", params);
        self.session.clear_live_stroke();
        result
    }

    pub fn cancel_stroke(&mut self) {
        self.stroke_damage=photocraft_geom::Rect::EMPTY;
        self.live_stroke = None;
        self.session.clear_live_stroke();
    }

    /// 消费自上次读取以来的实际改动范围，不合成图像或修改文档修订。
    pub fn take_stroke_damage(&mut self) -> Value {
        let rect=std::mem::replace(&mut self.stroke_damage,photocraft_geom::Rect::EMPTY);
        if rect.is_empty() {json!([])} else {json!([{"x":rect.x0,"y":rect.y0,"width":rect.width(),"height":rect.height()}])}
    }

    pub(super) fn stroke_error(error: impl std::fmt::Display) -> EditorError {
        EditorError::CommandFailed { id: "paint.stroke".into(), message: error.to_string() }
    }
}
