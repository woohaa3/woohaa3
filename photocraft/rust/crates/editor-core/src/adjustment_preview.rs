//! 调整层参数草稿：复用上游参数解析，不把连续预览写入正式历史。
use std::sync::Arc;
use photocraft_doc::{Document, LayerContent, LayerId};
use photocraft_engine::{DocState, Session};
use serde_json::{Value, json};
use crate::error::{EditorError, Result};

pub(crate) fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "layer.setAdjustment".into(), message: message.to_string() }
}

pub(crate) struct AdjustmentPreview {
    base: DocState,
    layer: LayerId,
    kind: &'static str,
    params: Value,
    valid: bool,
    pub doc: Arc<Document>,
}

impl AdjustmentPreview {
    pub fn new(base: &DocState, layer: u64) -> Result<Self> {
        let layer=LayerId(layer);
        let target=base.doc.layer(layer).ok_or_else(||error("调整层不存在"))?;
        let locks=base.doc.effective_locks(layer);
        if locks.all || locks.pixels {return Err(error("调整层已锁定，无法编辑"));}
        let LayerContent::Adjustment(adjustment)=&target.content else {return Err(error("目标不是调整层"))};
        let kind=photocraft_engine::commands::adjustment_kind(adjustment);
        if !matches!(kind,"brightnessContrast"|"hueSaturation"|"curves") {
            return Err(error("此调整类型尚未开放"));
        }
        Ok(Self {base:base.clone(),layer,kind,params:json!({}),valid:true,doc:base.doc.clone()})
    }

    pub fn info(&self) -> Value {
        let LayerContent::Adjustment(adjustment)=&self.doc.layer(self.layer).unwrap().content else {unreachable!()};
        json!({"layer":self.layer.0,"kind":self.kind,"params":photocraft_engine::adjust_params::to_params(adjustment)})
    }

    pub fn update(&mut self, params: Value) -> Result<()> {
        // 失败后不可确认上一版成功草稿，必须修正参数或取消。
        self.valid=false;
        self.validate(&params)?;
        let mut merged=self.params.clone();
        for (key,value) in params.as_object().unwrap() {merged[key]=value.clone();}
        let mut scratch=Session::new();
        scratch.add_document((*self.base.doc).clone(),None);
        *scratch.active_mut().unwrap()=self.base.clone();
        let mut command=merged.clone();command["layer"]=json!(self.layer.0);
        scratch.execute("layer.setAdjustment",command).map_err(error)?;
        self.doc=scratch.active().unwrap().doc.clone();
        self.params=merged;self.valid=true;
        Ok(())
    }

    fn validate(&self, params: &Value) -> Result<()> {
        let fields=params.as_object().filter(|p|!p.is_empty()).ok_or_else(||error("调整参数必须是非空对象"))?;
        for (key,value) in fields {
            let range=match (self.kind,key.as_str()) {
                ("brightnessContrast","brightness")=>(-150.0,150.0),
                ("brightnessContrast","contrast")=>(-50.0,100.0),
                ("hueSaturation","hue")=>(-180.0,180.0),
                ("hueSaturation","saturation"|"lightness")=>(-100.0,100.0),
                ("curves","points")=>{validate_points(value)?;continue;},
                _=>return Err(error("调整草稿包含未开放的参数")),
            };
            if !value.as_f64().is_some_and(|v|v.is_finite() && (range.0..=range.1).contains(&v)) {
                return Err(error(format!("{key} 超出范围或不是有限数值")));
            }
        }
        Ok(())
    }

    pub fn commit(&self, session: &mut Session) -> Result<()> {
        if !self.valid {return Err(error("请修正调整参数或取消编辑"));}
        crate::preview_history::commit(session,self.doc.clone(),None,"修改调整层").map_err(error)
    }

    pub fn require_valid(&self) -> Result<()> {
        if self.valid {Ok(())} else {Err(error("请修正调整参数或取消编辑"))}
    }
}

fn validate_points(value: &Value) -> Result<()> {
    let points=value.as_array().filter(|p|(2..=16).contains(&p.len())).ok_or_else(||error("曲线需要 2–16 个控制点"))?;
    let mut previous=-1.0;
    for point in points {
        let pair=point.as_array().filter(|p|p.len()==2).ok_or_else(||error("曲线控制点需要输入和输出值"))?;
        let coordinate=|v:&Value|v.as_f64().filter(|v|v.is_finite() && (0.0..=255.0).contains(v)).ok_or_else(||error("曲线坐标必须在 0–255 之间"));
        let x=coordinate(&pair[0])?;coordinate(&pair[1])?;
        if x<=previous {return Err(error("曲线输入值必须严格递增"));}
        previous=x;
    }
    let parsed=photocraft_engine::adjust_params::parse_curve("layer.setAdjustment","points",value).map_err(error)?;
    if parsed.len()!=points.len() {return Err(error("曲线输入值间距过小，请分开控制点"));}
    Ok(())
}

/// 只取总曲线的数值几何，不采样或合成图片；图形与调色复用同一 LUT。
pub(crate) fn curve_geometry(points: &Value) -> Result<Value> {
    validate_points(points)?;
    let points=photocraft_engine::adjust_params::parse_curve("layer.setAdjustment","points",points).map_err(error)?;
    let lut=photocraft_compose::adjust::curve_lut(&points);
    Ok(json!((0..256).map(|i|{
        let position=i as f32*(lut.len()-1) as f32/255.0;
        let left=position.floor() as usize;let right=(left+1).min(lut.len()-1);
        (lut[left]+(lut[right]-lut[left])*(position-left as f32))*255.0
    }).collect::<Vec<_>>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_geometry_reuses_the_native_spline_without_image_rendering() {
        let identity=curve_geometry(&json!([[0,0],[255,255]])).unwrap();
        assert_eq!(identity.as_array().unwrap().len(),256);
        for (i,value) in identity.as_array().unwrap().iter().enumerate() {assert!((value.as_f64().unwrap()-i as f64).abs()<0.0001);}
        let curved=curve_geometry(&json!([[0,0],[128,200],[255,255]])).unwrap();
        assert!(curved[64].as_f64().unwrap()>110.0); // 自然样条不同于控制点间直线的 100。
        assert!(curve_geometry(&json!([[0,0],[0,255]])).is_err());
        assert!(curve_geometry(&json!([[0,0],[0.1,100],[255,255]])).is_err());
    }

    #[test]
    fn adjustment_history_and_project_roundtrip_do_not_require_compositing() {
        for (kind,params) in [
            ("brightnessContrast",json!({"brightness":37,"contrast":22})),
            ("hueSaturation",json!({"hue":-45,"saturation":35,"lightness":10})),
            ("curves",json!({"points":[[0,0],[100,180],[255,255]]})),
        ] {
            let mut session=Session::new();session.execute("file.new",json!({"width":16,"height":16})).unwrap();
            session.execute(&format!("layer.newAdjustmentLayer.{kind}"),json!({})).unwrap();
            let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
            let mut draft=AdjustmentPreview::new(&base,id.0).unwrap();
            draft.update(params.clone()).unwrap();let expected=draft.info();
            draft.commit(&mut session).unwrap();
            assert_eq!(session.active().unwrap().history.past_len(),base.history.past_len()+1);
            let bytes=photocraft_format::save_to_bytes(&session.active().unwrap().doc,&Default::default()).unwrap();
            let restored=photocraft_format::load_from_bytes(&bytes).unwrap();
            let LayerContent::Adjustment(adjustment)=&restored.layer(id).unwrap().content else {panic!()};
            assert_eq!(photocraft_engine::adjust_params::to_params(adjustment),expected["params"]);
            session.execute("edit.undo",Value::Null).unwrap();
            let LayerContent::Adjustment(adjustment)=&session.active().unwrap().doc.layer(id).unwrap().content else {panic!()};
            let LayerContent::Adjustment(original)=&base.doc.layer(id).unwrap().content else {panic!()};
            assert_eq!(adjustment,original);
            session.execute("edit.redo",Value::Null).unwrap();
            let next=AdjustmentPreview::new(session.active().unwrap(),id.0).unwrap();
            assert_eq!(next.info(),expected);
        }
    }

    #[test]
    fn locks_types_and_parameter_ranges_are_checked_before_editing() {
        let mut session=Session::new();session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        session.execute("layer.new.layer",json!({})).unwrap();
        let id=session.active().unwrap().active_layer.unwrap();
        assert!(AdjustmentPreview::new(session.active().unwrap(),id.0).is_err());
        assert!(AdjustmentPreview::new(session.active().unwrap(),u64::MAX).is_err());
        for (kind,bad) in [
            ("brightnessContrast",vec![json!({"brightness":151}),json!({"contrast":-51}),json!({"brightness":null}),json!({"legacy":true})]),
            ("hueSaturation",vec![json!({"hue":181}),json!({"saturation":-101}),json!({"lightness":"10"}),json!({"colorize":true})]),
        ] {
            session.execute(&format!("layer.newAdjustmentLayer.{kind}"),json!({})).unwrap();
            let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
            let mut draft=AdjustmentPreview::new(&base,id.0).unwrap();let original=draft.info();
            for params in bad {assert!(draft.update(params).is_err());assert_eq!(draft.info(),original);assert!(draft.commit(&mut session).is_err());}
            Arc::make_mut(&mut session.active_mut().unwrap().doc).layer_mut(id).unwrap().locks.all=true;
            assert!(AdjustmentPreview::new(session.active().unwrap(),id.0).is_err());
        }
    }
}
