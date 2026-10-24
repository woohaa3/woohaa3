//! 创建选项在进入上游原子编辑前严格预检；标签与链接关系由版本化内容身份保存。
use photocraft_engine::Session;
use serde_json::Value;
use crate::error::{EditorError,Result};
pub(crate) fn check(session:&Session,id:&str,params:&Value)->Result<()> {
    if id!="layer.new.layer" {return Ok(());}
    if params.is_null() {return Ok(());}
    let bad=|message:&str|EditorError::CommandFailed{id:id.into(),message:message.into()};
    let fields=params.as_object().ok_or_else(||bad("新建图层选项必须为对象"))?;
    if fields.keys().any(|key|!["name","mode","opacity","clipToPrevious","fillNeutral","position","color"].contains(&key.as_str())) {return Err(bad("存在尚未支持的新建图层选项"));}
    if fields.get("color").is_some_and(|value|value.as_str().and_then(photocraft_doc::LabelColor::from_id).is_none()) {return Err(bad("图层颜色标签无效"));}
    if fields.get("name").is_some_and(|name|name.as_str().is_none_or(|name|name.chars().count()>200)) {return Err(bad("名称必须为不超过 200 字符的文本"));}
    if fields.get("opacity").is_some_and(|value|value.as_f64().is_none_or(|value|!value.is_finite() || !(0.0..=1.0).contains(&value))) {return Err(bad("不透明度须为 0–1"));}
    for key in ["clipToPrevious","fillNeutral"] {if fields.get(key).is_some_and(|value|!value.is_boolean()) {return Err(bad("剪贴与中性色选项必须为布尔值"));}}
    if params["clipToPrevious"].as_bool()==Some(true) && session.active().and_then(|state|state.active_layer).is_none() {return Err(bad("请先选择下方剪贴基底"));}
    Ok(())
}
