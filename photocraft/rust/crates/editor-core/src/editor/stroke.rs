use super::*;

impl Editor {
    /// 临时笔迹只影响预览；提交前不改变文档、修订、指纹或历史。
    pub fn begin_stroke(&mut self, mut params: Value) -> Result<()> {
        self.require_no_stroke()?;
        let command=match params.get("strokeCommand"){None=>"paint.stroke",Some(Value::String(id)) if id=="paint.stroke"=>"paint.stroke",Some(Value::String(id)) if id=="paint.pencil"=>"paint.pencil",_=>return Err(Self::stroke_error("笔迹命令须为 paint.stroke 或 paint.pencil"))};
        if !crate::capability::command_allowed(command){return Err(EditorError::CapabilityDisabled(command.into()));}
        let background=match params.get("backgroundColor") {None=>None,Some(Value::String(c)) if c.len()==7 && c.starts_with('#') && c[1..].bytes().all(|b|b.is_ascii_hexdigit())=>Some([u8::from_str_radix(&c[1..3],16).unwrap() as f32/255.,u8::from_str_radix(&c[3..5],16).unwrap() as f32/255.,u8::from_str_radix(&c[5..7],16).unwrap() as f32/255.,1.]),_=>return Err(Self::stroke_error("笔迹背景色须为 #RRGGBB"))};
        for key in ["autoErase","block"] {if params.get(key).is_some_and(|v|!v.is_boolean()){return Err(Self::stroke_error("autoErase 与 block 必须为布尔值"));}}
        if let Some(fields)=params.as_object_mut(){fields.remove("strokeCommand");fields.remove("backgroundColor");}
        Self::check_paint_mode(&params)?;
        Self::snap_pencil_points(command,&mut params)?;
        let state=self.active_doc()?;
        crate::layer_preview::require_visible(state,&params["layer"].as_u64().map(photocraft_doc::LayerId).or(state.active_layer).into_iter().collect::<Vec<_>>(),"paint.stroke")?;
        let original = state.doc.clone();
        // 临时限制笔刷到文档范围；原有选区（包括羽化）仍参与相交。
        // 不修改正式文档、修订与历史，抬笔复用 LiveStroke 的同一表面。
        let clipped = Self::stroke_selection(&original);
        std::sync::Arc::make_mut(&mut self.session.active_mut().unwrap().doc).selection = Some(clipped);
        let previous_colors=self.session.tools.clone();
        if let Some(color)=background {self.session.tools.background=color;}
        let result = photocraft_engine::brush_cmds::LiveStroke::begin_with(&self.session, command,&params);
        self.session.tools=previous_colors;
        self.session.active_mut().unwrap().doc = original.clone();
        let mut live = result.map_err(Self::stroke_error)?;
        std::sync::Arc::make_mut(&mut live.doc).selection = original.selection.clone();
        self.stroke_damage=live.bounds().intersect(&live.doc.bounds());
        self.live_stroke = Some((live, params,command,background));
        Ok(())
    }

    fn snap_pencil_points(command:&str,params:&mut Value)->Result<()> {
        if command!="paint.pencil" || params["block"].as_bool()==Some(true){return Ok(());}
        let size=params["size"].as_f64().unwrap_or(1.) as f32;
        // Parse first: malformed samples cannot partially mutate the live stroke.
        let points=photocraft_engine::brush_cmds::parse_points(params,command).map_err(Self::stroke_error)?;
        for (raw,point) in params["points"].as_array_mut().unwrap().iter_mut().zip(points) {
            let (x,y)=photocraft_engine::paint::grid_center(point.x as f64,point.y as f64,size);
            if raw.is_array() {raw[0]=json!(x);raw[1]=json!(y);} else {raw["x"]=json!(x);raw["y"]=json!(y);}
        }
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
    pub fn append_stroke(&mut self, mut params: Value) -> Result<()> {
        if let Some((_,all,command,_))=&self.live_stroke {params["size"]=all["size"].clone();params["block"]=all["block"].clone();Self::snap_pencil_points(command,&mut params)?;}
        let points = photocraft_engine::brush_cmds::parse_points(&params, "paint.stroke")
            .map_err(Self::stroke_error)?;
        let (live, all,_,_) = self.live_stroke.as_mut().ok_or_else(|| Self::stroke_error("没有正在绘制的笔迹"))?;
        let damage=live.push(&points).map_err(Self::stroke_error)?.intersect(&live.doc.bounds());
        self.stroke_damage=self.stroke_damage.union(&damage);
        all["points"].as_array_mut().unwrap().extend(params["points"].as_array().unwrap().iter().cloned());
        Ok(())
    }

    /// 复用预览已经绘制的表面，整笔只经过一次正式命令提交。
    pub fn commit_stroke(&mut self) -> Result<Value> {
        self.stroke_damage=photocraft_geom::Rect::EMPTY;
        let (live, mut params,command,background) = self.live_stroke.take().ok_or_else(|| Self::stroke_error("没有正在绘制的笔迹"))?;
        params["seed"] = json!(live.seed);
        self.session.offer_live_stroke(live).map_err(Self::stroke_error)?;
        let tools=self.session.tools.clone();if let Some(color)=background{self.session.tools.background=color;}
        let result = self.execute(command, params);
        self.session.tools=tools;
        self.session.clear_live_stroke();
        result
    }

    /// Read the native dab generator; only time-dependent strokes need held-point frames.
    pub fn stroke_wants_time(&self) -> bool {
        self.live_stroke.as_ref().is_some_and(|(live,_,_,_)| live.wants_time())
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

    pub(super) fn check_paint_mode(params:&Value)->Result<()> {
        if let Some(mode)=params.get("mode") {
            if !mode.as_str().is_some_and(|mode|mode.eq_ignore_ascii_case("clear")) && !mode.as_str().and_then(photocraft_engine::commands::blend_from_str).is_some_and(|mode|photocraft_doc::BlendMode::LAYER_MODES.contains(&mode)) {return Err(Self::stroke_error("画笔混合模式无效或未开放"));}
        }
        Ok(())
    }

    pub(super) fn stroke_error(error: impl std::fmt::Display) -> EditorError {
        EditorError::CommandFailed { id: "paint.stroke".into(), message: error.to_string() }
    }
}
