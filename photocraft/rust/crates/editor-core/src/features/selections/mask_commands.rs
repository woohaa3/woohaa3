//! 宿主不允许“添加蒙版”静默替换已有蒙版；像素操作仍交给上游命令。
use photocraft_engine::Session;
use serde_json::Value;

pub(crate) fn creates_mask(id: &str) -> bool {
    matches!(id, "layer.layerMask.revealAll" | "layer.layerMask.hideAll"
        | "layer.layerMask.revealSelection" | "layer.layerMask.hideSelection"
        | "layer.layerMask.fromTransparency")
}

fn targets(session: &Session, id: &str, params: &Value) -> Option<Vec<photocraft_doc::LayerId>> {
    let state = session.active()?;
    Some(if let Some(layer) = params.get("layer") {
        // 与上游 layer_param 一致：null 为活动层，名称取最上层同名匹配。
        // 其他非法显式目标由上游拒绝，不能回退到活动层。
        match layer {
            Value::Null => state.active_layer.into_iter().collect(),
            Value::String(name) => vec![state.doc.walk().into_iter().rev().find(|(_,_,layer)|layer.name==*name)?.2.id],
            value => vec![photocraft_doc::LayerId(value.as_u64()?)],
        }
    } else if id == "layer.layerMask.fromTransparency" {
        state.active_layer.into_iter().collect()
    } else {
        state.selected_layers()
    })
}

pub(crate) fn creation_reason(session: &Session, id: &str, params: &Value) -> Option<String> {
    if !creates_mask(id) { return None; }
    let state = session.active()?;
    let targets = targets(session,id,params)?;
    targets.iter().any(|id| state.doc.layer(*id).is_some_and(|layer| layer.mask.is_some()))
        .then(|| "图层已有蒙版；请先删除或应用现有蒙版".into())
}
