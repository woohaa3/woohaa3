//! 等高线预设的纯数据边界；不打开文档、不合成图像。
use photocraft_doc::{Contour,adjust::CurvePoint};
use serde_json::{Value,json};
use crate::error::{EditorError,Result};

pub const MAX_FILE_BYTES:usize=1_048_576;
pub const MAX_PRESETS:usize=64;
fn error(message:impl std::fmt::Display)->EditorError {
    EditorError::CommandFailed{id:"contour.preset".into(),message:message.to_string()}
}
pub fn builtins()->Value {
    Value::Array(photocraft_engine::layer_style::CONTOURS.iter().filter_map(|(name,_)|
        photocraft_engine::layer_style::builtin_contour(name).map(|contour|json!({"name":name,"contour":contour}))).collect())
}
fn decode(value:Value)->Result<Contour> {
    if !photocraft_project_verify::style_support::supported_items(&json!([{"Satin":{"contour":value}}])) {return Err(error("等高线参数超限或控制点无效"));}
    let contour:Contour=serde_json::from_value(value.clone()).map_err(|_|error("等高线格式无效"))?;
    if !crate::layer_properties_preview::known_keys(&value,&json!(contour)) {return Err(error("等高线包含未知字段"));}
    Ok(contour)
}
pub fn import(bytes:&[u8])->Result<Value> {
    if bytes.len()>MAX_FILE_BYTES {return Err(error("等高线预设文件不能超过 1 MiB"));}
    let count=bytes.get(6..10).and_then(|value|value.try_into().ok()).map(u32::from_be_bytes).unwrap_or(0);
    if count==0 || count as usize>MAX_PRESETS {return Err(error("每个预设文件须含 1–64 条等高线"));}
    let parsed=photocraft_psd::shc::parse(bytes).map_err(|e|error(format!("无法读取 SHC：{e}")))?;
    let mut out=Vec::with_capacity(parsed.len());
    for entry in parsed {
        let contour=Contour::Custom{name:entry.name.clone(),points:entry.points.iter().map(|point|CurvePoint{input:point.input/255.0,output:point.output/255.0}).collect(),corners:entry.points.iter().map(|point|!point.continuous).collect()};
        decode(json!(contour))?;
        out.push(json!({"name":entry.name,"contour":contour}));
    }
    Ok(Value::Array(out))
}
pub fn export(value:Value)->Result<Vec<u8>> {
    let contour=decode(value)?;
    if let Contour::Custom{points,..}=&contour {
        if points.windows(2).any(|pair|(pair[0].input*255.0).round()>=(pair[1].input*255.0).round()) {
            return Err(error("控制点太近，保存为 SHC 后输入会重叠，请拉开控制点"));
        }
    }
    photocraft_engine::layer_style::contour_to_shc(&contour).map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builtin_catalog_and_shc_preserve_data_without_rendering() {
        let catalog=builtins();let presets=catalog.as_array().unwrap();assert_eq!(presets.len(),photocraft_engine::layer_style::CONTOURS.len());
        for entry in presets {decode(entry["contour"].clone()).unwrap();let bytes=export(entry["contour"].clone()).unwrap();assert_eq!(import(&bytes).unwrap().as_array().unwrap().len(),1); }
        let contour=json!({"Custom":{"name":"中文曲线","points":[{"input":0,"output":0},{"input":128.0/255.0,"output":1},{"input":1,"output":0}],"corners":[false,true,false]}});
        let bytes=export(contour.clone()).unwrap();assert_eq!(&bytes[..4],b"8BFS");
        let back=import(&bytes).unwrap();assert_eq!(back[0]["name"],"中文曲线");assert_eq!(back[0]["contour"]["Custom"]["corners"],contour["Custom"]["corners"]);
        let loaded:Contour=serde_json::from_value(back[0]["contour"].clone()).unwrap();let expected:Contour=serde_json::from_value(contour).unwrap();assert_eq!(loaded,expected);
        assert_eq!(import(&export(json!("Linear")).unwrap()).unwrap().as_array().unwrap().len(),1);
    }
    #[test]
    fn rejects_bad_files_limits_unknown_fields_and_lossy_duplicate_inputs() {
        assert!(import(b"bad").is_err());assert!(import(&vec![0;MAX_FILE_BYTES+1]).is_err());
        let mut header=b"8BFS\0\x01".to_vec();header.extend_from_slice(&65u32.to_be_bytes());assert!(import(&header).is_err());
        let bad=json!({"Custom":{"name":"x","points":[{"input":0,"output":0},{"input":0.001,"output":1},{"input":1,"output":0}]}});assert!(export(bad).is_err());
        assert!(export(json!({"Custom":{"name":"x","points":[{"input":0,"output":0},{"input":1,"output":1}],"unknown":true}})).is_err());
        let mut bytes=export(json!("Linear")).unwrap();bytes.truncate(bytes.len()-2);assert!(import(&bytes).is_err());
        let invalid=photocraft_psd::shc::write(&[photocraft_psd::shc::ShcContour{name:"a".repeat(201),points:vec![photocraft_psd::shc::ShcPoint{input:0.0,output:0.0,continuous:true},photocraft_psd::shc::ShcPoint{input:255.0,output:255.0,continuous:true}]}]).unwrap();assert!(import(&invalid).is_err());
    }
}
