//! 图层样式的有界子集；图案引用必须由工程内资源满足，PSD 原始块关闭。
use photocraft_doc::{Effects, GlobalLight};
use serde_json::Value;

pub const MAX_LAYER_EFFECTS: usize = 64;
pub const SUPPORTED_EFFECTS: &[&str] = &[
    "DropShadow", "InnerShadow", "OuterGlow", "InnerGlow", "Stroke",
    "ColorOverlay", "GradientOverlay", "PatternOverlay", "Satin", "BevelEmboss",
];

/// 只检查结构和参数范围；不执行合成或加载图案。
pub fn supported(effects: &Effects, light: &GlobalLight) -> bool {
    if effects.items.len() > MAX_LAYER_EFFECTS || effects.psd_raw.is_some()
        || !light.angle.is_finite() || !light.altitude.is_finite()
        || effects.reference.is_some_and(|(x,y)| !x.is_finite() || !y.is_finite()) { return false; }
    let Ok(items) = serde_json::to_value(&effects.items) else { return false; };
    supported_items(&items)
}

/// 草稿先检查原始载荷上限，再交给上游类型解析，避免先分配无界列表。
pub fn supported_items(items: &Value) -> bool {
    let Some(items) = items.as_array() else { return false; };
    if items.len() > MAX_LAYER_EFFECTS { return false; }
    let mut budget = 8192;
    items.iter().all(|item| {
        item.as_object().is_some_and(|object| object.len()==1 && object.keys().all(|key| SUPPORTED_EFFECTS.contains(&key.as_str())))
            && bounded(item, 0, &mut budget, "")
    })
}

fn bounded(value: &Value, depth: usize, budget: &mut usize, key: &str) -> bool {
    if depth > 16 || *budget == 0 { return false; }
    *budget -= 1;
    match value {
        Value::Null => matches!(key, "texture" | "contour"),
        Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(|n| n.is_finite() && match key {
            "opacity" | "spread" | "range" | "jitter" | "noise" => (0.0..=1.0).contains(&n),
            "size" | "soften" | "distance" => (0.0..=2048.0).contains(&n),
            "depth" => (0.0..=10.0).contains(&n),
            "texture-depth" => (-10.0..=10.0).contains(&n),
            "scale" => (0.01..=10.0).contains(&n),
            "angle" => (-360.0..=360.0).contains(&n),
            "altitude" => (0.0..=90.0).contains(&n),
            _ => n.abs() <= 1_000_000.0,
        }),
        Value::String(text) => text.encode_utf16().count() <= 200,
        Value::Array(values) => values.len() <= 256
            && (!matches!(key,"stops"|"opacity_stops") || values.iter().all(|value| {
                value.as_array().is_some_and(|stop|stop.len()==2
                    && stop[0].as_f64().is_some_and(|n|n.is_finite() && (0.0..=1.0).contains(&n))
                    && (key!="opacity_stops" || stop[1].as_f64().is_some_and(|n|n.is_finite() && (0.0..=1.0).contains(&n))))
            }))
            && values.iter().all(|v| bounded(v, depth+1, budget, "")),
        Value::Object(object) => object.len() <= 64
            && (!matches!(key,"Pattern"|"PatternOverlay"|"texture") || valid_pattern_reference(value))
            && (!object.contains_key("Custom") || object.get("Custom").is_some_and(valid_custom_contour))
            && object.iter().all(|(field,v)| {
            let context=key;let key=field.as_str();
            (key != "blend" || serde_json::from_value::<photocraft_doc::BlendMode>(v.clone()).is_ok_and(|mode|photocraft_doc::BlendMode::LAYER_MODES.contains(&mode)))
                && bounded(v, depth+1, budget, if key=="depth" && context=="texture" {"texture-depth"} else {key})
        }),
    }
}

fn valid_pattern_reference(value:&Value)->bool {
    value.get("id").and_then(Value::as_str).is_some_and(|s|!s.trim().is_empty())
        && value.get("name").and_then(Value::as_str).is_some_and(|s|!s.trim().is_empty())
        && value.get("scale").and_then(Value::as_f64).is_some_and(|n|(0.01..=10.0).contains(&n))
        && value.get("phase").is_none_or(|v|v.as_array().is_some_and(|v|v.len()==2))
}

/// 严格按 id/name 关联，禁止渲染器静默按名字回退到另一资源。
pub fn pattern_references(effects:&Effects)->Vec<(&str,&str)> {
    use photocraft_doc::{Effect,FxPaint};
    let mut out=Vec::new();
    for effect in &effects.items {
        match effect {
            Effect::PatternOverlay{id,name,..}=>out.push((id.as_str(),name.as_str())),
            Effect::Stroke(s)=>if let FxPaint::Pattern{id,name,..}=&s.paint {out.push((id.as_str(),name.as_str()));},
            Effect::OuterGlow(g)|Effect::InnerGlow(g)=>if let FxPaint::Pattern{id,name,..}=&g.paint {out.push((id.as_str(),name.as_str()));},
            Effect::BevelEmboss(b)=>if let Some(t)=&b.texture {out.push((t.id.as_str(),t.name.as_str()));},
            _=>{}
        }
    }
    out
}
pub fn supported_document(doc:&photocraft_doc::Document)->bool {
    crate::pattern_support::supported(&doc.patterns) && doc.walk().iter().all(|(_,_,layer)|
        supported(&layer.effects,&doc.global_light) && pattern_references(&layer.effects).iter().all(|(id,name)|
            doc.patterns.iter().any(|p|p.id==*id && p.name==*name)))
}

fn valid_custom_contour(value:&Value)->bool {
    let Some(object)=value.as_object() else{return false;};
    let Some(points)=object.get("points").and_then(Value::as_array) else{return false;};
    if !(2..=256).contains(&points.len()) {return false;}
    let mut previous=-1.0;
    if !points.iter().all(|point| {
        let Some(input)=point.get("input").and_then(Value::as_f64) else{return false;};
        let Some(output)=point.get("output").and_then(Value::as_f64) else{return false;};
        let valid=input.is_finite() && output.is_finite() && (0.0..=1.0).contains(&input)
            && (0.0..=1.0).contains(&output) && input>previous;
        previous=input;valid
    }) {return false;}
    object.get("corners").is_none_or(|corners|corners.as_array().is_some_and(|corners|corners.len()<=points.len() && corners.iter().all(Value::is_boolean)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{BlendMode, Color, Effect, FxCommon};
    #[test]
    fn contour_points_are_bounded_ordered_and_have_parallel_corner_flags() {
        use serde_json::json;
        let contour=|points:Value,corners:Value|json!([{"DropShadow":{"contour":{"Custom":{"name":"自定","points":points,"corners":corners}}}}]);
        let points=json!([{"input":0,"output":0},{"input":0.5,"output":1},{"input":1,"output":0}]);
        assert!(supported_items(&contour(points.clone(),json!([false,true,false]))));
        assert!(supported_items(&contour(points.clone(),json!([]))));
        for invalid in [json!([]),json!([{"input":0,"output":0}]),json!([{"input":0,"output":0},{"input":0,"output":1}]),json!([{"input":0.8,"output":0},{"input":0.2,"output":1}]),json!([{"input":0,"output":0},{"input":1,"output":1.1}]),json!([{"input":-0.1,"output":0},{"input":1,"output":1}])] {
            assert!(!supported_items(&contour(invalid,json!([]))));
        }
        assert!(!supported_items(&contour(points.clone(),json!([false,true,false,true]))));
        assert!(!supported_items(&contour(points,json!([1]))));
    }

    #[test]
    fn gradient_stop_positions_and_opacity_are_bounded_without_rendering() {
        use photocraft_doc::Gradient;
        let light=GlobalLight::default();
        let mut gradient=Gradient::default();
        gradient.opacity_stops=vec![(0.0,1.0),(0.5,0.25),(1.0,0.0)];
        let effects=|gradient|Effects{enabled:true,items:vec![Effect::GradientOverlay{common:FxCommon::new(BlendMode::Normal,1.0),gradient,dither:false}],..Default::default()};
        assert!(supported(&effects(gradient.clone()),&light));
        for (position,opacity) in [(-0.1,0.5),(1.1,0.5),(0.5,-0.1),(0.5,1.1)] {
            let mut invalid=gradient.clone();invalid.opacity_stops=vec![(position,opacity)];assert!(!supported(&effects(invalid),&light));
        }
        for position in [-0.1,1.1] {
            let mut invalid=gradient.clone();invalid.stops[0].0=position;assert!(!supported(&effects(invalid),&light));
        }
    }

    #[test]
    fn resource_boundary_checks_references_and_rejects_raw_data_and_unbounded_effects() {
        let light=GlobalLight::default();
        let effect=Effect::ColorOverlay{common:FxCommon::new(BlendMode::Normal,1.0),color:Color::BLACK};
        let mut effects=Effects{enabled:true,items:vec![effect.clone()],..Default::default()};
        assert!(supported(&effects,&light));
        effects.items=vec![effect;65];assert!(!supported(&effects,&light));
        effects.items.clear();effects.psd_raw=Some(std::sync::Arc::new(vec![1]));assert!(!supported(&effects,&light));
        effects.psd_raw=None;effects.reference=Some((f64::NAN,0.0));assert!(!supported(&effects,&light));
        effects.reference=None;assert!(!supported(&effects,&GlobalLight{angle:f32::INFINITY,..light}));
        effects.items.push(Effect::PatternOverlay{common:FxCommon::new(BlendMode::Normal,1.0),name:"图案".into(),id:"pattern".into(),scale:1.0,angle:0.0,link:true,phase:(0.0,0.0)});
        assert!(supported(&effects,&light));
        let mut doc=photocraft_doc::Document::new("t",photocraft_doc::Size::new(1,1),photocraft_doc::ColorMode::Rgb,photocraft_doc::SampleType::U8);
        let mut layer=photocraft_doc::Layer::raster("empty",doc.pixel_format());layer.effects=effects;doc.layers.push(layer);
        assert!(!supported_document(&doc));
    }
}
