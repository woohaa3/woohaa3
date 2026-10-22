//! 填充颜色取自宿主色盘；选区、保透明、文字着色及历史仍由上游命令持有。
use photocraft_doc::LayerContent;
use photocraft_engine::Session;
use serde_json::Value;
use crate::error::{EditorError, Result};

pub(crate) const IDS: [&str; 5] = ["edit.fillForeground", "edit.fillBackground", "edit.fillForegroundPreserve", "edit.fillBackgroundPreserve", "edit.clear"];
fn error(id: &str, message: &str) -> EditorError { EditorError::CommandFailed {id:id.into(), message:message.into()} }

pub(crate) fn color(id: &str, params: &Value) -> Result<[f32;4]> {
    let fields=params.as_object().ok_or_else(||error(id,"填充参数必须为对象"))?;
    if fields.keys().any(|key| key!="color") {
        return Err(error(id,"填充只接受 color 参数，目标使用当前活动图层或蒙版"));
    }
    let hex=params["color"].as_str().filter(|hex|hex.len()==7 && hex.starts_with('#') && hex.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit))
        .ok_or_else(||error(id,"填充颜色必须为 #rrggbb"))?;
    let mut rgba=[1.0;4];
    for (index, value) in rgba[..3].iter_mut().enumerate() {*value=u8::from_str_radix(&hex[1+index*2..3+index*2],16).unwrap() as f32/255.0;}
    Ok(rgba)
}

fn target(session: &Session, id: &str) -> Result<()> {
    let state=session.active().ok_or(EditorError::NoDocument)?;
    let layer=state.active_layer.ok_or_else(||error(id,"没有活动图层"))?;
    let mask=crate::layer_preview::mask_target(state);
    let item=state.doc.layer(layer).ok_or_else(||error(id,"填充图层不存在"))?;
    let locks=state.doc.effective_locks(layer);
    if locks.all || (!mask && locks.pixels) {return Err(error(id,"目标图层已锁定，请先解锁再填充"));}
    if mask {
        if item.mask.is_none() {return Err(error(id,"目标图层没有蒙版"));}
    } else if !matches!(item.content,LayerContent::Raster(_) | LayerContent::Text(_)) {
        return Err(error(id,"填充需要像素层、文字层或蒙版"));
    }
    Ok(())
}

pub(crate) fn disabled_reason(session: &Session, id: &str) -> Option<String> {
    if !IDS.contains(&id) {return None;}
    target(session,id).err().map(|reason|reason.to_string())
}

fn command_target<'a>(session: &Session, id: &'a str) -> &'a str {
    if id=="edit.clear" && session.active().is_some_and(crate::layer_preview::mask_target) {"edit.fillBackground"} else {id}
}

pub(crate) fn execute(session: &mut Session, id: &str, params: &Value) -> Result<Value> {
    let rgba=color(id,params)?;
    target(session,id)?;
    if id=="edit.clear" && session.active().and_then(|state|state.doc.selection.as_ref()).is_some_and(|selection|selection.content_bounds().is_empty()) {
        return Ok(Value::Null);
    }
    let mut routed=params.as_object().unwrap().clone();
    routed.remove("color");
    // 两个目标色对均临时注入相同颜色，避免内核目标同步时换回旧色对。
    // 完整恢复工具状态；失败也不遗留隐藏的内核色盘偏好。
    let tools=session.tools.clone();
    session.tools.foreground=rgba;
    session.tools.background=rgba;
    session.tools.other_colors=[rgba;2];
    // 上游 edit.clear 不处理图层蒙版；跟随桌面 Delete 语义使用当前背景色填蒙版。
    let command=command_target(session,id);
    let result=session.execute(command,Value::Object(routed));
    session.tools=tools;
    result.map_err(|reason|error(id,&reason.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn malformed_colors_and_targets_do_not_mutate_state_or_tools() {
        let mut session=Session::new();
        session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        session.execute("layer.new.layer",Value::Null).unwrap();
        let doc=session.active().unwrap().doc.clone();
        let tools=format!("{:?}",session.tools);
        for params in [Value::Null,json!({}),json!({"color":"#ffffff","layer":"1"}),json!({"color":"#ffffff","layer":999}),
            json!({"color":"#ffffff","target":"quickMask"}),json!({"color":"#ffffff","target":"mask"}),
            json!({"color":"#ffffff","opacity":20}),json!({"color":"#ffzz00"}),json!({"color":"#ff000080"}),json!({"color":[1,0,0]})] {
            for id in IDS {assert!(execute(&mut session,id,&params).is_err(),"{id}: {params}");}
        }
        assert!(std::sync::Arc::ptr_eq(&doc,&session.active().unwrap().doc));
        assert_eq!(format!("{:?}",session.tools),tools);
        assert_eq!(color(IDS[0],&json!({"color":"#FF8000"})).unwrap(),[1.0,128.0/255.0,0.0,1.0]);
    }
    #[test]
    fn locks_and_mask_target_share_snapshot_and_execution_gate() {
        let mut session=Session::new();
        session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        session.execute("layer.new.layer",Value::Null).unwrap();
        session.execute("layer.layerMask.revealAll",Value::Null).unwrap();
        session.execute("layer.lockLayers",json!({"pixels":true})).unwrap();
        for id in IDS {
            assert!(disabled_reason(&session,id).is_some());
            assert!(execute(&mut session,id,&json!({"color":"#ff0000"})).is_err());
        }
        session.execute("channel.target.layerMask",Value::Null).unwrap();
        for id in IDS {assert!(disabled_reason(&session,id).is_none());}
        session.execute("layer.lockLayers",json!({"all":true})).unwrap();
        for id in IDS {
            assert!(disabled_reason(&session,id).is_some());
            assert!(execute(&mut session,id,&json!({"color":"#ff0000"})).is_err());
        }
    }
    #[test]
    fn clear_on_a_group_mask_does_not_fall_through_to_layer_pixels() {
        let mut session=Session::new();
        session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        session.execute("layer.new.group",Value::Null).unwrap();
        session.execute("layer.layerMask.revealAll",Value::Null).unwrap();
        session.execute("channel.target.layerMask",Value::Null).unwrap();
        assert_eq!(command_target(&session,"edit.clear"),"edit.fillBackground");
        let state=session.active_mut().unwrap();
        // 空选区不执行有效像素操作，也不创建无效历史。
        std::sync::Arc::make_mut(&mut state.doc).selection=Some(photocraft_doc::LayerMask::hide_all().surface);
        let before=state.doc.clone();
        let steps=state.history.past_len();
        execute(&mut session,"edit.clear",&json!({"color":"#ffffff"})).unwrap();
        assert!(std::sync::Arc::ptr_eq(&before,&session.active().unwrap().doc));
        assert_eq!(session.active().unwrap().history.past_len(),steps);
    }
    #[test]
    fn empty_selection_keeps_history_and_tools_without_filling_any_pixels() {
        let mut session=Session::new();
        session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        session.execute("layer.new.layer",Value::Null).unwrap();
        let state=session.active_mut().unwrap();
        std::sync::Arc::make_mut(&mut state.doc).selection=Some(photocraft_doc::LayerMask::hide_all().surface);
        let before=state.doc.clone();
        let steps=state.history.past_len();
        let tools=format!("{:?}",session.tools);
        for id in IDS {
            execute(&mut session,id,&json!({"color":"#ff8020"})).unwrap();
            assert!(std::sync::Arc::ptr_eq(&before,&session.active().unwrap().doc));
            assert_eq!(session.active().unwrap().history.past_len(),steps);
            assert_eq!(format!("{:?}",session.tools),tools);
        }
    }
}
