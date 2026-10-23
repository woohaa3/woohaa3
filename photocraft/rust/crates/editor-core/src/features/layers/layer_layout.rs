//! 对齐与分布复用上游计算，只在入口检查目标、参数和锁定。
use photocraft_engine::{Session, layer_multi_cmds};
use serde_json::Value;
use crate::error::{EditorError, Result};

pub(crate) fn applies(id: &str) -> bool {
    id.starts_with("layer.align.") || id.starts_with("layer.distribute.")
}

pub(crate) fn check(session: &Session, id: &str, params: &Value) -> Result<()> {
    if !applies(id) { return Ok(()); }
    let fail = |message: &str| EditorError::CommandFailed { id: id.into(), message: message.into() };
    let align = id.starts_with("layer.align.");
    if !params.is_null() {
        let fields = params.as_object().ok_or_else(|| fail("对齐与分布参数必须为对象"))?;
        if fields.keys().any(|key| !align || key != "to") {
            return Err(fail("对齐只接受 to 参数，分布不接受额外参数；目标使用当前所选图层"));
        }
    }
    let to = match params.get("to") {
        None => "auto",
        Some(value) => value.as_str().filter(|to| matches!(*to,"auto"|"layers"|"canvas"|"selection"))
            .ok_or_else(|| fail("对齐目标必须为自动、所选图层、画布或选区"))?,
    };
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let roots = crate::layer_preview::selected_roots(state);
    let targets = layer_multi_cmds::move_targets(&state.doc, &roots);
    if targets.iter().any(|id| {
        let locks = state.doc.effective_locks(*id);
        locks.position || locks.all
    }) {
        return Err(fail("所选或联动图层已锁定位置，请先解锁再对齐或分布"));
    }
    let bounded = roots.iter().filter(|id| state.doc.layer(**id).and_then(layer_multi_cmds::layer_bounds).is_some()).count();
    if align && bounded == 0 { return Err(fail("所选图层没有可对齐的内容")); }
    if !align && bounded < 3 { return Err(fail("请选择至少三个有内容的图层进行分布")); }
    if align && to == "selection" && state.doc.selection.as_ref().is_none_or(|selection| selection.content_bounds().is_empty()) {
        return Err(fail("请先创建选区，或改为对齐画布或所选图层"));
    }
    Ok(())
}

pub(crate) fn disabled_reason(session: &Session, id: &str) -> Option<String> {
    if !applies(id) { return None; }
    check(session,id,&Value::Null).err().map(|error| match error {
        EditorError::CommandFailed { message, .. } => message,
        _ => error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn layout_gate_reads_native_bounds_and_locks_without_moving_pixels() {
        let mut session=Session::new();
        session.execute("file.new",json!({"width":20,"height":20})).unwrap();
        let mut ids=Vec::new();
        for _ in 0..3 {
            session.execute("layer.new.layer",json!({})).unwrap();
            ids.push(session.active().unwrap().active_layer.unwrap());
        }
        let state=session.active_mut().unwrap();
        state.selected_layers=ids.clone();
        assert!(check(&session,"layer.align.leftEdges",&Value::Null).is_err());
        assert!(check(&session,"layer.distribute.horizontally",&Value::Null).is_err());
        for id in &ids {
            Arc::make_mut(&mut session.active_mut().unwrap().doc).layer_mut(*id).unwrap().surface_mut().unwrap().write_pixel(2,3,&[1.,0.,0.,1.]);
        }
        for target in ["auto","layers","canvas"] {
            check(&session,"layer.align.leftEdges",&json!({"to":target})).unwrap();
        }
        check(&session,"layer.distribute.horizontally",&Value::Null).unwrap();
        assert!(check(&session,"layer.align.leftEdges",&json!({"to":"selection"})).is_err());
        let mut selection=photocraft_doc::LayerMask::hide_all().surface;
        selection.write_pixel(1,1,&[1.]);
        Arc::make_mut(&mut session.active_mut().unwrap().doc).selection=Some(selection);
        check(&session,"layer.align.leftEdges",&json!({"to":"selection"})).unwrap();
        for params in [json!({"to":false}),json!({"to":"other"}),json!({"layer":ids[0].0}),json!([])] {
            assert!(check(&session,"layer.align.leftEdges",&params).is_err());
        }
        assert!(check(&session,"layer.distribute.horizontally",&json!({"to":"canvas"})).is_err());
        session.active_mut().unwrap().selected_layers=vec![ids[0],ids[1]];
        session.active_mut().unwrap().active_layer=Some(ids[0]);
        assert!(check(&session,"layer.distribute.horizontally",&Value::Null).is_err());
        session.active_mut().unwrap().selected_layers=ids.clone();
        Arc::make_mut(&mut session.active_mut().unwrap().doc).layer_mut(ids[1]).unwrap().locks.position=true;
        for id in ["layer.align.leftEdges","layer.distribute.horizontally"] {
            assert!(check(&session,id,&Value::Null).unwrap_err().to_string().contains("锁定位置"));
            assert!(disabled_reason(&session,id).unwrap().contains("锁定位置"));
        }
        // 未选中的链接图层仍会随动，必须同样受锁定门禁约束。
        let state=session.active_mut().unwrap();state.selected_layers=vec![ids[0]];state.active_layer=Some(ids[0]);
        for id in &ids[..2] {Arc::make_mut(&mut state.doc).layer_mut(*id).unwrap().link_group=Some(7);}
        assert!(check(&session,"layer.align.leftEdges",&Value::Null).is_err());
    }
}
