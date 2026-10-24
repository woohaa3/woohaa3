use super::*;

impl Editor {
    /// Bounded read-only Info data from the same candidate document as the canvas preview.
    pub fn info_readout(&self,params:Value)->Result<Value> {
        let fail=||EditorError::CommandFailed{id:"document.infoReadout".into(),message:"信息取样参数无效".into()};
        let fields=params.as_object().filter(|fields|fields.keys().all(|key|["x","y","size"].contains(&key.as_str()))).ok_or_else(fail)?;
        let size=fields.get("size").and_then(Value::as_u64).and_then(|value|u32::try_from(value).ok()).filter(|size|photocraft_engine::sample_cmds::SAMPLE_SIZES.contains(size)).ok_or_else(fail)?;
        let point=match (fields.get("x"),fields.get("y")) {
            (Some(Value::Null),Some(Value::Null))=>None,
            (Some(x),Some(y))=>Some((x.as_f64().filter(|value|value.is_finite()).ok_or_else(fail)?,y.as_f64().filter(|value|value.is_finite()).ok_or_else(fail)?)),
            _=>return Err(fail()),
        };
        let doc=self.preview_document()?;
        let point=point.map(|(x,y)|(x.floor(),y.floor())).filter(|(x,y)|*x>=0. && *y>=0. && *x<doc.size.width as f64 && *y<doc.size.height as f64);
        let rgba=point.map(|(x,y)|photocraft_engine::sample_cmds::sample_color(doc,self.session.active().and_then(|state|state.active_layer),x+0.5,y+0.5,size,photocraft_engine::sample_cmds::SampleLayers::All));
        let rgb=rgba.map(|rgba|[rgba[0],rgba[1],rgba[2]].map(|value|(value.clamp(0.0,1.0)*255.0).round() as u32));
        let cmyk=rgba.map(|rgba|photocraft_engine::sampler_cmds::device_cmyk(rgba[0],rgba[1],rgba[2]));
        let selection=doc.selection.as_ref().map(photocraft_compose::bounds::content_bounds).filter(|rect|!rect.is_empty()).map(|rect|[rect.width(),rect.height()]);
        Ok(json!({"rgb":rgb,"cmyk":cmyk,"position":point.map(|(x,y)|[x-doc.ruler_origin[0],y-doc.ruler_origin[1]]),"selectionSize":selection,"documentSize":[doc.size.width,doc.size.height]}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn info_uses_candidate_pixels_native_cmyk_and_origin_without_writes() {
        let mut editor=Editor::new();editor.execute("file.new",json!({"width":16,"height":12})).unwrap();
        editor.execute("layer.new.layer",json!({})).unwrap();
        editor.execute("select.rect",json!({"x":2,"y":3,"width":4,"height":5})).unwrap();
        std::sync::Arc::make_mut(&mut editor.session.active_mut().unwrap().doc).ruler_origin=[1.,2.];
        let before=editor.state();let hash=editor.content_hash().unwrap();
        let read=editor.info_readout(json!({"x":4.8,"y":5.2,"size":1})).unwrap();
        assert_eq!(read["position"],json!([3.,3.]));assert_eq!(read["selectionSize"],json!([4,5]));assert_eq!(read["documentSize"],json!([16,12]));
        assert_eq!(editor.info_readout(json!({"x":null,"y":null,"size":1})).unwrap()["rgb"],Value::Null);
        assert_eq!(editor.info_readout(json!({"x":-1,"y":0,"size":1})).unwrap()["position"],Value::Null);
        for params in [json!({}),json!({"x":1,"y":null,"size":1}),json!({"x":1,"y":1,"size":2}),json!({"x":1,"y":1,"size":1,"extra":true})] {assert!(editor.info_readout(params).is_err());}
        assert_eq!(editor.state(),before);assert_eq!(editor.content_hash().unwrap(),hash);
        editor.execute("select.deselect",json!({})).unwrap();
        editor.begin_stroke(json!({"strokeCommand":"paint.pencil","points":[[4,5]],"size":1,"color":"#ff0000","smoothing":0})).unwrap();
        let draft_state=editor.state();let draft_hash=editor.content_hash().unwrap();
        let read=editor.info_readout(json!({"x":4,"y":5,"size":1})).unwrap();
        assert_eq!(read["rgb"],json!([255,0,0]));assert_eq!(read["cmyk"],json!([0,100,100,0]));
        assert_eq!(editor.state(),draft_state);assert_eq!(editor.content_hash().unwrap(),draft_hash);editor.cancel_stroke();
    }
}
